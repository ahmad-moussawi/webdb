import {
  PAGE_TO_SLOT_OFFSET,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  SLOT_TO_PAGE_OFFSET,
  MAX_TOPK_HEAP_LIMIT,
} from "../../constants.ts";
import {
  OpCode,
  VmStatus,
  DataType,
} from "../../types/index.ts";
import {
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
} from "./page.c.ts";
import { buf_pool_get_resident_slot } from "./buffer_pool.c.ts";
import { UuidCodec, UlidCodec } from "./codecs.c.ts";

import {
  type VmCursor,
  type VmContext,
  type VmKeyInfo,
  type VmSorter,
  type VmSorterEntry,
  type VmAggBucket,
  createVmContext,
  resetVmContext,
} from "../../shared/index.ts";

import {
  get_cursor,
  resolve_page_offset,
  compare_3vl,
  sql_like_match,
  fnv1a_32,
  group_keys_match,
  create_agg_buckets,
  sort_sorter_entries,
  sorter_insert_row,
  serialize_result_registers,
  emit_to_result_buffer,
  row_is_null,
  compute_fixed_column_offset,
} from "./vm.helpers.c.ts";

// Re-export helpers, context functions, and types for public/core consumers
export * from "./vm.helpers.c.ts";
export { createVmContext, resetVmContext };
export type {
  VmCursor,
  VmContext,
  VmKeyInfo,
  VmSorter,
  VmSorterEntry,
  VmAggBucket,
};

const text_decoder = new TextDecoder();

/**
 * @export_c
 * Synchronous Bytecode VM execution step loop.
 * Runs instructions until STATUS_DONE, STATUS_BUFFER_FULL, or an error.
 */
