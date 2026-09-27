import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
} from "../../constants.js";
import { OpCode, VmStatus, DataType } from "../../types/index.js";
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
      case OpCode.OP_HALT: {
        ctx.status = VmStatus.DONE;
        return VmStatus.DONE;
      }

      case OpCode.OP_OPEN_CURSOR: {
        // [OP_OPEN_CURSOR] [cursor_idx: uint8] [root_page_id: uint32]
        const _cursor_idx = bytecode[ctx.pc];
        const root_page_id = code_view.getUint32(ctx.pc + 1, true);
        ctx.pc += 5;

        ctx.cursor.pageId = root_page_id;
        ctx.cursor.cellIdx = 0;
        ctx.cursor.rowOffset = 0;
        break;
      }

      case OpCode.OP_REWIND: {
        // [OP_REWIND] [cursor_idx: uint8] [jump_target_pc: uint16]
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

      case OpCode.OP_NEXT_ROW: {
        // [OP_NEXT_ROW] [cursor_idx: uint8] [jump_eof_pc: uint16]
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

      case OpCode.OP_COLUMN_INT: {
        // [OP_COLUMN_INT] [col_idx: uint8] [target_reg: uint8]
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const col = table.columns[col_idx];
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

        const byte_val = view.getUint8(null_bitmap_offset + (col_idx >> 3));
        const is_null = (byte_val & (1 << (col_idx & 7))) !== 0;

        if (is_null) {
          ctx.registers[reg_idx] = null;
        } else {
          let fixed_offset = null_bitmap_offset + null_bitmap_bytes;
          for (let i = 0; i < col_idx; i++) {
            const is_null_prev =
              (view.getUint8(null_bitmap_offset + (i >> 3)) &
                (1 << (i & 7))) !==
              0;
            if (!is_null_prev) {
              const prev_col = table.columns[i];
              switch (prev_col.type) {
                case DataType.INT32:
                  fixed_offset += 4;
                  break;
                case DataType.INT64:
                case DataType.FLOAT64:
                  fixed_offset += 8;
                  break;
                case DataType.UUID:
                case DataType.ULID:
                  fixed_offset += 16;
                  break;
              }
            }
          }

          if (col.type === DataType.INT32) {
            ctx.registers[reg_idx] = view.getInt32(fixed_offset, true);
          } else if (col.type === DataType.INT64) {
            ctx.registers[reg_idx] = Number(
              view.getBigInt64(fixed_offset, true),
            );
          }
        }
        break;
      }

      case OpCode.OP_COLUMN_FLOAT: {
        // [OP_COLUMN_FLOAT] [col_idx: uint8] [target_reg: uint8]
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

        const byte_val = view.getUint8(null_bitmap_offset + (col_idx >> 3));
        const is_null = (byte_val & (1 << (col_idx & 7))) !== 0;

        if (is_null) {
          ctx.registers[reg_idx] = null;
        } else {
          let fixed_offset = null_bitmap_offset + null_bitmap_bytes;
          for (let i = 0; i < col_idx; i++) {
            const is_null_prev =
              (view.getUint8(null_bitmap_offset + (i >> 3)) &
                (1 << (i & 7))) !==
              0;
            if (!is_null_prev) {
              const prev_col = table.columns[i];
              switch (prev_col.type) {
                case DataType.INT32:
                  fixed_offset += 4;
                  break;
                case DataType.INT64:
                case DataType.FLOAT64:
                  fixed_offset += 8;
                  break;
                case DataType.UUID:
                case DataType.ULID:
                  fixed_offset += 16;
                  break;
              }
            }
          }
          ctx.registers[reg_idx] = view.getFloat64(fixed_offset, true);
        }
        break;
      }

      case OpCode.OP_COLUMN_TEXT: {
        // [OP_COLUMN_TEXT] [col_idx: uint8] [target_reg: uint8]
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

        const byte_val = view.getUint8(null_bitmap_offset + (col_idx >> 3));
        const is_null = (byte_val & (1 << (col_idx & 7))) !== 0;

        if (is_null) {
          ctx.registers[reg_idx] = null;
        } else if (
          table.columns[col_idx].type === DataType.UUID ||
          table.columns[col_idx].type === DataType.ULID
        ) {
          let fixed_offset = null_bitmap_offset + null_bitmap_bytes;
          for (let i = 0; i < col_idx; i++) {
            const is_null_prev =
              (view.getUint8(null_bitmap_offset + (i >> 3)) &
                (1 << (i & 7))) !==
              0;
            if (!is_null_prev) {
              const prev_col = table.columns[i];
              switch (prev_col.type) {
                case DataType.INT32:
                  fixed_offset += 4;
                  break;
                case DataType.INT64:
                case DataType.FLOAT64:
                  fixed_offset += 8;
                  break;
                case DataType.UUID:
                case DataType.ULID:
                  fixed_offset += 16;
                  break;
              }
            }
          }
          const slice = new Uint8Array(
            view.buffer,
            view.byteOffset + fixed_offset,
            16,
          );
          ctx.registers[reg_idx] =
            table.columns[col_idx].type === DataType.UUID
              ? UuidCodec.decode(slice, 0)
              : UlidCodec.decode(slice, 0);
        } else {
          // Find start of var-offset table
          let var_table_offset = null_bitmap_offset + null_bitmap_bytes;
          for (let i = 0; i < table.columns.length; i++) {
            const is_null_col =
              (view.getUint8(null_bitmap_offset + (i >> 3)) &
                (1 << (i & 7))) !==
              0;
            if (!is_null_col) {
              const col = table.columns[i];
              switch (col.type) {
                case DataType.INT32:
                  var_table_offset += 4;
                  break;
                case DataType.INT64:
                case DataType.FLOAT64:
                  var_table_offset += 8;
                  break;
                case DataType.UUID:
                case DataType.ULID:
                  var_table_offset += 16;
                  break;
              }
            }
          }

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
        }
        break;
      }

      case OpCode.OP_COLUMN_BLOB: {
        const col_idx = bytecode[ctx.pc];
        const reg_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = ctx.cursor.rowOffset + 3;

        const byte_val = view.getUint8(null_bitmap_offset + (col_idx >> 3));
        const is_null = (byte_val & (1 << (col_idx & 7))) !== 0;

        if (is_null) {
          ctx.registers[reg_idx] = null;
        } else {
          let var_table_offset = null_bitmap_offset + null_bitmap_bytes;
          for (let i = 0; i < table.columns.length; i++) {
            const is_null_col =
              (view.getUint8(null_bitmap_offset + (i >> 3)) &
                (1 << (i & 7))) !==
              0;
            if (!is_null_col) {
              const col = table.columns[i];
              switch (col.type) {
                case DataType.INT32:
                  var_table_offset += 4;
                  break;
                case DataType.INT64:
                case DataType.FLOAT64:
                  var_table_offset += 8;
                  break;
                case DataType.UUID:
                case DataType.ULID:
                  var_table_offset += 16;
                  break;
              }
            }
          }

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
        }
        break;
      }

      case OpCode.OP_IS_NULL: {
        const col_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const null_bitmap_offset = ctx.cursor.rowOffset + 3;
        const byte_val = view.getUint8(null_bitmap_offset + (col_idx >> 3));
        const is_null = (byte_val & (1 << (col_idx & 7))) !== 0;

        if (is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

      case OpCode.OP_IS_NOT_NULL: {
        const col_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const null_bitmap_offset = ctx.cursor.rowOffset + 3;
        const byte_val = view.getUint8(null_bitmap_offset + (col_idx >> 3));
        const is_null = (byte_val & (1 << (col_idx & 7))) !== 0;

        if (!is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

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

      case OpCode.OP_JUMP: {
        const jump_target = code_view.getUint16(ctx.pc, true);
        ctx.pc = jump_target;
        break;
      }

      case OpCode.OP_LOAD_INT: {
        const reg_idx = bytecode[ctx.pc];
        const val = code_view.getInt32(ctx.pc + 1, true);
        ctx.pc += 5;
        ctx.registers[reg_idx] = val;
        break;
      }

      case OpCode.OP_LOAD_FLOAT: {
        const reg_idx = bytecode[ctx.pc];
        const val = code_view.getFloat64(ctx.pc + 1, true);
        ctx.pc += 9;
        ctx.registers[reg_idx] = val;
        break;
      }

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

      case OpCode.OP_LOAD_NULL: {
        const reg_idx = bytecode[ctx.pc];
        ctx.pc += 1;
        ctx.registers[reg_idx] = null;
        break;
      }

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
