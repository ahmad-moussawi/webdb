/**
 * @c_include "vm_helpers.h"
 * @c_include "page.h"
 */

import {
  PAGE_TYPE_LEAF_DATA,
  MAX_ROW_SIZE,
  OVERFLOW_LEN_FLAG,
  OVERFLOW_DESCRIPTOR_SIZE,
} from "../../constants.ts";
import { OpCode, VmStatus, DataType } from "../../types/index.ts";
import { u8, u16, u32, i32, i64, f64 } from "../types.ts";
import {
  page_get_type,
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
} from "./page.c.ts";
import {
  read_u8,
  read_u16,
  read_u32,
  write_u32,
  read_i32,
  write_i32,
  read_i64,
  read_f64,
} from "../../shared/c_runtime.ts";

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
  VM_CTX_PC,
  VM_CTX_ARENA_OFFSET,
  VM_CTX_HAS_BUFFER_POOL,
  VM_CTX_UDF_ID,
  VM_CTX_UDF_START_REG,
  VM_CTX_UDF_NUM_ARGS,
  VM_CTX_UDF_DEST_REG,
  VM_REG_IS_NULL,
  VM_REG_TYPE,
  VM_REG_I32,
  VM_REG_I64,
  VM_REG_F64,
  VM_REG_DATA_OFF,
  VM_REG_DATA_LEN,
  VM_CUR_PAGE_ID,
  VM_CUR_ROOT_PAGE_ID,
  VM_CUR_SLOT_IDX,
  VM_CUR_CELL_IDX,
  VM_CUR_ROW_OFFSET,
  VM_CTX_PAGE_TO_SLOT_OFF,
  VM_CTX_PAGE_TO_SLOT_BUCKETS,
  VM_STATUS_HOST_UDF,
  vm_reg_off,
  vm_cursor_off,
  vm_set_status,
  vm_ensure_resident,
  vm_position_data_cursor,
  vm_resolve_table_off,
  vm_phys_alloc,
  vm_reg_set_null,
  vm_reg_set_i32,
  vm_reg_set_i64,
  vm_reg_set_f64,
  vm_reg_set_slice,
  vm_reg_copy,
  vm_uuid_decode_view,
  vm_ulid_decode_view,
  vm_resolve_page_offset,
  vm_row_is_null,
  vm_compute_fixed_col_offset,
  vm_compute_var_col_idx,
  vm_compare_reg_3vl,
  vm_index_seek_leaf,
  sql_like_match_view,
  vm_str_contains_view,
  vm_str_starts_with_view,
  vm_str_ends_with_view,
  vm_str_fuzzy_match_view,
  vm_str_levenshtein_view,
  vm_utf8_char_count,
  vm_str_case,
  vm_str_trim,
  vm_utf8_substr,
  vm_str_concat,
  vm_math_abs,
  vm_math_floor,
  vm_math_ceil,
  vm_math_round,
  vm_in_set_contains,
  vm_emit_raw_row,
  vm_serialize_and_emit_result_row,
  vm_sorter_open_raw,
  vm_sorter_insert_raw,
  vm_sorter_sort_raw,
  vm_sorter_next_raw,
  vm_agg_init_raw,
  vm_agg_step_raw,
  vm_agg_next_raw,
  vm_agg_final_raw,
  vm_load_overflow_column,
} from "./vm.helpers.c.ts";

// Re-export helpers, host runner, context functions, and types for public/core consumers
export * from "./vm.helpers.c.ts";
export { executeVmStepWithRunner } from "./vm_host.ts";
import { executeVmStepWithRunner } from "./vm_host.ts";
export { createVmContext, resetVmContext };
export type {
  VmCursor,
  VmContext,
  VmKeyInfo,
  VmSorter,
  VmSorterEntry,
  VmAggBucket,
};

// ============================================================================
// 1. Zero-Allocation Flat Linear-Memory Bytecode VM (@export_c)
// ============================================================================

/**
 * @export_c
 * Synchronous Bytecode VM execution step loop over flat linear memory.
 * Zero dynamic allocations and zero object property accesses; transpiles 1:1 to C.
 *
 * Guide to Low-Level Memory Primitives (`read_*` / `write_*`) vs Pure JS Equivalents:
 * -----------------------------------------------------------------------------------
 * 1. Bytecode Operands (at `code_off + pc`):
 *    - `read_u8(view, code_off + pc)`       <-> `bytecode[pc]`
 *    - `read_u16(view, code_off + pc)`      <-> `bytecodeView.getUint16(pc, true)`
 *    - `read_i32(view, code_off + pc)`      <-> `bytecodeView.getInt32(pc, true)`
 *    - `read_u32(view, code_off + pc)`      <-> `bytecodeView.getUint32(pc, true)`
 *    - `read_f64(view, code_off + pc)`      <-> `bytecodeView.getFloat64(pc, true)`
 *
 * 2. VmContext Scalar State (at `ctx_off = VM_CONTEXT_OFFSET`):
 *    - `read_u32(view, ctx_off + VM_CTX_PC)`                   <-> `ctx.pc`
 *    - `write_u32(view, ctx_off + VM_CTX_PC, pc)`              <-> `ctx.pc = pc`
 *    - `write_i32(view, ctx_off + VM_CTX_STATUS, s)`           <-> `ctx.status = s`
 *    - `write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, pid)`  <-> `ctx.fault_page_id = pid`
 *    - `write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, off)`   <-> `ctx.arenaOffset = off`
 *
 * 3. Cursor State (`cur_off = vm_cursor_off(ctx_off, cursor_idx)`):
 *    - `read_u32(view, cur_off + VM_CUR_PAGE_ID)`              <-> `ctx.cursors[cursor_idx].pageId`
 *    - `write_u32(view, cur_off + VM_CUR_PAGE_ID, pid)`        <-> `ctx.cursors[cursor_idx].pageId = pid`
 *    - `write_u32(view, cur_off + VM_CUR_ROOT_PAGE_ID, pid)`   <-> `ctx.cursors[cursor_idx].rootPageId = pid`
 *    - `write_i32(view, cur_off + VM_CUR_SLOT_IDX, slot)`      <-> `ctx.cursors[cursor_idx].slotIdx = slot`
 *    - `read_i32(view, cur_off + VM_CUR_CELL_IDX)`             <-> `ctx.cursors[cursor_idx].cellIdx`
 *    - `write_i32(view, cur_off + VM_CUR_CELL_IDX, idx)`       <-> `ctx.cursors[cursor_idx].cellIdx = idx`
 *    - `read_u32(view, cur_off + VM_CUR_ROW_OFFSET)`           <-> `ctx.cursors[cursor_idx].rowOffset`
 *    - `write_u32(view, cur_off + VM_CUR_ROW_OFFSET, off)`     <-> `ctx.cursors[cursor_idx].rowOffset = off`
 *
 * 4. Register State (`reg_off = vm_reg_off(ctx_off, reg_idx)`):
 *    - `vm_reg_set_null(view, reg_off)`                        <-> `ctx.registers[reg_idx] = null`
 *    - `vm_reg_set_i32(view, reg_off, val)`                    <-> `ctx.registers[reg_idx] = val`
 *    - `vm_reg_set_i64(view, reg_off, val)`                    <-> `ctx.registers[reg_idx] = val`
 *    - `vm_reg_set_f64(view, reg_off, val)`                    <-> `ctx.registers[reg_idx] = val`
 *    - `vm_reg_set_slice(view, reg_off, type, off, len)`       <-> `ctx.registers[reg_idx] = slice(off, off + len)`
 *    - `read_u8(view, reg_off + VM_REG_IS_NULL) !== 0`         <-> `ctx.registers[reg_idx] === null`
 *    - `read_f64(view, reg_off + VM_REG_F64)`                  <-> `Number(ctx.registers[reg_idx])`
 */
