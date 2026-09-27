import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  PAGE_TO_SLOT_OFFSET,
  PAGE_TO_SLOT_SIZE,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  SLOT_TO_PAGE_OFFSET,
} from "../../constants.js";
import { OpCode, VmStatus, DataType, ColumnMeta } from "../../types/index.js";
import {
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
} from "./page.c.js";
import { buf_pool_get_resident_slot } from "./buffer_pool.c.js";
import { UuidCodec, UlidCodec } from "./codecs.c.js";

import {
  type VmCursor,
  type VmContext,
  createVmContext,
  resetVmContext,
} from "../../shared/index.js";

export { createVmContext, resetVmContext };
export type { VmCursor, VmContext };

const text_decoder = new TextDecoder();

/**
 * Returns the active cursor for cursor_idx (0..15), falling back to ctx.cursor.
 */
export function get_cursor(ctx: VmContext, cursor_idx: number): VmCursor {
  if (ctx.cursors && ctx.cursors[cursor_idx]) {
    return ctx.cursors[cursor_idx];
  }
  return ctx.cursor;
}

/**
 * Resolves the byte offset in linear memory for a given page_id.
 * If the buffer pool page-to-slot table is populated, maps via the resident slot.
 * Otherwise falls back to standalone direct calculation: (page_id - 1) * PAGE_SIZE.
 */
export function resolve_page_offset(view: DataView, page_id: number): number {
  if (page_id <= 0) return 0;
  if (view.byteLength >= PAGE_TO_SLOT_OFFSET + PAGE_TO_SLOT_SIZE) {
    const slot = buf_pool_get_resident_slot(
      view,
      PAGE_TO_SLOT_OFFSET,
      DEFAULT_PAGE_TO_SLOT_BUCKETS,
      page_id,
    );
    if (slot >= 0) {
      return slot * PAGE_SIZE;
    }
  }
  return (page_id - 1) * PAGE_SIZE;
}

/**
 * Three-Valued Logic (3VL) comparator for evaluation registers.
 * If either value is null or undefined, returns is_unknown = true.
 */
export function compare_3vl(
  val_a: any,
  val_b: any,
): { result: number; is_unknown: boolean } {
  if (
    val_a === null ||
    val_a === undefined ||
    val_b === null ||
    val_b === undefined
  ) {
    return { result: 0, is_unknown: true };
  }

  if (typeof val_a === "number" && typeof val_b === "number") {
    if (val_a === val_b) return { result: 0, is_unknown: false };
    return { result: val_a > val_b ? 1 : -1, is_unknown: false };
  }

  if (typeof val_a === "bigint" || typeof val_b === "bigint") {
    const a = BigInt(val_a);
    const b = BigInt(val_b);
    if (a === b) return { result: 0, is_unknown: false };
    return { result: a > b ? 1 : -1, is_unknown: false };
  }

  if (typeof val_a === "string" && typeof val_b === "string") {
    if (val_a === val_b) return { result: 0, is_unknown: false };
    return { result: val_a > val_b ? 1 : -1, is_unknown: false };
  }

  if (val_a instanceof Uint8Array && val_b instanceof Uint8Array) {
    const min_len = Math.min(val_a.byteLength, val_b.byteLength);
    for (let i = 0; i < min_len; i++) {
      if (val_a[i] !== val_b[i]) {
        return { result: val_a[i] > val_b[i] ? 1 : -1, is_unknown: false };
      }
    }
    if (val_a.byteLength === val_b.byteLength) {
      return { result: 0, is_unknown: false };
    }
    return {
      result: val_a.byteLength > val_b.byteLength ? 1 : -1,
      is_unknown: false,
    };
  }

  if (val_a === val_b) return { result: 0, is_unknown: false };
  return { result: val_a > val_b ? 1 : -1, is_unknown: false };
}

/**
 * Standard SQL LIKE pattern matcher supporting '%' (any sequence) and '_' (any single character).
 * Case-insensitive for ASCII matching according to SQLite semantics.
 */
export function sql_like_match(str: string, pattern: string): boolean {
  let s = 0;
  let p = 0;
  let star_p = -1;
  let star_s = -1;

  const s_len = str.length;
  const p_len = pattern.length;

  while (s < s_len) {
    if (
      p < p_len &&
      (pattern[p] === '_' ||
        pattern[p].toLowerCase() === str[s].toLowerCase())
    ) {
      s++;
      p++;
    } else if (p < p_len && pattern[p] === '%') {
      star_p = p++;
      star_s = s;
    } else if (star_p !== -1) {
      p = star_p + 1;
      s = ++star_s;
    } else {
      return false;
    }
  }

  while (p < p_len && pattern[p] === '%') {
    p++;
  }

  return p === p_len;
}

/**
 * Tests whether a column in the row is marked NULL in the null-bitmap.
 */
export function row_is_null(
  view: DataView,
  null_bitmap_offset: number,
  col_idx: number,
): boolean {
  return (
    (view.getUint8(null_bitmap_offset + (col_idx >> 3)) &
      (1 << (col_idx & 7))) !==
    0
  );
}

