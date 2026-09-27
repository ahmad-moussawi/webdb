import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
} from "../../constants.js";
import { OpCode, VmStatus, DataType, ColumnMeta } from "../../types/index.js";
import {
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
} from "./page.c.js";
import { UuidCodec, UlidCodec } from "./codecs.c.js";

import {
  VmCursor,
  VmContext,
  createVmContext,
  resetVmContext,
} from "../../shared/index.js";

export { VmCursor, VmContext, createVmContext, resetVmContext };

const text_decoder = new TextDecoder();

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

  while (ctx.pc < code_len) {
    const op = bytecode[ctx.pc];
    ctx.pc += 1;

    switch (op) {
      /**
       * OP_HALT (0x00)
       * Operands: none (0 bytes)
       * Halts VM execution successfully; sets status to STATUS_DONE.
       Example: Emitted at the end of every compiled bytecode routine.
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
       * Example: OP_OPEN_CURSOR 0, 2 (Binds cursor 0 to table starting at root Page 2)
       *          Bytecode bytes: [0x01, 0x00, 0x02, 0x00, 0x00, 0x00]
       */
      case OpCode.OP_OPEN_CURSOR: {
        const _cursor_idx = bytecode[ctx.pc];
        const root_page_id = code_view.getUint32(ctx.pc + 1, true);
        ctx.pc += 5;

        ctx.cursor.pageId = root_page_id;
        ctx.cursor.cellIdx = 0;
        ctx.cursor.rowOffset = 0;
        break;
      }

      /**
       * OP_REWIND (0x02)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Positions cursor[cursor_idx] at the first cell (index 0) of root page.
       * If the table has 0 rows (cell_count == 0), branches to jump_target (EOF).
       * Example: OP_REWIND 0, 0x0040 (Rewind cursor 0; jump to offset 0x0040 if table empty)
       *          Bytecode bytes: [0x02, 0x00, 0x40, 0x00]
       */
      case OpCode.OP_REWIND: {
        const _cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const page_offset = (ctx.cursor.pageId - 1) * PAGE_SIZE;
        const cell_count = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          ctx.pc = jump_target;
        } else {
          ctx.cursor.cellIdx = 0;
          const rel_cell_offset = page_get_cell_offset(view, page_offset, 0);
          ctx.cursor.rowOffset = page_offset + rel_cell_offset;
        }
        break;
      }

      /**
       * OP_NEXT_ROW (0x03)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Advances cursor[cursor_idx] to the next cell. If all cells on the
       * current page are exhausted, traverses next_page_id to the linked sibling
       * leaf page. Jumps to jump_target when EOF (no more pages) is reached.
       * Example: OP_NEXT_ROW 0, 0x0055 (Advance cursor 0; jump to 0x0055 on EOF)
       *          Bytecode bytes: [0x03, 0x00, 0x55, 0x00]
       */
      case OpCode.OP_NEXT_ROW: {
        const _cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const page_offset = (ctx.cursor.pageId - 1) * PAGE_SIZE;
        const cell_count = page_get_cell_count(view, page_offset);

        ctx.cursor.cellIdx++;

        if (ctx.cursor.cellIdx < cell_count) {
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            ctx.cursor.cellIdx,
          );
          ctx.cursor.rowOffset = page_offset + rel_cell_offset;
        } else {
          // Check if there is a next page linked for this table
          const next_page_id = page_get_next_page_id(view, page_offset);
          if (next_page_id !== 0) {
            ctx.cursor.pageId = next_page_id;
            ctx.cursor.cellIdx = 0;
            const next_offset = (next_page_id - 1) * PAGE_SIZE;
            const next_count = page_get_cell_count(view, next_offset);
            if (next_count > 0) {
              const rel_cell_offset = page_get_cell_offset(
                view,
                next_offset,
                0,
              );
              ctx.cursor.rowOffset = next_offset + rel_cell_offset;
            } else {
              ctx.pc = jump_target; // Empty next page
            }
          } else {
            // EOF reached
            ctx.pc = jump_target;
          }
        }
        break;
      }

      /**
       * OP_COLUMN_INT (0x04)
       * Operands: [col_idx: uint8] [reg_idx: uint8] (2 bytes)
       * Extracts an INT32 or INT64 column value from the current row under cursor.
       * Tests the row's Null-Bitmap: writes null to r[reg_idx] if NULL; otherwise
       * reads 4-byte int32 or 8-byte int64 from the row's fixed data slice.
       * Example: OP_COLUMN_INT 1, 0 (Extract column 1 into register r[0])
       *          Bytecode bytes: [0x04, 0x01, 0x00]
       */
      case OpCode.OP_COLUMN_INT: {
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const col = table.columns[col_idx];
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

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
       * Operands: [col_idx: uint8] [reg_idx: uint8] (2 bytes)
       * Extracts a 64-bit IEEE 754 float column from the row under cursor.
       * Tests Null-Bitmap: writes null to r[reg_idx] if NULL; otherwise
       * reads 8-byte float64 from the row's fixed data slice.
       * Example: OP_COLUMN_FLOAT 2, 1 (Extract column 2 into register r[1])
       *          Bytecode bytes: [0x05, 0x02, 0x01]
       */
      case OpCode.OP_COLUMN_FLOAT: {
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

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
       * Operands: [col_idx: uint8] [reg_idx: uint8] (2 bytes)
       * Extracts a variable-length UTF-8 string (or formatted UUID/ULID string)
       * from the row under cursor into register r[reg_idx]. Reads string offset and
       * length from the row's variable-offset table, or sets r[reg_idx] = null if NULL.
       * Example: OP_COLUMN_TEXT 3, 2 (Extract column 3 into register r[2])
       *          Bytecode bytes: [0x06, 0x03, 0x02]
       */
      case OpCode.OP_COLUMN_TEXT: {
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

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
            ctx.cursor.rowOffset + rel_offset,
            len,
          );
          ctx.registers[reg_idx] = text_decoder.decode(text_bytes);
        }
        break;
      }

      /**
       * OP_COLUMN_BLOB (0x07)
       * Operands: [col_idx: uint8] [reg_idx: uint8] (2 bytes)
       * Extracts a variable-length binary BLOB column from the row under cursor
       * into register r[reg_idx] as a Uint8Array slice. Sets null if marked in Null-Bitmap.
       * Example: OP_COLUMN_BLOB 4, 3 (Extract column 4 into register r[3])
       *          Bytecode bytes: [0x07, 0x04, 0x03]
       */
      case OpCode.OP_COLUMN_BLOB: {
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

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
          new Uint8Array(view.buffer, ctx.cursor.rowOffset + rel_offset, len),
        );
        ctx.registers[reg_idx] = blob_copy;
        break;
      }

      /**
       * OP_IS_NULL (0x10)
       * Operands: [col_idx: uint8] [jump_target: uint16] (3 bytes)
       * Evaluates SQL "col IS NULL". Tests the row's Null-Bitmap at col_idx.
       * If the bit is set (indicating NULL), branches to jump_target.
       * Example: OP_IS_NULL 2, 0x0060 (If column 2 is NULL, jump to offset 0x0060)
       *          Bytecode bytes: [0x10, 0x02, 0x60, 0x00]
       */
      case OpCode.OP_IS_NULL: {
        const col_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const null_bitmap_offset = ctx.cursor.rowOffset + 3;
        const is_null = row_is_null(view, null_bitmap_offset, col_idx);

        if (is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_IS_NOT_NULL (0x11)
       * Operands: [col_idx: uint8] [jump_target: uint16] (3 bytes)
       * Evaluates SQL "col IS NOT NULL". Tests the row's Null-Bitmap at col_idx.
       * If the bit is clear (indicating non-null), branches to jump_target.
       * Example: OP_IS_NOT_NULL 2, 0x0040 (If column 2 is NOT NULL, jump to offset 0x0040)
       *          Bytecode bytes: [0x11, 0x02, 0x40, 0x00]
       */
      case OpCode.OP_IS_NOT_NULL: {
        const col_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const null_bitmap_offset = ctx.cursor.rowOffset + 3;
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
       * Jumps to jump_target only if both registers are non-null and equal.
       * If either register is NULL, 3VL yields UNKNOWN and falls through (no jump).
       * Example: OP_EQ 0, 1, 0x0050 (If r[0] == r[1], jump to 0x0050)
       *          Bytecode bytes: [0x12, 0x00, 0x01, 0x50, 0x00]
       */
      case OpCode.OP_EQ: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];

        if (val_a !== null && val_b !== null && val_a === val_b) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_NE (0x13)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) inequality check: r[reg_a] != r[reg_b].
       * Jumps to jump_target only if both registers are non-null and unequal.
       * If either register is NULL, 3VL yields UNKNOWN and falls through.
       * Example: OP_NE 0, 1, 0x0050 (If r[0] != r[1], jump to 0x0050)
       *          Bytecode bytes: [0x13, 0x00, 0x01, 0x50, 0x00]
       */
      case OpCode.OP_NE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];

        if (val_a !== null && val_b !== null && val_a !== val_b) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_GT (0x14)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) greater-than comparison: r[reg_a] > r[reg_b].
       * Jumps to jump_target only if both are non-null and r[reg_a] > r[reg_b].
       * Falls through on false or NULL (UNKNOWN).
       * Example: OP_GT 2, 3, 0x0070 (If r[2] > r[3], jump to 0x0070)
       *          Bytecode bytes: [0x14, 0x02, 0x03, 0x70, 0x00]
       */
      case OpCode.OP_GT: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];

        if (
          val_a !== null &&
          val_b !== null &&
          (val_a as any) > (val_b as any)
        ) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_GE (0x15)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) greater-than-or-equal comparison: r[reg_a] >= r[reg_b].
       * Jumps to jump_target only if both are non-null and r[reg_a] >= r[reg_b].
       * Example: OP_GE 2, 3, 0x0070 (If r[2] >= r[3], jump to 0x0070)
       *          Bytecode bytes: [0x15, 0x02, 0x03, 0x70, 0x00]
       */
      case OpCode.OP_GE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];

        if (
          val_a !== null &&
          val_b !== null &&
          (val_a as any) >= (val_b as any)
        ) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LT (0x16)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) less-than comparison: r[reg_a] < r[reg_b].
       * Jumps to jump_target only if both are non-null and r[reg_a] < r[reg_b].
       * Example: OP_LT 2, 3, 0x0070 (If r[2] < r[3], jump to 0x0070)
       *          Bytecode bytes: [0x16, 0x02, 0x03, 0x70, 0x00]
       */
      case OpCode.OP_LT: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];

        if (
          val_a !== null &&
          val_b !== null &&
          (val_a as any) < (val_b as any)
        ) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LE (0x17)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) less-than-or-equal comparison: r[reg_a] <= r[reg_b].
       * Jumps to jump_target only if both are non-null and r[reg_a] <= r[reg_b].
       * Example: OP_LE 2, 3, 0x0070 (If r[2] <= r[3], jump to 0x0070)
       *          Bytecode bytes: [0x17, 0x02, 0x03, 0x70, 0x00]
       */
      case OpCode.OP_LE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const val_a = ctx.registers[reg_a];
        const val_b = ctx.registers[reg_b];

        if (
          val_a !== null &&
          val_b !== null &&
          (val_a as any) <= (val_b as any)
        ) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_JUMP (0x18)
       * Operands: [jump_target: uint16] (2 bytes)
       * Unconditional jump. Sets the program counter ctx.pc directly to jump_target.
       Example: OP_JUMP 0x0010 (Jump execution to bytecode offset 0x0010)
      *          Bytecode bytes: [0x18, 0x10, 0x00]
       */
      case OpCode.OP_JUMP: {
        const jump_target = code_view.getUint16(ctx.pc, true);
        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_LOAD_INT (0x20)
       * Operands: [reg_idx: uint8] [val: int32] (5 bytes)
       * Loads a literal signed 32-bit integer constant into register r[reg_idx].
       Example: OP_LOAD_INT 1, 42 (Load integer 42 into register r[1])
      *          Bytecode bytes: [0x20, 0x01, 0x2A, 0x00, 0x00, 0x00]
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
       Example: OP_LOAD_FLOAT 2, 3.14 (Load float 3.14 into register r[2])
      *          Bytecode bytes: [0x21, 0x02, 0x1F, 0x85, 0xEB, 0x51, 0xB8, 0x1E, 0x09, 0x40]
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
       Example: OP_LOAD_TEXT 0, 5, "alice" (Load string "alice" into register r[0])
      *          Bytecode bytes: [0x22, 0x00, 0x05, 0x00, 0x61, 0x6C, 0x69, 0x63, 0x65]
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
       Example: OP_LOAD_NULL 3 (Set register r[3] = NULL)
      *          Bytecode bytes: [0x23, 0x03]
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
       *              If remaining buffer space is insufficient, yields STATUS_BUFFER_FULL.
       * Example: OP_EMIT_ROW 0 (Emit current row under cursor 0 to result buffer)
       *          Bytecode bytes: [0x24, 0x00]
       */
      case OpCode.OP_EMIT_ROW: {
        const _cursor_idx = bytecode[ctx.pc];
        ctx.pc += 1;

        // Read row record length directly from row bytes 1..2
        const total_row_length = view.getUint16(ctx.cursor.rowOffset + 1, true);

        // Check if output buffer has space for 2B length + row record
        const needed = 2 + total_row_length;
        if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
          ctx.status = VmStatus.BUFFER_FULL;
          return VmStatus.BUFFER_FULL;
        }

        const out_target = RESULT_BUFFER_OFFSET + ctx.resultOffset;
        view.setUint16(out_target, total_row_length, true);

        // Copy row bytes into output result buffer
        const src_uint8 = new Uint8Array(
          view.buffer,
          ctx.cursor.rowOffset,
          total_row_length,
        );
        const dest_uint8 = new Uint8Array(
          view.buffer,
          out_target + 2,
          total_row_length,
        );
        dest_uint8.set(src_uint8);

        ctx.resultOffset += needed;
        ctx.resultCount++;
        break;
      }

      default:
        throw new Error(`Unknown bytecode opcode: ${op} at PC=${ctx.pc - 1}`);
    }
  }

  ctx.status = VmStatus.DONE;
  return VmStatus.DONE;
}