export function vm_step_raw(
  view: DataView,
  ctx_off: u32,
  code_off: u32,
  code_len: u32,
  arena_base: u32,
): i32 {
  const MAX_CYCLES: u32 = 10000000;
  let cycles: u32 = 0;

  // JS: const hasBufferPool = ctx.hasBufferPool;
  // JS: let pc = ctx.pc;
  const has_buffer_pool: u32 = read_u32(view, ctx_off + VM_CTX_HAS_BUFFER_POOL);
  const page_to_slot_off: u32 = read_u32(view, ctx_off + VM_CTX_PAGE_TO_SLOT_OFF);
  const page_to_slot_buckets: u32 = read_u32(view, ctx_off + VM_CTX_PAGE_TO_SLOT_BUCKETS);
  let pc: u32 = read_u32(view, ctx_off + VM_CTX_PC);

  while (pc < code_len) {
    cycles++;
    if (cycles > MAX_CYCLES) {
      return vm_set_status(view, ctx_off, pc, VmStatus.TIMEOUT);
    }

    const instr_pc: u32 = pc;
    const op: u8 = read_u8(view, code_off + pc);
    pc += 1;

    switch (op) {
      case OpCode.OP_HALT: {
        write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, 0);
        return vm_set_status(view, ctx_off, pc, VmStatus.DONE);
      }

      case OpCode.OP_OPEN_CURSOR:
      case OpCode.OP_OPEN_INDEX: {
        if (pc + 5 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        if (cursor_idx >= 16) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const root_page_id: u32 = read_u32(view, code_off + pc + 1);
        pc += 5;

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        write_u32(view, cur_off + VM_CUR_PAGE_ID, root_page_id);
        if (op === OpCode.OP_OPEN_INDEX) {
          write_u32(view, cur_off + VM_CUR_ROOT_PAGE_ID, root_page_id);
        }
        write_i32(view, cur_off + VM_CUR_CELL_IDX, 0);
        write_u32(view, cur_off + VM_CUR_ROW_OFFSET, 0);

        if (
          vm_ensure_resident(
            view,
            ctx_off,
            has_buffer_pool,
            page_to_slot_off,
            page_to_slot_buckets,
            cur_off,
            root_page_id,
            instr_pc,
          ) !== VmStatus.RUNNING
        ) {
          return VmStatus.PAGE_FAULT;
        }
        break;
      }

      case OpCode.OP_REWIND: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (cursor_idx >= 16 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        if (
          vm_ensure_resident(
            view,
            ctx_off,
            has_buffer_pool,
            page_to_slot_off,
            page_to_slot_buckets,
            cur_off,
            page_id,
            instr_pc,
          ) !== VmStatus.RUNNING
        ) {
          return VmStatus.PAGE_FAULT;
        }

        const page_offset: u32 = vm_resolve_page_offset(
          view,
          ctx_off,
          has_buffer_pool,
          page_id,
        );
        if (page_get_type(view, page_offset) !== PAGE_TYPE_LEAF_DATA) {
          pc = jump_target;
          break;
        }
        const cell_count: u16 = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          // The first page can be empty (e.g. every row was deleted) while later pages of the
          // chain hold rows: keep walking the chain instead of treating it as an empty table.
          const chain_next: u32 = page_get_next_page_id(view, page_offset);
          if (chain_next !== 0 && chain_next !== page_id) {
            write_u32(view, cur_off + VM_CUR_PAGE_ID, chain_next);
            pc = instr_pc;
          } else {
            pc = jump_target;
          }
        } else {
          write_i32(view, cur_off + VM_CUR_CELL_IDX, 0);
          const rel_cell_offset: u16 = page_get_cell_offset(view, page_offset, 0);
          write_u32(
            view,
            cur_off + VM_CUR_ROW_OFFSET,
            page_offset + rel_cell_offset,
          );
        }
        break;
      }

      case OpCode.OP_NEXT_ROW: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (cursor_idx >= 16 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        const page_offset: u32 = vm_resolve_page_offset(
          view,
          ctx_off,
          has_buffer_pool,
          page_id,
        );
        if (page_get_type(view, page_offset) !== PAGE_TYPE_LEAF_DATA) {
          pc = jump_target;
          break;
        }
        const cell_count: i32 = page_get_cell_count(view, page_offset);

        const next_cell_idx: i32 = read_i32(view, cur_off + VM_CUR_CELL_IDX) + 1;
        if (next_cell_idx < cell_count) {
          write_i32(view, cur_off + VM_CUR_CELL_IDX, next_cell_idx);
          const rel_cell_offset: u16 = page_get_cell_offset(
            view,
            page_offset,
            next_cell_idx as u16,
          );
          write_u32(
            view,
            cur_off + VM_CUR_ROW_OFFSET,
            page_offset + rel_cell_offset,
          );
        } else {
          // Follow leaf page chain (`next_page_id`) when current page is exhausted
          const next_page_id: u32 = page_get_next_page_id(view, page_offset);
          if (next_page_id !== 0 && next_page_id !== page_id) {
            if (
              vm_ensure_resident(
                view,
                ctx_off,
                has_buffer_pool,
                page_to_slot_off,
                page_to_slot_buckets,
                cur_off,
                next_page_id,
                instr_pc,
              ) !== VmStatus.RUNNING
            ) {
              return VmStatus.PAGE_FAULT;
            }

            const next_offset: u32 = vm_resolve_page_offset(
              view,
              ctx_off,
              has_buffer_pool,
              next_page_id,
            );
            if (page_get_type(view, next_offset) !== PAGE_TYPE_LEAF_DATA) {
              pc = jump_target;
              break;
            }

            write_u32(view, cur_off + VM_CUR_PAGE_ID, next_page_id);
            write_i32(view, cur_off + VM_CUR_CELL_IDX, 0);
            const next_count: u16 = page_get_cell_count(view, next_offset);
            if (next_count > 0) {
              const rel_cell_offset: u16 = page_get_cell_offset(
                view,
                next_offset,
                0,
              );
              write_u32(
                view,
                cur_off + VM_CUR_ROW_OFFSET,
                next_offset + rel_cell_offset,
              );
            } else {
              write_i32(view, cur_off + VM_CUR_CELL_IDX, -1);
              pc = instr_pc;
            }
          } else {
            pc = jump_target;
          }
        }
        break;
      }

      case OpCode.OP_LAST: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (cursor_idx >= 16 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        const page_offset: u32 = vm_resolve_page_offset(
          view,
          ctx_off,
          has_buffer_pool,
          page_id,
        );
        if (page_get_type(view, page_offset) !== PAGE_TYPE_LEAF_DATA) {
          pc = jump_target;
          break;
        }
        const cell_count: i32 = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          pc = jump_target;
        } else {
          const last_idx: i32 = cell_count - 1;
          write_i32(view, cur_off + VM_CUR_CELL_IDX, last_idx);
          const rel_cell_offset: u16 = page_get_cell_offset(
            view,
            page_offset,
            last_idx as u16,
          );
          write_u32(
            view,
            cur_off + VM_CUR_ROW_OFFSET,
            page_offset + rel_cell_offset,
          );
        }
        break;
      }

      case OpCode.OP_PREV_ROW: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (cursor_idx >= 16 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        const page_offset: u32 = vm_resolve_page_offset(
          view,
          ctx_off,
          has_buffer_pool,
          page_id,
        );
        const cell_idx: i32 = read_i32(view, cur_off + VM_CUR_CELL_IDX);

        if (cell_idx > 0) {
          const prev_idx: i32 = cell_idx - 1;
          write_i32(view, cur_off + VM_CUR_CELL_IDX, prev_idx);
          const rel_cell_offset: u16 = page_get_cell_offset(
            view,
            page_offset,
            prev_idx as u16,
          );
          write_u32(
            view,
            cur_off + VM_CUR_ROW_OFFSET,
            page_offset + rel_cell_offset,
          );
        } else {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_COLUMN_INT:
      case OpCode.OP_COLUMN_FLOAT: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_idx: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        if (cursor_idx >= 16 || reg_idx >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
        const tbl_off: u32 = vm_resolve_table_off(view, ctx_off, cursor_idx);
        const null_bitmap_bytes: u32 = read_u16(view, tbl_off + 2);
        const null_bitmap_offset: u32 = row_offset + 3;
        const reg_off: u32 = vm_reg_off(ctx_off, reg_idx);

        if (vm_row_is_null(view, null_bitmap_offset, col_idx) !== 0) {
          vm_reg_set_null(view, reg_off);
          break;
        }

        const col_offset: u32 = vm_compute_fixed_col_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          tbl_off,
          col_idx,
        );
        if (op === OpCode.OP_COLUMN_FLOAT) {
          vm_reg_set_f64(view, reg_off, read_f64(view, col_offset));
        } else {
          const col_type: u8 = read_u8(view, tbl_off + 4 + col_idx);
          if (col_type === DataType.INT32) {
            vm_reg_set_i32(view, reg_off, read_i32(view, col_offset));
          } else if (col_type === DataType.INT64) {
            vm_reg_set_i64(view, reg_off, read_i64(view, col_offset));
          }
        }
        break;
      }

      case OpCode.OP_COLUMN_UUID:
      case OpCode.OP_COLUMN_ULID:
      case OpCode.OP_COLUMN_TEXT:
      case OpCode.OP_COLUMN_BLOB: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_idx: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        if (cursor_idx >= 16 || reg_idx >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
        const tbl_off: u32 = vm_resolve_table_off(view, ctx_off, cursor_idx);
        const num_cols: u32 = read_u16(view, tbl_off + 0);
        const null_bitmap_bytes: u32 = read_u16(view, tbl_off + 2);
        const null_bitmap_offset: u32 = row_offset + 3;
        const reg_off: u32 = vm_reg_off(ctx_off, reg_idx);

        if (vm_row_is_null(view, null_bitmap_offset, col_idx) !== 0) {
          vm_reg_set_null(view, reg_off);
          break;
        }

        if (op !== OpCode.OP_COLUMN_BLOB) {
          const col_type: u8 = read_u8(view, tbl_off + 4 + col_idx);
          if (col_type === DataType.UUID || col_type === DataType.ULID) {
            const col_offset: u32 = vm_compute_fixed_col_offset(
              view,
              null_bitmap_offset,
              null_bitmap_bytes,
              tbl_off,
              col_idx,
            );
            const out_len: u32 = col_type === DataType.UUID ? 36 : 26;
            const out_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, out_len);
            if (out_off === 0) {
              return vm_set_status(view, ctx_off, pc, VmStatus.ARENA_EXHAUSTED);
            }
            if (col_type === DataType.UUID) {
              vm_uuid_decode_view(view, col_offset, out_off);
            } else {
              vm_ulid_decode_view(view, col_offset, out_off);
            }
            vm_reg_set_slice(view, reg_off, col_type, out_off, out_len);
            break;
          }
        }

        const target_type: u8 =
          op === OpCode.OP_COLUMN_BLOB ? DataType.BLOB : DataType.TEXT;
        const row_len: u16 = read_u16(view, row_offset + 1);
        const var_table_offset: u32 = vm_compute_fixed_col_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          tbl_off,
          num_cols,
        );
        const var_idx: u32 = vm_compute_var_col_idx(view, tbl_off, col_idx);
        const entry_offset: u32 = var_table_offset + (var_idx << 2);
        if (
          row_len > MAX_ROW_SIZE ||
          entry_offset + 4 > row_offset + row_len
        ) {
          vm_reg_set_null(view, reg_off);
          break;
        }
        const rel_offset: u16 = read_u16(view, entry_offset);
        const len: u16 = read_u16(view, entry_offset + 2);
        if ((len & OVERFLOW_LEN_FLAG) !== 0) {
          if (
            rel_offset + OVERFLOW_DESCRIPTOR_SIZE > row_len ||
            row_offset + rel_offset < entry_offset + 4
          ) {
            vm_reg_set_null(view, reg_off);
            break;
          }
          const first_pid: u32 = read_u32(view, row_offset + rel_offset);
          const total_len: u32 = read_u32(view, row_offset + rel_offset + 4);
          const ov_status: i32 = vm_load_overflow_column(
            view,
            ctx_off,
            reg_off,
            target_type,
            first_pid,
            total_len,
            instr_pc,
          );
          if (ov_status !== VmStatus.RUNNING) {
            return ov_status;
          }
          break;
        }
        if (
          rel_offset + len > row_len ||
          (len > 0 && row_offset + rel_offset < entry_offset + 4)
        ) {
          vm_reg_set_null(view, reg_off);
          break;
        }

        vm_reg_set_slice(
          view,
          reg_off,
          target_type,
          row_offset + rel_offset,
          len,
        );
        break;
      }

      case OpCode.OP_INDEX_SEEK_EQ:
      case OpCode.OP_INDEX_SEEK_GE: {
        if (pc + 6 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const index_cursor_idx: u32 = read_u8(view, code_off + pc);
        const data_cursor_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_key: u32 = read_u8(view, code_off + pc + 2);
        const key_type: u8 = read_u8(view, code_off + pc + 3);
        const jump_miss: u32 = read_u16(view, code_off + pc + 4);
        pc += 6;

        if (
          index_cursor_idx >= 16 ||
          data_cursor_idx >= 16 ||
          reg_key >= 64 ||
          jump_miss > code_len
        ) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const key_reg_off: u32 = vm_reg_off(ctx_off, reg_key);
        if (read_u8(view, key_reg_off + VM_REG_IS_NULL) !== 0) {
          pc = jump_miss;
          break;
        }

        const idx_cur_off: u32 = vm_cursor_off(ctx_off, index_cursor_idx);
        const root_pid: u32 = read_u32(view, idx_cur_off + VM_CUR_ROOT_PAGE_ID);
        let curr_page_id: u32 =
          root_pid !== 0
            ? root_pid
            : read_u32(view, idx_cur_off + VM_CUR_PAGE_ID);
        let found: i32 = 0;
        let matched_rowid: i64 = 0n;
        let hops: u32 = 0;

        while (curr_page_id !== 0) {
          hops++;
          if (hops > 100000) {
            return vm_set_status(view, ctx_off, instr_pc, VmStatus.ERROR);
          }
          if (
            vm_ensure_resident(
              view,
              ctx_off,
              has_buffer_pool,
              page_to_slot_off,
              page_to_slot_buckets,
              idx_cur_off,
              curr_page_id,
              instr_pc,
            ) !== VmStatus.RUNNING
          ) {
            return VmStatus.PAGE_FAULT;
          }

          const page_offset: u32 = vm_resolve_page_offset(
            view,
            ctx_off,
            has_buffer_pool,
            curr_page_id,
          );
          const matched_slot: i32 = vm_index_seek_leaf(
            view,
            ctx_off,
            page_offset,
            key_type,
            key_reg_off,
            op === OpCode.OP_INDEX_SEEK_EQ ? 1 : 0,
          );

          if (matched_slot >= 0) {
            found = 1;
            write_u32(view, idx_cur_off + VM_CUR_PAGE_ID, curr_page_id);
            write_i32(view, idx_cur_off + VM_CUR_CELL_IDX, matched_slot);
            const cell_offset: u16 = page_get_cell_offset(
              view,
              page_offset,
              matched_slot as u16,
            );
            const k_len: u16 = read_u16(view, page_offset + cell_offset);
            matched_rowid = read_i64(
              view,
              page_offset + cell_offset + 2 + k_len,
            );
            break;
          }

          curr_page_id = page_get_next_page_id(view, page_offset);
        }

        if (found === 0) {
          pc = jump_miss;
        } else if (
          vm_position_data_cursor(
            view,
            ctx_off,
            has_buffer_pool,
            page_to_slot_off,
            page_to_slot_buckets,
            data_cursor_idx,
            matched_rowid,
            instr_pc,
          ) !== VmStatus.RUNNING
        ) {
          return VmStatus.PAGE_FAULT;
        }
        break;
      }

      case OpCode.OP_INDEX_NEXT: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const index_cursor_idx: u32 = read_u8(view, code_off + pc);
        const data_cursor_idx: u32 = read_u8(view, code_off + pc + 1);
        const jump_eof: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (
          index_cursor_idx >= 16 ||
          data_cursor_idx >= 16 ||
          jump_eof > code_len
        ) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const idx_cur_off: u32 = vm_cursor_off(ctx_off, index_cursor_idx);
        let curr_page_id: u32 = read_u32(view, idx_cur_off + VM_CUR_PAGE_ID);
        let page_offset: u32 = vm_resolve_page_offset(
          view,
          ctx_off,
          has_buffer_pool,
          curr_page_id,
        );
        const cell_count: i32 = page_get_cell_count(view, page_offset);

        let next_cell_idx: i32 =
          read_i32(view, idx_cur_off + VM_CUR_CELL_IDX) + 1;
        if (next_cell_idx >= cell_count) {
          curr_page_id = page_get_next_page_id(view, page_offset);
          if (curr_page_id === 0) {
            pc = jump_eof;
            break;
          }
          if (
            vm_ensure_resident(
              view,
              ctx_off,
              has_buffer_pool,
              page_to_slot_off,
              page_to_slot_buckets,
              idx_cur_off,
              curr_page_id,
              instr_pc,
            ) !== VmStatus.RUNNING
          ) {
            return VmStatus.PAGE_FAULT;
          }
          page_offset = vm_resolve_page_offset(
            view,
            ctx_off,
            has_buffer_pool,
            curr_page_id,
          );
          next_cell_idx = 0;
          write_u32(view, idx_cur_off + VM_CUR_PAGE_ID, curr_page_id);
          write_i32(view, idx_cur_off + VM_CUR_CELL_IDX, -1);
        }

        const cell_offset: u16 = page_get_cell_offset(
          view,
          page_offset,
          next_cell_idx as u16,
        );
        const k_len: u16 = read_u16(view, page_offset + cell_offset);
        const matched_rowid: i64 = read_i64(
          view,
          page_offset + cell_offset + 2 + k_len,
        );

        if (
          vm_position_data_cursor(
            view,
            ctx_off,
            has_buffer_pool,
            page_to_slot_off,
            page_to_slot_buckets,
            data_cursor_idx,
            matched_rowid,
            instr_pc,
          ) !== VmStatus.RUNNING
        ) {
          return VmStatus.PAGE_FAULT;
        }

        write_u32(view, idx_cur_off + VM_CUR_PAGE_ID, curr_page_id);
        write_i32(view, idx_cur_off + VM_CUR_CELL_IDX, next_cell_idx);
        break;
      }

      case OpCode.OP_IS_NULL:
      case OpCode.OP_IS_NOT_NULL: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (cursor_idx >= 16 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
        const is_null: i32 = vm_row_is_null(view, row_offset + 3, col_idx);
        if (
          (op === OpCode.OP_IS_NULL && is_null !== 0) ||
          (op === OpCode.OP_IS_NOT_NULL && is_null === 0)
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_EQ:
      case OpCode.OP_NE:
      case OpCode.OP_GT:
      case OpCode.OP_GE:
      case OpCode.OP_LT:
      case OpCode.OP_LE: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (reg_a >= 64 || reg_b >= 64 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        let jump: i32 = 0;
        if (op === OpCode.OP_EQ) {
          if (cmp === 0) jump = 1;
        } else if (op === OpCode.OP_NE) {
          if (cmp !== -2 && cmp !== 0) jump = 1;
        } else if (op === OpCode.OP_GT) {
          if (cmp === 1) jump = 1;
        } else if (op === OpCode.OP_GE) {
          if (cmp === 0 || cmp === 1) jump = 1;
        } else if (op === OpCode.OP_LT) {
          if (cmp === -1) jump = 1;
        } else if (cmp === -1 || cmp === 0) {
          jump = 1;
        }
        if (jump !== 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_JUMP: {
        if (pc + 2 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const jump_target: u32 = read_u16(view, code_off + pc);
        if (jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }
        pc = jump_target;
        break;
      }

      case OpCode.OP_STR_LIKE:
      case OpCode.OP_STR_NOT_LIKE:
      case OpCode.OP_STR_CONTAINS:
      case OpCode.OP_STR_STARTS_WITH:
      case OpCode.OP_STR_ENDS_WITH:
      case OpCode.OP_STR_FUZZY_MATCH: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_str: u32 = read_u8(view, code_off + pc);
        const reg_pat: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (reg_str >= 64 || reg_pat >= 64 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }
        const s_off: u32 = vm_reg_off(ctx_off, reg_str);
        const p_off: u32 = vm_reg_off(ctx_off, reg_pat);
        if (
          read_u8(view, s_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, p_off + VM_REG_IS_NULL) !== 0
        ) {
          break;
        }
        const s_data: u32 = read_u32(view, s_off + VM_REG_DATA_OFF);
        const s_len: u32 = read_u32(view, s_off + VM_REG_DATA_LEN);
        const p_data: u32 = read_u32(view, p_off + VM_REG_DATA_OFF);
        const p_len: u32 = read_u32(view, p_off + VM_REG_DATA_LEN);

        let matched: i32 = 0;
        if (op === OpCode.OP_STR_LIKE) {
          matched = sql_like_match_view(view, s_data, s_len, p_data, p_len) !== 0 ? 1 : 0;
        } else if (op === OpCode.OP_STR_NOT_LIKE) {
          matched = sql_like_match_view(view, s_data, s_len, p_data, p_len) === 0 ? 1 : 0;
        } else if (op === OpCode.OP_STR_CONTAINS) {
          matched = vm_str_contains_view(view, s_data, s_len, p_data, p_len) !== 0 ? 1 : 0;
        } else if (op === OpCode.OP_STR_STARTS_WITH) {
          matched = vm_str_starts_with_view(view, s_data, s_len, p_data, p_len) !== 0 ? 1 : 0;
        } else if (op === OpCode.OP_STR_ENDS_WITH) {
          matched = vm_str_ends_with_view(view, s_data, s_len, p_data, p_len) !== 0 ? 1 : 0;
        } else {
          matched = vm_str_fuzzy_match_view(view, s_data, s_len, p_data, p_len, 1, 1) !== 0 ? 1 : 0;
        }
        if (matched !== 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_IN: {
        if (pc + 5 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_val: u32 = read_u8(view, code_off + pc);
        const set_idx: u32 = read_u16(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 3);
        pc += 5;
        if (reg_val >= 64 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        if (
          vm_in_set_contains(view, ctx_off, set_idx, vm_reg_off(ctx_off, reg_val)) !==
          0
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_LOAD_INT: {
        if (pc + 5 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_idx: u32 = read_u8(view, code_off + pc);
        if (reg_idx >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const val: i32 = read_i32(view, code_off + pc + 1);
        pc += 5;
        vm_reg_set_i32(view, vm_reg_off(ctx_off, reg_idx), val);
        break;
      }

      case OpCode.OP_LOAD_INT64:
      case OpCode.OP_LOAD_FLOAT: {
        if (pc + 9 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_idx: u32 = read_u8(view, code_off + pc);
        if (reg_idx >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_off: u32 = vm_reg_off(ctx_off, reg_idx);
        if (op === OpCode.OP_LOAD_INT64) {
          vm_reg_set_i64(view, reg_off, read_i64(view, code_off + pc + 1));
        } else {
          vm_reg_set_f64(view, reg_off, read_f64(view, code_off + pc + 1));
        }
        pc += 9;
        break;
      }

      case OpCode.OP_LOAD_TEXT:
      case OpCode.OP_LOAD_BLOB: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_idx: u32 = read_u8(view, code_off + pc);
        const len: u16 = read_u16(view, code_off + pc + 1);
        if (reg_idx >= 64 || (len as u32) > code_len - (pc + 3)) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const data_off: u32 = code_off + pc + 3;
        pc += 3 + len;
        vm_reg_set_slice(
          view,
          vm_reg_off(ctx_off, reg_idx),
          op === OpCode.OP_LOAD_TEXT ? DataType.TEXT : DataType.BLOB,
          data_off,
          len,
        );
        break;
      }

      case OpCode.OP_LOAD_NULL: {
        if (pc + 1 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_idx: u32 = read_u8(view, code_off + pc);
        if (reg_idx >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        pc += 1;
        vm_reg_set_null(view, vm_reg_off(ctx_off, reg_idx));
        break;
      }

      case OpCode.OP_EMIT_ROW: {
        if (pc + 1 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        pc += 1;
        if (cursor_idx >= 16) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
        const total_row_length: u16 = read_u16(view, row_offset + 1);
        if (total_row_length < 3 || total_row_length > MAX_ROW_SIZE) {
          break;
        }

        const emit_status: i32 = vm_emit_raw_row(
          view,
          ctx_off,
          row_offset,
          total_row_length,
          instr_pc,
        );
        if (emit_status !== VmStatus.RUNNING) {
          return emit_status;
        }
        break;
      }

      case OpCode.OP_OFFSET:
      case OpCode.OP_LIMIT: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const count_reg: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (count_reg >= 64 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const reg_off: u32 = vm_reg_off(ctx_off, count_reg);
        const val: i32 =
          read_u8(view, reg_off + VM_REG_IS_NULL) !== 0
            ? 0
            : read_i32(view, reg_off + VM_REG_I32);
        if (op === OpCode.OP_OFFSET) {
          if (val > 0) {
            vm_reg_set_i32(view, reg_off, val - 1);
            pc = jump_target;
          }
        } else if (val <= 1) {
          vm_reg_set_i32(view, reg_off, 0);
          pc = jump_target;
        } else {
          vm_reg_set_i32(view, reg_off, val - 1);
        }
        break;
      }

      case OpCode.OP_CALL_UDF: {
        if (pc + 5 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const udf_id: u32 = read_u16(view, code_off + pc);
        const start_arg_reg: u32 = read_u8(view, code_off + pc + 2);
        const num_args: u32 = read_u8(view, code_off + pc + 3);
        const dest_reg: u32 = read_u8(view, code_off + pc + 4);
        pc += 5;

        if (dest_reg >= 64 || start_arg_reg + num_args > 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        write_u32(view, ctx_off + VM_CTX_UDF_ID, udf_id);
        write_u32(view, ctx_off + VM_CTX_UDF_START_REG, start_arg_reg);
        write_u32(view, ctx_off + VM_CTX_UDF_NUM_ARGS, num_args);
        write_u32(view, ctx_off + VM_CTX_UDF_DEST_REG, dest_reg);
        return vm_set_status(view, ctx_off, pc, VM_STATUS_HOST_UDF);
      }

      case OpCode.OP_STR_LOWER:
      case OpCode.OP_STR_UPPER:
      case OpCode.OP_STR_LENGTH:
      case OpCode.OP_STR_TRIM:
      case OpCode.OP_COPY: {
        if (pc + 2 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        if (src_reg >= 64 || dest_reg >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (op === OpCode.OP_STR_LOWER || op === OpCode.OP_STR_UPPER) {
          vm_str_case(
            view,
            ctx_off,
            arena_base,
            src_off,
            dst_off,
            op === OpCode.OP_STR_UPPER ? 1 : 0,
          );
        } else if (op === OpCode.OP_STR_TRIM) {
          vm_str_trim(view, src_off, dst_off);
        } else if (op === OpCode.OP_COPY) {
          vm_reg_copy(view, dst_off, src_off);
        } else if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
          vm_reg_set_null(view, dst_off);
        } else {
          const char_len: i32 = vm_utf8_char_count(
            view,
            read_u32(view, src_off + VM_REG_DATA_OFF),
            read_u32(view, src_off + VM_REG_DATA_LEN),
          );
          vm_reg_set_i32(view, dst_off, char_len);
        }
        break;
      }

      case OpCode.OP_STR_SUBSTR: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const src_reg: u32 = read_u8(view, code_off + pc);
        const start_reg: u32 = read_u8(view, code_off + pc + 1);
        const len_reg: u32 = read_u8(view, code_off + pc + 2);
        const dest_reg: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;
        if (src_reg >= 64 || start_reg >= 64 || len_reg >= 64 || dest_reg >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        vm_utf8_substr(
          view,
          vm_reg_off(ctx_off, src_reg),
          vm_reg_off(ctx_off, start_reg),
          vm_reg_off(ctx_off, len_reg),
          vm_reg_off(ctx_off, dest_reg),
        );
        break;
      }

      case OpCode.OP_STR_LEVENSHTEIN: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_str1: u32 = read_u8(view, code_off + pc);
        const reg_str2: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        if (reg_str1 >= 64 || reg_str2 >= 64 || dest_reg >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const s1_off: u32 = vm_reg_off(ctx_off, reg_str1);
        const s2_off: u32 = vm_reg_off(ctx_off, reg_str2);
        const dest_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, s1_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, s2_off + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, dest_off);
          break;
        }
        const dist: i32 = vm_str_levenshtein_view(
          view,
          read_u32(view, s1_off + VM_REG_DATA_OFF),
          read_u32(view, s1_off + VM_REG_DATA_LEN),
          read_u32(view, s2_off + VM_REG_DATA_OFF),
          read_u32(view, s2_off + VM_REG_DATA_LEN),
          255,
        );
        vm_reg_set_i32(view, dest_off, dist);
        break;
      }

      case OpCode.OP_MATH_ABS:
      case OpCode.OP_MATH_ROUND:
      case OpCode.OP_MATH_FLOOR:
      case OpCode.OP_MATH_CEIL: {
        if (pc + 2 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        if (src_reg >= 64 || dest_reg >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
          vm_reg_set_null(view, dst_off);
        } else {
          const x: f64 = read_f64(view, src_off + VM_REG_F64);
          let res: f64 = 0.0;
          if (op === OpCode.OP_MATH_ABS) {
            res = vm_math_abs(x);
          } else if (op === OpCode.OP_MATH_ROUND) {
            res = vm_math_round(x);
          } else if (op === OpCode.OP_MATH_FLOOR) {
            res = vm_math_floor(x);
          } else {
            res = vm_math_ceil(x);
          }
          vm_reg_set_f64(view, dst_off, res);
        }
        break;
      }

      case OpCode.OP_RESULT_ROW: {
        if (pc + 2 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const start_reg: u32 = read_u8(view, code_off + pc);
        const num_cols: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        if (start_reg + num_cols > 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const emit_status: i32 = vm_serialize_and_emit_result_row(
          view,
          ctx_off,
          start_reg,
          num_cols,
          instr_pc,
        );
        if (emit_status !== VmStatus.RUNNING) {
          return emit_status;
        }
        break;
      }

      case OpCode.OP_SORTER_OPEN: {
        if (pc + 2 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const sorter_id: u32 = read_u8(view, code_off + pc);
        const key_info_idx: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        if (sorter_id >= 4 || key_info_idx >= 8) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const open_status: i32 = vm_sorter_open_raw(
          view,
          ctx_off,
          arena_base,
          sorter_id,
          key_info_idx,
        );
        if (open_status !== VmStatus.RUNNING) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          return open_status;
        }
        break;
      }

      case OpCode.OP_SORTER_INSERT: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const sorter_id: u32 = read_u8(view, code_off + pc);
        const start_reg: u32 = read_u8(view, code_off + pc + 1);
        const num_keys: u32 = read_u8(view, code_off + pc + 2);
        const cursor_idx: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;
        if (
          sorter_id >= 4 ||
          cursor_idx >= 16 ||
          num_keys > 8 ||
          start_reg + num_keys > 64
        ) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const ins_status: i32 = vm_sorter_insert_raw(
          view,
          ctx_off,
          arena_base,
          sorter_id,
          start_reg,
          num_keys,
          cursor_idx,
        );
        if (ins_status !== VmStatus.RUNNING) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          return ins_status;
        }
        break;
      }

      case OpCode.OP_SORTER_SORT: {
        if (pc + 1 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const sorter_id: u32 = read_u8(view, code_off + pc);
        pc += 1;
        if (sorter_id >= 4) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const sort_status: i32 = vm_sorter_sort_raw(
          view,
          ctx_off,
          arena_base,
          sorter_id,
        );
        if (sort_status !== VmStatus.RUNNING) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          return sort_status;
        }
        break;
      }

      case OpCode.OP_SORTER_NEXT: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const sorter_id: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (sorter_id >= 4 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        write_u32(view, ctx_off + VM_CTX_PC, pc);
        const next_status: i32 = vm_sorter_next_raw(
          view,
          ctx_off,
          sorter_id,
          jump_target,
          instr_pc,
        );
        if (next_status !== VmStatus.RUNNING) {
          return next_status;
        }
        pc = read_u32(view, ctx_off + VM_CTX_PC);
        break;
      }

      case OpCode.OP_ADD:
      case OpCode.OP_SUB:
      case OpCode.OP_MUL:
      case OpCode.OP_DIV:
      case OpCode.OP_MOD: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        if (reg_a >= 64 || reg_b >= 64 || dest_reg >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const off_a: u32 = vm_reg_off(ctx_off, reg_a);
        const off_b: u32 = vm_reg_off(ctx_off, reg_b);
        const off_d: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, off_a + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, off_b + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, off_d);
          break;
        }
        const a: f64 = read_f64(view, off_a + VM_REG_F64);
        const b: f64 = read_f64(view, off_b + VM_REG_F64);
        if (op === OpCode.OP_ADD) {
          vm_reg_set_f64(view, off_d, a + b);
        } else if (op === OpCode.OP_SUB) {
          vm_reg_set_f64(view, off_d, a - b);
        } else if (op === OpCode.OP_MUL) {
          vm_reg_set_f64(view, off_d, a * b);
        } else if (b === 0.0) {
          vm_reg_set_null(view, off_d);
        } else if (op === OpCode.OP_DIV) {
          vm_reg_set_f64(view, off_d, a / b);
        } else {
          const q: f64 = Math.trunc(a / b);
          vm_reg_set_f64(view, off_d, a - q * b);
        }
        break;
      }

      case OpCode.OP_STR_CONCAT:
      case OpCode.OP_COALESCE: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const start_reg: u32 = read_u8(view, code_off + pc);
        const num_regs: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        if (dest_reg >= 64 || start_reg + num_regs > 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        if (op === OpCode.OP_STR_CONCAT) {
          vm_str_concat(view, ctx_off, arena_base, start_reg, num_regs, dest_reg);
        } else {
          const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
          let found: i32 = 0;
          for (let i: u32 = 0; i < num_regs; i++) {
            const r_off: u32 = vm_reg_off(ctx_off, start_reg + i);
            if (read_u8(view, r_off + VM_REG_IS_NULL) === 0) {
              vm_reg_copy(view, dst_off, r_off);
              found = 1;
              break;
            }
          }
          if (found === 0) {
            vm_reg_set_null(view, dst_off);
          }
        }
        break;
      }

      case OpCode.OP_AGG_INIT: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const agg_id: u32 = read_u8(view, code_off + pc);
        const start_key_reg: u32 = read_u8(view, code_off + pc + 1);
        const num_keys: u32 = read_u8(view, code_off + pc + 2);
        const mode: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;
        if (agg_id >= 4 || num_keys > 8 || start_key_reg + num_keys > 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const init_status: i32 = vm_agg_init_raw(
          view,
          ctx_off,
          arena_base,
          agg_id,
          start_key_reg,
          num_keys,
          mode,
        );
        if (init_status !== VmStatus.RUNNING) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          return init_status;
        }
        break;
      }

      case OpCode.OP_AGG_STEP: {
        if (pc + 5 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const agg_id: u32 = read_u8(view, code_off + pc);
        const start_key_reg: u32 = read_u8(view, code_off + pc + 1);
        const num_keys: u32 = read_u8(view, code_off + pc + 2);
        const val_reg: u32 = read_u8(view, code_off + pc + 3);
        const raw_func_id: u32 = read_u8(view, code_off + pc + 4);
        pc += 5;
        if (
          agg_id >= 4 ||
          num_keys > 8 ||
          start_key_reg + num_keys > 64 ||
          (val_reg !== 255 && val_reg >= 64)
        ) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        const step_status: i32 = vm_agg_step_raw(
          view,
          ctx_off,
          arena_base,
          agg_id,
          start_key_reg,
          num_keys,
          val_reg,
          raw_func_id,
        );
        if (step_status !== VmStatus.RUNNING) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          return step_status;
        }
        break;
      }

      case OpCode.OP_AGG_NEXT: {
        if (pc + 5 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const agg_id: u32 = read_u8(view, code_off + pc);
        const out_key_reg: u32 = read_u8(view, code_off + pc + 1);
        const out_acc_reg: u32 = read_u8(view, code_off + pc + 2);
        const jump_target: u32 = read_u16(view, code_off + pc + 3);
        pc += 5;
        if (
          agg_id >= 4 ||
          out_key_reg >= 64 ||
          out_acc_reg + 4 > 64 ||
          jump_target > code_len
        ) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        write_u32(view, ctx_off + VM_CTX_PC, pc);
        const next_status: i32 = vm_agg_next_raw(
          view,
          ctx_off,
          agg_id,
          out_key_reg,
          out_acc_reg,
          jump_target,
        );
        if (next_status !== VmStatus.RUNNING) {
          return next_status;
        }
        pc = read_u32(view, ctx_off + VM_CTX_PC);
        break;
      }

      case OpCode.OP_AGG_FINAL: {
        if (pc + 4 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const sum_reg: u32 = read_u8(view, code_off + pc);
        const count_reg: u32 = read_u8(view, code_off + pc + 1);
        const out_reg: u32 = read_u8(view, code_off + pc + 2);
        const raw_func_id: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;
        if (sum_reg >= 64 || count_reg >= 64 || out_reg >= 64) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }

        vm_agg_final_raw(
          view,
          ctx_off,
          sum_reg,
          count_reg,
          out_reg,
          raw_func_id,
        );
        break;
      }

      case OpCode.OP_REG_IS_NULL:
      case OpCode.OP_REG_IS_NOT_NULL: {
        if (pc + 3 > code_len) {
          return vm_set_status(view, ctx_off, instr_pc, VmStatus.INVALID_BYTECODE);
        }
        const reg: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;
        if (reg >= 64 || jump_target > code_len) {
          return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
        }

        const is_null: u8 = read_u8(view, vm_reg_off(ctx_off, reg) + VM_REG_IS_NULL);
        if (
          (op === OpCode.OP_REG_IS_NULL && is_null !== 0) ||
          (op === OpCode.OP_REG_IS_NOT_NULL && is_null === 0)
        ) {
          pc = jump_target;
        }
        break;
      }

      default:
        return vm_set_status(view, ctx_off, pc, VmStatus.INVALID_BYTECODE);
    }
  }

  return vm_set_status(view, ctx_off, pc, VmStatus.DONE);
}

/**
 * Synchronous Bytecode VM execution step loop.
 * Runs instructions until STATUS_DONE, STATUS_BUFFER_FULL, or an error.
 */
export function vm_step(
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array,
): VmStatus {
  return executeVmStepWithRunner(
    ctx,
    view,
    bytecode,
    (activeView, ctxOff, codeOff, codeLen, arenaBase) =>
      vm_step_raw(activeView, ctxOff, codeOff, codeLen, arenaBase),
  );
}