/**
 * Computes the byte offset of a fixed-width column within a row record,
 * or the start of the variable-length offset table if target_col_idx == column_count.
 */
export function compute_fixed_column_offset(
  view: DataView,
  null_bitmap_offset: number,
  null_bitmap_bytes: number,
  columns: ColumnMeta[],
  target_col_idx: number,
): number {
  let col_offset = null_bitmap_offset + null_bitmap_bytes;
  for (let i = 0; i < target_col_idx; i++) {
    if (!row_is_null(view, null_bitmap_offset, i)) {
      const prev_col = columns[i];
      switch (prev_col.type) {
        case DataType.INT32:
          col_offset += 4;
          break;
        case DataType.INT64:
        case DataType.FLOAT64:
          col_offset += 8;
          break;
        case DataType.UUID:
        case DataType.ULID:
          col_offset += 16;
          break;
      }
    }
  }
  return col_offset;
}

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
       * Three-Valued Logic (3VL) inequality check: r[reg_a] != r[reg_b].
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
        const regStr = bytecode[ctx.pc];
        const regPat = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[regStr];
        const val_pat = ctx.registers[regPat];
        if (val_str == null || val_pat == null) {
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
        const regStr = bytecode[ctx.pc];
        const regPat = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[regStr];
        const val_pat = ctx.registers[regPat];
        if (val_str == null || val_pat == null) {
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
        const regStr = bytecode[ctx.pc];
        const regSub = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[regStr];
        const val_sub = ctx.registers[regSub];
        if (val_str == null || val_sub == null) {
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
        const regStr = bytecode[ctx.pc];
        const regPfx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[regStr];
        const val_pfx = ctx.registers[regPfx];
        if (val_str == null || val_pfx == null) {
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
        const regStr = bytecode[ctx.pc];
        const regSfx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[regStr];
        const val_sfx = ctx.registers[regSfx];
        if (val_str == null || val_sfx == null) {
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
        const needed = 2 + total_row_length;

        if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
          ctx.status = VmStatus.BUFFER_FULL;
          ctx.pc = instr_pc; // Rewind PC so this row emits upon resumption
          return VmStatus.BUFFER_FULL;
        }

        const out_target = RESULT_BUFFER_OFFSET + ctx.resultOffset;
        view.setUint16(out_target, total_row_length, true);

        // Copy row bytes into output result buffer
        const src_uint8 = new Uint8Array(
          view.buffer,
          view.byteOffset + cursor.rowOffset,
          total_row_length,
        );
        const dest_uint8 = new Uint8Array(
          view.buffer,
          view.byteOffset + out_target + 2,
          total_row_length,
        );
        dest_uint8.set(src_uint8);

        ctx.resultOffset += needed;
        ctx.resultCount++;
        break;
      }

      /**
       * OP_STR_LOWER (0x29)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Converts string in r[src_reg] to lowercase and stores into r[dest_reg].
       */
      case OpCode.OP_STR_LOWER: {
        const srcReg = bytecode[ctx.pc];
        const destReg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[srcReg];
        ctx.registers[destReg] = val != null ? String(val).toLowerCase() : null;
        break;
      }

      /**
       * OP_STR_UPPER (0x2A)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Converts string in r[src_reg] to uppercase and stores into r[dest_reg].
       */
      case OpCode.OP_STR_UPPER: {
        const srcReg = bytecode[ctx.pc];
        const destReg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[srcReg];
        ctx.registers[destReg] = val != null ? String(val).toUpperCase() : null;
        break;
      }

      /**
       * OP_STR_LENGTH (0x2B)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Computes UTF-8 / character length of string in r[src_reg] and stores into r[dest_reg] (int32).
       */
      case OpCode.OP_STR_LENGTH: {
        const srcReg = bytecode[ctx.pc];
        const destReg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[srcReg];
        ctx.registers[destReg] = val != null ? String(val).length : null;
        break;
      }

      /**
       * OP_STR_SUBSTR (0x2C)
       * Operands: [src_reg: uint8] [start_reg: uint8] [len_reg: uint8] [dest_reg: uint8] (4 bytes)
       * 1-indexed SQL SUBSTR. Extracts substring from r[src_reg] starting at r[start_reg] for r[len_reg] characters.
       */
      case OpCode.OP_STR_SUBSTR: {
        const srcReg = bytecode[ctx.pc];
        const startReg = bytecode[ctx.pc + 1];
        const lenReg = bytecode[ctx.pc + 2];
        const destReg = bytecode[ctx.pc + 3];
        ctx.pc += 4;
        const val = ctx.registers[srcReg];
        const start = ctx.registers[startReg];
        const len = ctx.registers[lenReg];
        if (val == null || start == null) {
          ctx.registers[destReg] = null;
          break;
        }
        const str = String(val);
        const sIdx = Math.max(0, Number(start) - 1);
        if (len == null) {
          ctx.registers[destReg] = str.slice(sIdx);
        } else {
          const l = Math.max(0, Number(len));
          ctx.registers[destReg] = str.slice(sIdx, sIdx + l);
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