export function vm_step(
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array,
): VmStatus {
  const code_view = new DataView(
    bytecode.buffer,
    bytecode.byteOffset,
    bytecode.byteLength,
  );
  const code_len = bytecode.byteLength;

  const MAX_CYCLES = 10_000_000;
  let cycles = 0;

  const has_buffer_pool =
    view.byteLength >= SLOT_TO_PAGE_OFFSET + 4 &&
    view.getUint32(SLOT_TO_PAGE_OFFSET, true) > 0;

  while (ctx.pc < code_len) {
    if (++cycles > MAX_CYCLES) {
      ctx.status = VmStatus.TIMEOUT;
      return VmStatus.TIMEOUT;
    }

    const instr_pc = ctx.pc;
    const op = bytecode[ctx.pc];
    ctx.pc += 1;

    switch (op) {
      /**
       * OP_HALT (0x00)
       * Operands: none (0 bytes)
       * Halts VM execution successfully; sets status to STATUS_DONE.
       */
      case OpCode.OP_HALT: {
        ctx.arenaOffset = 0;
        ctx.status = VmStatus.DONE;
        return VmStatus.DONE;
      }

      /**
       * OP_OPEN_CURSOR (0x01)
       * Operands: [cursor_idx: uint8] [root_page_id: uint32] (5 bytes)
       * Binds cursor[cursor_idx] to a table or index root page ID.
       * Resets the cursor's cellIdx and rowOffset to 0.
       */
      case OpCode.OP_OPEN_CURSOR: {
        const cursor_idx = bytecode[ctx.pc];
        const root_page_id = code_view.getUint32(ctx.pc + 1, true);
        ctx.pc += 5;

        const cursor = get_cursor(ctx, cursor_idx);
        cursor.pageId = root_page_id;
        cursor.cellIdx = 0;
        cursor.rowOffset = 0;

        if (has_buffer_pool && root_page_id > 0) {
          const slot = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            root_page_id,
          );
          if (slot < 0) {
            ctx.fault_page_id = root_page_id;
            ctx.status = VmStatus.PAGE_FAULT;
            ctx.pc = instr_pc;
            return VmStatus.PAGE_FAULT;
          }
          cursor.slotIdx = slot;
        }
        break;
      }

      /**
       * OP_REWIND (0x02)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Positions cursor[cursor_idx] at the first cell (index 0) of root page.
       * If the table has 0 rows (cell_count == 0), branches to jump_target (EOF).
       */
      case OpCode.OP_REWIND: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);

        if (has_buffer_pool && cursor.pageId > 0) {
          const slot = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            cursor.pageId,
          );
          if (slot < 0) {
            ctx.fault_page_id = cursor.pageId;
            ctx.status = VmStatus.PAGE_FAULT;
            ctx.pc = instr_pc;
            return VmStatus.PAGE_FAULT;
          }
          cursor.slotIdx = slot;
        }

        const page_offset = resolve_page_offset(view, cursor.pageId);
        const cell_count = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          ctx.pc = jump_target;
        } else {
          cursor.cellIdx = 0;
          const rel_cell_offset = page_get_cell_offset(view, page_offset, 0);
          cursor.rowOffset = page_offset + rel_cell_offset;
        }
        break;
      }

      /**
       * OP_NEXT_ROW (0x03)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Advances cursor[cursor_idx] to the next cell. If all cells on the
       * current page are exhausted, traverses next_page_id to the linked sibling
       * leaf page. Jumps to jump_target when EOF (no more pages) is reached.
       */
      case OpCode.OP_NEXT_ROW: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const page_offset = resolve_page_offset(view, cursor.pageId);
        const cell_count = page_get_cell_count(view, page_offset);

        const next_cell_idx = cursor.cellIdx + 1;
        if (next_cell_idx < cell_count) {
          cursor.cellIdx = next_cell_idx;
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            cursor.cellIdx,
          );
          cursor.rowOffset = page_offset + rel_cell_offset;
        } else {
          // Check if there is a next page linked for this table
          const next_page_id = page_get_next_page_id(view, page_offset);
          if (next_page_id !== 0) {
            if (has_buffer_pool) {
              const slot = buf_pool_get_resident_slot(
                view,
                PAGE_TO_SLOT_OFFSET,
                DEFAULT_PAGE_TO_SLOT_BUCKETS,
                next_page_id,
              );
              if (slot < 0) {
                // Page miss: leave cursor on current page and cell, rewind PC to re-evaluate after load
                ctx.fault_page_id = next_page_id;
                ctx.status = VmStatus.PAGE_FAULT;
                ctx.pc = instr_pc;
                return VmStatus.PAGE_FAULT;
              }
              cursor.slotIdx = slot;
            }

            cursor.pageId = next_page_id;
            cursor.cellIdx = 0;
            const next_offset = resolve_page_offset(view, next_page_id);
            const next_count = page_get_cell_count(view, next_offset);
            if (next_count > 0) {
              const rel_cell_offset = page_get_cell_offset(
                view,
                next_offset,
                0,
              );
              cursor.rowOffset = next_offset + rel_cell_offset;
            } else {
              ctx.pc = jump_target;
            }
          } else {
            // EOF reached
            ctx.pc = jump_target;
          }
        }
        break;
      }

      /**
       * OP_LAST (0x08)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Positions cursor at rightmost leaf cell for reverse scan.
       */
      case OpCode.OP_LAST: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const page_offset = resolve_page_offset(view, cursor.pageId);
        const cell_count = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          ctx.pc = jump_target;
        } else {
          cursor.cellIdx = cell_count - 1;
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            cursor.cellIdx,
          );
          cursor.rowOffset = page_offset + rel_cell_offset;
        }
        break;
      }

      /**
       * OP_PREV_ROW (0x09)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Decrements cell index; jumps on beginning of table (BOF).
       */
      case OpCode.OP_PREV_ROW: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const page_offset = resolve_page_offset(view, cursor.pageId);

        if (cursor.cellIdx > 0) {
          cursor.cellIdx--;
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            cursor.cellIdx,
          );
          cursor.rowOffset = page_offset + rel_cell_offset;
        } else {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_COLUMN_INT (0x04)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts an INT32 or INT64 column value from the current row under cursor.
       */
      case OpCode.OP_COLUMN_INT: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const col = table.columns[col_idx];
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        const col_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          col_idx,
        );

        if (col.type === DataType.INT32) {
          ctx.registers[reg_idx] = view.getInt32(col_offset, true);
        } else if (col.type === DataType.INT64) {
          ctx.registers[reg_idx] = Number(view.getBigInt64(col_offset, true));
        }
        break;
      }

      /**
       * OP_COLUMN_FLOAT (0x05)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts a 64-bit IEEE 754 float column from the row under cursor.
       */
      case OpCode.OP_COLUMN_FLOAT: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        const col_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          col_idx,
        );

        ctx.registers[reg_idx] = view.getFloat64(col_offset, true);
        break;
      }

      /**
       * OP_COLUMN_TEXT (0x06)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts a variable-length UTF-8 string (or formatted UUID/ULID string)
       * from the row under cursor into register r[reg_idx].
       */
      case OpCode.OP_COLUMN_UUID:
      case OpCode.OP_COLUMN_ULID:
      case OpCode.OP_COLUMN_TEXT: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        if (
          table.columns[col_idx].type === DataType.UUID ||
          table.columns[col_idx].type === DataType.ULID
        ) {
          const col_offset = compute_fixed_column_offset(
            view,
            null_bitmap_offset,
            null_bitmap_bytes,
            table.columns,
            col_idx,
          );

          const slice = new Uint8Array(
            view.buffer,
            view.byteOffset + col_offset,
            16,
          );

          ctx.registers[reg_idx] =
            table.columns[col_idx].type === DataType.UUID
              ? UuidCodec.decode(slice, 0)
              : UlidCodec.decode(slice, 0);
          break;
        }

        // Find start of var-offset table
        const var_table_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          table.columns.length,
        );

        let var_idx = 0;
        for (let i = 0; i < col_idx; i++) {
          const c = table.columns[i];
          if (c.type === DataType.TEXT || c.type === DataType.BLOB) {
            var_idx++;
          }
        }

        const entry_offset = var_table_offset + var_idx * 4;
        const rel_offset = view.getUint16(entry_offset, true);
        const len = view.getUint16(entry_offset + 2, true);

        if (len === 0) {
          ctx.registers[reg_idx] = "";
        } else {
          const text_bytes = new Uint8Array(
            view.buffer,
            cursor.rowOffset + rel_offset,
            len,
          );
          ctx.registers[reg_idx] = text_decoder.decode(text_bytes);
        }
        break;
      }

      /**
       * OP_COLUMN_BLOB (0x07)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts a variable-length binary BLOB column from the row under cursor.
       */
      case OpCode.OP_COLUMN_BLOB: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        const var_table_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          table.columns.length,
        );

        let var_idx = 0;
        for (let i = 0; i < col_idx; i++) {
          const c = table.columns[i];
          if (c.type === DataType.TEXT || c.type === DataType.BLOB) {
            var_idx++;
          }
        }

        const entry_offset = var_table_offset + var_idx * 4;
        const rel_offset = view.getUint16(entry_offset, true);
        const len = view.getUint16(entry_offset + 2, true);

        const blob_copy = new Uint8Array(len);
        blob_copy.set(
          new Uint8Array(view.buffer, cursor.rowOffset + rel_offset, len),
        );
        ctx.registers[reg_idx] = blob_copy;
        break;
      }

      /**
       * OP_IS_NULL (0x10)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [jump_target: uint16] (4 bytes)
       * Evaluates SQL "col IS NULL". Tests the row's Null-Bitmap at col_idx.
       */
      case OpCode.OP_IS_NULL: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const null_bitmap_offset = cursor.rowOffset + 3;
        const is_null = row_is_null(view, null_bitmap_offset, col_idx);

        if (is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_IS_NOT_NULL (0x11)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [jump_target: uint16] (4 bytes)
       * Evaluates SQL "col IS NOT NULL". Tests the row's Null-Bitmap at col_idx.
       */
      case OpCode.OP_IS_NOT_NULL: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const null_bitmap_offset = cursor.rowOffset + 3;
        const is_null = row_is_null(view, null_bitmap_offset, col_idx);

        if (!is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_EQ (0x12)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) equality check: r[reg_a] == r[reg_b].
       */
      case OpCode.OP_EQ: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result === 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_NE (0x13)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) inequality check: r[reg_a] !== r[reg_b].
       */
      case OpCode.OP_NE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result !== 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_GT (0x14)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) greater-than comparison: r[reg_a] > r[reg_b].
       */
      case OpCode.OP_GT: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result > 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_GE (0x15)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) greater-than-or-equal comparison: r[reg_a] >= r[reg_b].
       */
      case OpCode.OP_GE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result >= 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LT (0x16)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) less-than comparison: r[reg_a] < r[reg_b].
       */
      case OpCode.OP_LT: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result < 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LE (0x17)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) less-than-or-equal comparison: r[reg_a] <= r[reg_b].
       */
      case OpCode.OP_LE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result <= 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_JUMP (0x18)
       * Operands: [jump_target: uint16] (2 bytes)
       * Unconditional jump. Sets the program counter ctx.pc directly to jump_target.
       */
      case OpCode.OP_JUMP: {
        const jump_target = code_view.getUint16(ctx.pc, true);
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_STR_LIKE (0x19)
       * Operands: [reg_str: uint8] [reg_pat: uint8] [jump_target: uint16] (4 bytes)
       * 3VL SQL LIKE: jumps to jump_target if r[reg_str] matches r[reg_pat].
       */
      case OpCode.OP_STR_LIKE: {
        const reg_str = bytecode[ctx.pc];
        const reg_pat = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_pat = ctx.registers[reg_pat];
        if (val_str === null || val_pat === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (sql_like_match(String(val_str), String(val_pat))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_NOT_LIKE (0x1A)
       * Operands: [reg_str: uint8] [reg_pat: uint8] [jump_target: uint16] (4 bytes)
       * 3VL SQL NOT LIKE: jumps to jump_target if r[reg_str] does NOT match r[reg_pat].
       */
      case OpCode.OP_STR_NOT_LIKE: {
        const reg_str = bytecode[ctx.pc];
        const reg_pat = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_pat = ctx.registers[reg_pat];
        if (val_str === null || val_pat === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (!sql_like_match(String(val_str), String(val_pat))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_CONTAINS (0x1B)
       * Operands: [reg_str: uint8] [reg_sub: uint8] [jump_target: uint16] (4 bytes)
       * 3VL Substring search: jumps to jump_target if r[reg_str] contains r[reg_sub].
       */
      case OpCode.OP_STR_CONTAINS: {
        const reg_str = bytecode[ctx.pc];
        const reg_sub = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_sub = ctx.registers[reg_sub];
        if (val_str === null || val_sub === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (String(val_str).includes(String(val_sub))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_STARTS_WITH (0x1C)
       * Operands: [reg_str: uint8] [reg_pfx: uint8] [jump_target: uint16] (4 bytes)
       * 3VL Prefix check: jumps to jump_target if r[reg_str] starts with r[reg_pfx].
       */
      case OpCode.OP_STR_STARTS_WITH: {
        const reg_str = bytecode[ctx.pc];
        const reg_pfx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_pfx = ctx.registers[reg_pfx];
        if (val_str === null || val_pfx === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (String(val_str).startsWith(String(val_pfx))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_ENDS_WITH (0x1D)
       * Operands: [reg_str: uint8] [reg_sfx: uint8] [jump_target: uint16] (4 bytes)
       * 3VL Suffix check: jumps to jump_target if r[reg_str] ends with r[reg_sfx].
       */
      case OpCode.OP_STR_ENDS_WITH: {
        const reg_str = bytecode[ctx.pc];
        const reg_sfx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_sfx = ctx.registers[reg_sfx];
        if (val_str === null || val_sfx === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (String(val_str).endsWith(String(val_sfx))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LOAD_INT (0x20)
       * Operands: [reg_idx: uint8] [val: int32] (5 bytes)
       * Loads a literal signed 32-bit integer constant into register r[reg_idx].
       */
      case OpCode.OP_LOAD_INT: {
        const reg_idx = bytecode[ctx.pc];
        const val = code_view.getInt32(ctx.pc + 1, true);
        ctx.pc += 5;
        ctx.registers[reg_idx] = val;
        break;
      }

      /**
       * OP_LOAD_FLOAT (0x21)
       * Operands: [reg_idx: uint8] [val: float64] (9 bytes)
       * Loads a literal 64-bit IEEE 754 float constant into register r[reg_idx].
       */
      case OpCode.OP_LOAD_FLOAT: {
        const reg_idx = bytecode[ctx.pc];
        const val = code_view.getFloat64(ctx.pc + 1, true);
        ctx.pc += 9;
        ctx.registers[reg_idx] = val;
        break;
      }

      /**
       * OP_LOAD_TEXT (0x22)
       * Operands: [reg_idx: uint8] [len: uint16] [utf8_bytes: len bytes]
       * Loads a literal UTF-8 string of length len into register r[reg_idx].
       */
      case OpCode.OP_LOAD_TEXT: {
        const reg_idx = bytecode[ctx.pc];
        const len = code_view.getUint16(ctx.pc + 1, true);
        const text_bytes = new Uint8Array(
          bytecode.buffer,
          bytecode.byteOffset + ctx.pc + 3,
          len,
        );
        ctx.registers[reg_idx] = text_decoder.decode(text_bytes);
        ctx.pc += 3 + len;
        break;
      }

      /**
       * OP_LOAD_NULL (0x23)
       * Operands: [reg_idx: uint8] (1 byte)
       * Sets register r[reg_idx] to null (type = 0).
       */
      case OpCode.OP_LOAD_NULL: {
        const reg_idx = bytecode[ctx.pc];
        ctx.pc += 1;
        ctx.registers[reg_idx] = null;
        break;
      }

      /**
       * OP_EMIT_ROW (0x24)
       * Operands: [cursor_idx: uint8] (1 byte)
       * Streams the current serialized row focused under cursor[cursor_idx]
       * into the 64KB Output Result Buffer at RESULT_BUFFER_OFFSET + resultOffset.
       * Prepends a 2-byte record length: [uint16 len] [row_bytes].
       * If remaining buffer space is insufficient, yields STATUS_BUFFER_FULL.
       */
      case OpCode.OP_EMIT_ROW: {
        const cursor_idx = bytecode[ctx.pc];
        ctx.pc += 1;

        const cursor = get_cursor(ctx, cursor_idx);
        const total_row_length = view.getUint16(cursor.rowOffset + 1, true);
        const row_bytes = new Uint8Array(
          view.buffer,
          view.byteOffset + cursor.rowOffset,
          total_row_length,
        );

        const emit_status = emit_to_result_buffer(
          ctx,
          view,
          row_bytes,
          instr_pc,
        );
        if (emit_status !== VmStatus.RUNNING) {
          return emit_status;
        }
        break;
      }

      /**
       * OP_OFFSET (0x26)
       * Operands: [offset_reg: uint8] [jump_target: uint16] (3 bytes)
       * If r[offset_reg] > 0, decrements r[offset_reg] and branches to jump_target (skipping row emission).
       */
      case OpCode.OP_OFFSET: {
        const offset_reg = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const offset_val = Number(ctx.registers[offset_reg] ?? 0);
        if (offset_val > 0) {
          ctx.registers[offset_reg] = offset_val - 1;
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LIMIT (0x27)
       * Operands: [limit_reg: uint8] [jump_target: uint16] (3 bytes)
       * If r[limit_reg] <= 1, sets r[limit_reg] to 0 and branches to jump_target (early HALT).
       * Otherwise decrements r[limit_reg] and falls through.
       */
      case OpCode.OP_LIMIT: {
        const limit_reg = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const limit_val = Number(ctx.registers[limit_reg] ?? 0);
        if (limit_val <= 1) {
          ctx.registers[limit_reg] = 0;
          ctx.pc = jump_target;
        } else {
          ctx.registers[limit_reg] = limit_val - 1;
        }
        break;
      }

      /**
       * OP_STR_LOWER (0x29)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Converts string in r[src_reg] to lowercase and stores into r[dest_reg].
       */
      case OpCode.OP_STR_LOWER: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null ? String(val).toLowerCase() : null;
        break;
      }

      /**
       * OP_STR_UPPER (0x2A)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Converts string in r[src_reg] to uppercase and stores into r[dest_reg].
       */
      case OpCode.OP_STR_UPPER: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null ? String(val).toUpperCase() : null;
        break;
      }

      /**
       * OP_STR_LENGTH (0x2B)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Computes UTF-8 / character length of string in r[src_reg] and stores into r[dest_reg] (int32).
       */
      case OpCode.OP_STR_LENGTH: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] = val !== null ? String(val).length : null;
        break;
      }

      /**
       * OP_STR_SUBSTR (0x2C)
       * Operands: [src_reg: uint8] [start_reg: uint8] [len_reg: uint8] [dest_reg: uint8] (4 bytes)
       * 1-indexed SQL SUBSTR. Extracts substring from r[src_reg] starting at r[start_reg] for r[len_reg] characters.
       */
      case OpCode.OP_STR_SUBSTR: {
        const src_reg = bytecode[ctx.pc];
        const start_reg = bytecode[ctx.pc + 1];
        const len_reg = bytecode[ctx.pc + 2];
        const dest_reg = bytecode[ctx.pc + 3];
        ctx.pc += 4;
        const val = ctx.registers[src_reg];
        const start = ctx.registers[start_reg];
        const len = ctx.registers[len_reg];
        if (val === null || start === null) {
          ctx.registers[dest_reg] = null;
          break;
        }
        const str = String(val);
        const s_idx = Math.max(0, Number(start) - 1);
        if (len === null) {
          ctx.registers[dest_reg] = str.slice(s_idx);
        } else {
          const l = Math.max(0, Number(len));
          ctx.registers[dest_reg] = str.slice(s_idx, s_idx + l);
        }
        break;
      }

      /**
       * OP_STR_TRIM (0x2D)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Strips leading and trailing whitespace from string in r[src_reg] into r[dest_reg].
       */
      case OpCode.OP_STR_TRIM: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null && val !== undefined ? String(val).trim() : null;
        break;
      }

      /**
       * OP_MATH_ABS (0x2E)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Computes absolute numeric value |r[src_reg]| into r[dest_reg].
       */
      case OpCode.OP_MATH_ABS: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null && val !== undefined ? Math.abs(Number(val)) : null;
        break;
      }

      /**
       * OP_MATH_ROUND (0x2F)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Rounds float in r[src_reg] to nearest integer into r[dest_reg].
       */
      case OpCode.OP_MATH_ROUND: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null && val !== undefined ? Math.round(Number(val)) : null;
        break;
      }

      /**
       * OP_RESULT_ROW (0x25)
       * Operands: [start_reg: uint8] [num_cols: uint8] (2 bytes)
       * Serializes num_cols registers (start_reg .. start_reg + num_cols - 1)
       * into a binary row in the 64KB Result Buffer.
       * If remaining space is insufficient, yields STATUS_BUFFER_FULL.
       */
      case OpCode.OP_RESULT_ROW: {
        const start_reg = bytecode[ctx.pc];
        const num_cols = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const serialized = serialize_result_registers(ctx, start_reg, num_cols);
        const emit_status = emit_to_result_buffer(
          ctx,
          view,
          serialized,
          instr_pc,
        );
        if (emit_status !== VmStatus.RUNNING) {
          return emit_status;
        }
        break;
      }

      /**
       * OP_SORTER_OPEN (0x30)
       * Operands: [sorter_id: uint8] [key_info_idx: uint8] (2 bytes)
       * Initializes sorter in Transient Query Arena with KeyInfo descriptor.
       */
      case OpCode.OP_SORTER_OPEN: {
        const sorter_id = bytecode[ctx.pc];
        const key_info_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const key_info = ctx.keyInfos[key_info_idx] ?? {
          numKeys: 1,
          directions: [0],
          nullOrders: [0],
        };

        ctx.sorters[sorter_id] = {
          keyInfo: key_info,
          entries: [],
          readIdx: 0,
          isSorted: false,
        };
        break;
      }

      /**
       * OP_SORTER_INSERT (0x31)
       * Operands: [sorter_id: uint8] [start_reg: uint8] [num_keys: uint8] [cursor_idx: uint8] (4 bytes)
       * Packs extracted key registers and row reference into SorterEntry inside the Transient Query Arena.
       * If arena allocation exceeds maxQueryMemory, yields STATUS_ERR_ARENA_EXHAUSTED.
       */
      case OpCode.OP_SORTER_INSERT: {
        const sorter_id = bytecode[ctx.pc];
        const start_reg = bytecode[ctx.pc + 1];
        const num_keys = bytecode[ctx.pc + 2];
        const cursor_idx = bytecode[ctx.pc + 3];
        ctx.pc += 4;

        const sorter = ctx.sorters[sorter_id];
        if (!sorter) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const row_len = view.getUint16(cursor.rowOffset + 1, true);

        const keys: any[] = [];
        for (let k = 0; k < num_keys; k++) {
          keys.push(ctx.registers[start_reg + k]);
        }

        const requested_k =
          sorter.keyInfo.limit !== undefined && sorter.keyInfo.limit > 0
            ? (sorter.keyInfo.offset ?? 0) + sorter.keyInfo.limit
            : 0;
        const max_k =
          requested_k > 0 && requested_k <= MAX_TOPK_HEAP_LIMIT
            ? requested_k
            : 0;

        const insert_status = sorter_insert_row(
          ctx,
          sorter,
          keys,
          cursor.rowOffset,
          row_len,
          view,
          max_k,
        );
        if (insert_status !== VmStatus.RUNNING) {
          return insert_status;
        }
        break;
      }

      /**
       * OP_SORTER_SORT (0x32)
       * Operands: [sorter_id: uint8] (1 byte)
       * Executes in-place Introsort on SorterEntry[] using multi-column collation.
       */
      case OpCode.OP_SORTER_SORT: {
        const sorter_id = bytecode[ctx.pc];
        ctx.pc += 1;

        const sorter = ctx.sorters[sorter_id];
        if (!sorter) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        sort_sorter_entries(sorter);
        sorter.isSorted = true;
        break;
      }

      /**
       * OP_SORTER_NEXT (0x33)
       * Operands: [sorter_id: uint8] [jump_target: uint16] (3 bytes)
       * Yields next sorted row into 64KB Result Buffer; jumps to jump_target until all entries emitted.
       * If Result Buffer is full, yields STATUS_BUFFER_FULL. Falls through on EOF.
       */
      case OpCode.OP_SORTER_NEXT: {
        const sorter_id = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const sorter = ctx.sorters[sorter_id];
        if (!sorter) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const max_read =
          sorter.keyInfo.limit !== undefined
            ? (sorter.keyInfo.offset ?? 0) + sorter.keyInfo.limit
            : sorter.entries.length;

        if (sorter.readIdx >= Math.min(sorter.entries.length, max_read)) {
          // EOF: all requested sorted entries emitted, fall through
          break;
        }

        const entry = sorter.entries[sorter.readIdx];
        const row_bytes =
          entry.rowData ??
          new Uint8Array(
            view.buffer,
            view.byteOffset + entry.rowOffset,
            entry.rowLen,
          );

        const emit_status = emit_to_result_buffer(
          ctx,
          view,
          row_bytes,
          instr_pc,
        );
        if (emit_status !== VmStatus.RUNNING) {
          return emit_status;
        }

        sorter.readIdx++;
        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_MATH_FLOOR (0x34)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Computes mathematical floor ⌊r[src_reg]⌋ into r[dest_reg].
       */
      case OpCode.OP_MATH_FLOOR: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null && val !== undefined ? Math.floor(Number(val)) : null;
        break;
      }

      /**
       * OP_MATH_CEIL (0x35)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Computes mathematical ceiling ⌈r[src_reg]⌉ into r[dest_reg].
       */
      case OpCode.OP_MATH_CEIL: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null && val !== undefined ? Math.ceil(Number(val)) : null;
        break;
      }

      /**
       * OP_ADD (0x36)
       * Operands: [regA: uint8] [regB: uint8] [dest_reg: uint8] (3 bytes)
       * 3VL addition: r[dest_reg] = r[regA] + r[regB].
       */
      case OpCode.OP_ADD: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];
        if (
          val_a === null ||
          val_a === undefined ||
          val_b === null ||
          val_b === undefined
        ) {
          ctx.registers[dest_reg] = null;
        } else {
          ctx.registers[dest_reg] = Number(val_a) + Number(val_b);
        }
        break;
      }

      /**
       * OP_SUB (0x37)
       * Operands: [regA: uint8] [regB: uint8] [dest_reg: uint8] (3 bytes)
       * 3VL subtraction: r[dest_reg] = r[regA] - r[regB].
       */
      case OpCode.OP_SUB: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];
        if (
          val_a === null ||
          val_a === undefined ||
          val_b === null ||
          val_b === undefined
        ) {
          ctx.registers[dest_reg] = null;
        } else {
          ctx.registers[dest_reg] = Number(val_a) - Number(val_b);
        }
        break;
      }

      /**
       * OP_MUL (0x38)
       * Operands: [regA: uint8] [regB: uint8] [dest_reg: uint8] (3 bytes)
       * 3VL multiplication: r[dest_reg] = r[regA] * r[regB].
       */
      case OpCode.OP_MUL: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];
        if (
          val_a === null ||
          val_a === undefined ||
          val_b === null ||
          val_b === undefined
        ) {
          ctx.registers[dest_reg] = null;
        } else {
          ctx.registers[dest_reg] = Number(val_a) * Number(val_b);
        }
        break;
      }

      /**
       * OP_DIV (0x39)
       * Operands: [regA: uint8] [regB: uint8] [dest_reg: uint8] (3 bytes)
       * 3VL division: r[dest_reg] = r[regA] / r[regB] (null on divide by zero).
       */
      case OpCode.OP_DIV: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];
        if (
          val_a === null ||
          val_a === undefined ||
          val_b === null ||
          val_b === undefined
        ) {
          ctx.registers[dest_reg] = null;
        } else {
          const denom = Number(val_b);
          ctx.registers[dest_reg] = denom === 0 ? null : Number(val_a) / denom;
        }
        break;
      }

      /**
       * OP_MOD (0x3A)
       * Operands: [regA: uint8] [regB: uint8] [dest_reg: uint8] (3 bytes)
       * 3VL modulo: r[dest_reg] = r[regA] % r[regB] (null on divide by zero).
       */
      case OpCode.OP_MOD: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];
        if (
          val_a === null ||
          val_a === undefined ||
          val_b === null ||
          val_b === undefined
        ) {
          ctx.registers[dest_reg] = null;
        } else {
          const denom = Number(val_b);
          ctx.registers[dest_reg] = denom === 0 ? null : Number(val_a) % denom;
        }
        break;
      }

      /**
       * OP_STR_CONCAT (0x3D)
       * Operands: [start_reg: uint8] [num_regs: uint8] [dest_reg: uint8] (3 bytes)
       * Concatenates registers r[start_reg ... start_reg + num_regs - 1] into r[dest_reg].
       */
      case OpCode.OP_STR_CONCAT: {
        const start_reg = bytecode[ctx.pc];
        const num_regs = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        let res = '';
        let has_val = false;
        for (let i = 0; i < num_regs; i++) {
          const v = ctx.registers[start_reg + i];
          if (v !== null && v !== undefined) {
            has_val = true;
            res += String(v);
          }
        }
        ctx.registers[dest_reg] = has_val ? res : null;
        break;
      }

      /**
       * OP_COALESCE (0x3E)
       * Operands: [start_reg: uint8] [num_regs: uint8] [dest_reg: uint8] (3 bytes)
       * Scans registers r[start_reg ... start_reg + num_regs - 1], stores first non-null into r[dest_reg].
       */
      case OpCode.OP_COALESCE: {
        const start_reg = bytecode[ctx.pc];
        const num_regs = bytecode[ctx.pc + 1];
        const dest_reg = bytecode[ctx.pc + 2];
        ctx.pc += 3;
        let first_non_null: any = null;
        for (let i = 0; i < num_regs; i++) {
          const v = ctx.registers[start_reg + i];
          if (v !== null && v !== undefined) {
            first_non_null = v;
            break;
          }
        }
        ctx.registers[dest_reg] = first_non_null;
        break;
      }

      /**
       * OP_AGG_INIT (0x40)
       * Operands: [agg_id: uint8] [start_key_reg: uint8] [num_keys: uint8] [mode: uint8] (4 bytes)
       * Initializes Hash Table in arena (0x00) or Stream Aggregation (0x01).
       */
      case OpCode.OP_AGG_INIT: {
        const agg_id = bytecode[ctx.pc];
        const start_key_reg = bytecode[ctx.pc + 1];
        const num_keys = bytecode[ctx.pc + 2];
        const mode = bytecode[ctx.pc + 3];
        ctx.pc += 4;

        if (mode === 0) {
          const initial_capacity = 1024;
          const alloc_size = initial_capacity * 40; // 40.96 KB
          if (ctx.arenaOffset + alloc_size > ctx.maxQueryMemory) {
            ctx.status = VmStatus.ARENA_EXHAUSTED;
            return VmStatus.ARENA_EXHAUSTED;
          }
          ctx.arenaOffset += alloc_size;

          const buckets: VmAggBucket[] = create_agg_buckets(initial_capacity);

          if (num_keys === 0) {
            const h = fnv1a_32([]);
            const slot = h % initial_capacity;
            buckets[slot].hash = h;
            buckets[slot].keys = [];
            buckets[slot].count = 0;
            buckets[slot].sum = 0;
            buckets[slot].min_val = Infinity;
            buckets[slot].max_val = -Infinity;
            buckets[slot].has_val = false;
          }

          ctx.aggregators[agg_id] = {
            mode: 0,
            startKeyReg: start_key_reg,
            numKeys: num_keys,
            capacity: initial_capacity,
            occupiedCount: num_keys === 0 ? 1 : 0,
            readIdx: 0,
            buckets,
          };
        } else {
          ctx.aggregators[agg_id] = {
            mode: 1,
            startKeyReg: start_key_reg,
            numKeys: num_keys,
            capacity: 1,
            occupiedCount: 0,
            readIdx: 0,
            buckets: [],
          };
        }
        break;
      }

      /**
       * OP_AGG_STEP (0x41)
       * Operands: [agg_id: uint8] [start_key_reg: uint8] [num_keys: uint8] [val_reg: uint8] [func_id: uint8] (5 bytes)
       * Updates AggBucket accumulators (0: COUNT, 1: SUM, 2: AVG, 3: MIN, 4: MAX).
       */
      case OpCode.OP_AGG_STEP: {
        const agg_id = bytecode[ctx.pc];
        const start_key_reg = bytecode[ctx.pc + 1];
        const num_keys = bytecode[ctx.pc + 2];
        const val_reg = bytecode[ctx.pc + 3];
        const func_id = bytecode[ctx.pc + 4];
        ctx.pc += 5;

        const agg = ctx.aggregators[agg_id];
        if (!agg) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const keys: any[] = [];
        for (let k = 0; k < num_keys; k++) {
          keys.push(ctx.registers[start_key_reg + k]);
        }
        const val = val_reg === 255 ? null : ctx.registers[val_reg];

        if (agg.mode === 0) {
          const hash = fnv1a_32(keys);
          const slot = hash % agg.capacity;
          let target_bucket: VmAggBucket | null = null;

          for (let probe = 0; probe < agg.capacity; probe++) {
            const idx = (slot + probe) % agg.capacity;
            const b = agg.buckets[idx];
            if (b.hash === 0) {
              b.hash = hash;
              b.keys = keys.slice();
              b.count = 0;
              b.sum = 0;
              b.min_val = Infinity;
              b.max_val = -Infinity;
              b.has_val = false;
              agg.occupiedCount++;
              target_bucket = b;
              break;
            } else if (b.hash === hash && group_keys_match(b.keys, keys)) {
              target_bucket = b;
              break;
            }
          }

          if (!target_bucket) {
            ctx.status = VmStatus.ARENA_EXHAUSTED;
            return VmStatus.ARENA_EXHAUSTED;
          }

          // Accumulator updates
          if (func_id === 0) {
            if (val_reg === 255 || (val !== null && val !== undefined)) {
              target_bucket.count++;
            }
          } else if (func_id === 1 || func_id === 2) {
            if (val !== null && val !== undefined) {
              target_bucket.sum += Number(val);
              target_bucket.has_val = true;
            }
          } else if (func_id === 3) {
            if (val !== null && val !== undefined) {
              const num = Number(val);
              if (!target_bucket.has_val || num < target_bucket.min_val) {
                target_bucket.min_val = num;
              }
              target_bucket.has_val = true;
            }
          } else if (func_id === 4) {
            if (val !== null && val !== undefined) {
              const num = Number(val);
              if (!target_bucket.has_val || num > target_bucket.max_val) {
                target_bucket.max_val = num;
              }
              target_bucket.has_val = true;
            }
          }

          // Dynamic Doubling at 70% Load Factor
          if (agg.occupiedCount > 0.7 * agg.capacity) {
            const old_capacity = agg.capacity;
            const new_capacity = old_capacity * 2;
            const add_size = new_capacity * 40;
            if (ctx.arenaOffset + add_size > ctx.maxQueryMemory) {
              ctx.status = VmStatus.ARENA_EXHAUSTED;
              return VmStatus.ARENA_EXHAUSTED;
            }
            ctx.arenaOffset += add_size;

            const old_buckets = agg.buckets;
            const new_buckets: VmAggBucket[] = create_agg_buckets(new_capacity);

            for (let b_idx = 0; b_idx < old_buckets.length; b_idx++) {
              const old_b = old_buckets[b_idx];
              if (old_b.hash !== 0) {
                const s = old_b.hash % new_capacity;
                for (let p = 0; p < new_capacity; p++) {
                  const pos = (s + p) % new_capacity;
                  if (new_buckets[pos].hash === 0) {
                    new_buckets[pos] = old_b;
                    break;
                  }
                }
              }
            }

            agg.capacity = new_capacity;
            agg.buckets = new_buckets;
          }
        }
        break;
      }

      /**
       * OP_AGG_NEXT (0x42)
       * Operands: [agg_id: uint8] [out_key_reg: uint8] [out_acc_reg: uint8] [jump_target: uint16] (5 bytes)
       * Iterates next group bucket into registers; jumps to jump_target. Falls through on EOF.
       */
      case OpCode.OP_AGG_NEXT: {
        const agg_id = bytecode[ctx.pc];
        const out_key_reg = bytecode[ctx.pc + 1];
        const out_acc_reg = bytecode[ctx.pc + 2];
        const jump_target = code_view.getUint16(ctx.pc + 3, true);
        ctx.pc += 5;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const agg = ctx.aggregators[agg_id];
        if (!agg) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        while (
          agg.readIdx < agg.buckets.length &&
          agg.buckets[agg.readIdx].hash === 0
        ) {
          agg.readIdx++;
        }

        if (agg.readIdx >= agg.buckets.length) {
          // All buckets processed, fall through
          break;
        }

        const bucket = agg.buckets[agg.readIdx++];

        for (let k = 0; k < bucket.keys.length; k++) {
          ctx.registers[out_key_reg + k] = bucket.keys[k];
        }

        ctx.registers[out_acc_reg] = bucket.sum;
        ctx.registers[out_acc_reg + 1] = bucket.count;
        ctx.registers[out_acc_reg + 2] = bucket.has_val ? bucket.min_val : null;
        ctx.registers[out_acc_reg + 3] = bucket.has_val ? bucket.max_val : null;

        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_AGG_FINAL (0x43)
       * Operands: [sum_reg: uint8] [count_reg: uint8] [out_reg: uint8] [func_id: uint8] (4 bytes)
       * Finalizes aggregate expression: (0: COUNT, 1: SUM, 2: AVG, 3: MIN, 4: MAX).
       */
      case OpCode.OP_AGG_FINAL: {
        const sum_reg = bytecode[ctx.pc];
        const count_reg = bytecode[ctx.pc + 1];
        const out_reg = bytecode[ctx.pc + 2];
        const func_id = bytecode[ctx.pc + 3];
        ctx.pc += 4;

        const sum = ctx.registers[sum_reg];
        const count = Number(ctx.registers[count_reg] ?? 0);

        if (func_id === 0) {
          ctx.registers[out_reg] = count;
        } else if (func_id === 1) {
          ctx.registers[out_reg] = count > 0 ? Number(sum) : null;
        } else if (func_id === 2) {
          ctx.registers[out_reg] = count > 0 ? Number(sum) / count : null;
        } else if (func_id === 3 || func_id === 4) {
          ctx.registers[out_reg] = ctx.registers[sum_reg];
        }
        break;
      }

      default:
        ctx.status = VmStatus.INVALID_BYTECODE;
        return VmStatus.INVALID_BYTECODE;
    }
  }

  ctx.status = VmStatus.DONE;
  return VmStatus.DONE;
}
