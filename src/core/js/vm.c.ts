/**
 * @c_include "vm_helpers.h"
 * @c_include "page.h"
 * @c_include "buffer_pool.h"
 */

import {
  PAGE_TO_SLOT_OFFSET,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  SLOT_TO_PAGE_OFFSET,
  VM_CONTEXT_OFFSET,
  RESULT_BUFFER_OFFSET,
  BYTECODE_OFFSET,
  TRANSIENT_ARENA_OFFSET,
  TOTAL_MEMORY_BYTES,
  PAGE_TYPE_LEAF_DATA,
  MAX_ROW_SIZE,
} from "../../constants.ts";
import { OpCode, VmStatus, DataType } from "../../types/index.ts";
import { u8, u16, u32, i32, i64, f64 } from "../types.ts";
import {
  page_get_type,
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
} from "./page.c.ts";
import { buf_pool_get_resident_slot } from "./buffer_pool.c.ts";
import {
  memcpy,
  memset,
  read_u8,
  write_u8,
  read_u16,
  write_u16,
  read_u32,
  write_u32,
  read_i32,
  write_i32,
  read_i64,
  read_f64,
  i64_to_i32,
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
  VM_CTX_STATUS,
  VM_CTX_FAULT_PAGE_ID,
  VM_CTX_RESULT_COUNT,
  VM_CTX_RESULT_OFFSET,
  VM_CTX_ARENA_OFFSET,
  VM_CTX_MAX_QUERY_MEMORY,
  VM_CTX_HAS_BUFFER_POOL,
  VM_CTX_NUM_TABLES,
  VM_CTX_NUM_OUTPUT_COLS,
  VM_CTX_NUM_KEY_INFOS,
  VM_CTX_NUM_IN_SETS,
  VM_CTX_UDF_ID,
  VM_CTX_UDF_START_REG,
  VM_CTX_UDF_NUM_ARGS,
  VM_CTX_UDF_DEST_REG,
  VM_CTX_PHYS_ARENA_USED,
  VM_CTX_CURRENT_BUCKET_OFF,
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
  VM_CTX_REGISTERS_OFF,
  VM_CTX_CURSORS_OFF,
  VM_CTX_TABLES_OFF,
  VM_TABLE_DESC_SIZE,
  VM_CTX_OUTPUT_COLS_OFF,
  VM_CTX_KEY_INFOS_OFF,
  VM_KEY_INFO_SIZE,
  VM_KI_NUM_KEYS,
  VM_KI_HAS_LIMIT,
  VM_KI_LIMIT,
  VM_KI_OFFSET,
  VM_KI_DIRECTIONS,
  VM_KI_NULL_ORDERS,
  VM_CTX_SORTERS_OFF,
  VM_CTX_AGGS_OFF,
  VM_AGG_SIZE,
  VM_AGG_IS_OPEN,
  VM_AGG_MODE,
  VM_AGG_START_KEY_REG,
  VM_AGG_NUM_KEYS,
  VM_AGG_CAPACITY,
  VM_AGG_OCCUPIED,
  VM_AGG_READ_IDX,
  VM_CTX_IN_SETS_OFF,
  VM_STATUS_HOST_UDF,
  vm_reg_off,
  vm_cursor_off,
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
  vm_index_seek_leaf_eq,
  vm_index_seek_leaf_ge,
  sql_like_match_view,
  vm_str_contains_view,
  vm_str_starts_with_view,
  vm_str_ends_with_view,
  vm_utf8_char_count,
  vm_str_lower,
  vm_str_upper,
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
  let pc: u32 = read_u32(view, ctx_off + VM_CTX_PC);

  while (pc < code_len) {
    cycles++;
    if (cycles > MAX_CYCLES) {
      // JS: ctx.pc = pc; ctx.status = VmStatus.TIMEOUT; return VmStatus.TIMEOUT;
      write_u32(view, ctx_off + VM_CTX_PC, pc);
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.TIMEOUT);
      return VmStatus.TIMEOUT;
    }

    const instr_pc: u32 = pc;
    // JS: const op = bytecode[pc++];
    const op: u8 = read_u8(view, code_off + pc);
    pc += 1;

    switch (op) {
      case OpCode.OP_HALT: {
        // JS:
        //   ctx.arenaOffset = 0;
        //   ctx.pc = pc;
        //   ctx.status = VmStatus.DONE;
        //   return VmStatus.DONE;
        write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, 0);
        write_u32(view, ctx_off + VM_CTX_PC, pc);
        write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.DONE);
        return VmStatus.DONE;
      }

      case OpCode.OP_OPEN_CURSOR: {
        // JS: const cursor_idx = bytecode[pc]; const root_page_id = bytecodeView.getUint32(pc + 1, true); pc += 5;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const root_page_id: u32 = read_u32(view, code_off + pc + 1);
        pc += 5;

        // JS:
        //   const cursor = ctx.cursors[cursor_idx];
        //   cursor.pageId = root_page_id;
        //   cursor.cellIdx = 0;
        //   cursor.rowOffset = 0;
        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        write_u32(view, cur_off + VM_CUR_PAGE_ID, root_page_id);
        write_i32(view, cur_off + VM_CUR_CELL_IDX, 0);
        write_u32(view, cur_off + VM_CUR_ROW_OFFSET, 0);

        if (has_buffer_pool !== 0 && root_page_id > 0) {
          const slot: i32 = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            root_page_id,
          );
          if (slot < 0) {
            // JS:
            //   ctx.fault_page_id = root_page_id;
            //   ctx.status = VmStatus.PAGE_FAULT;
            //   ctx.pc = instr_pc; // Re-run this instruction once host loads page
            //   return VmStatus.PAGE_FAULT;
            write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, root_page_id);
            write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
            write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
            return VmStatus.PAGE_FAULT;
          }
          // JS: cursor.slotIdx = slot;
          write_i32(view, cur_off + VM_CUR_SLOT_IDX, slot);
        }
        break;
      }

      case OpCode.OP_REWIND: {
        // JS: const cursor_idx = bytecode[pc]; const jump_target = bytecodeView.getUint16(pc + 1, true); pc += 3;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          // JS: ctx.pc = pc; ctx.status = VmStatus.INVALID_BYTECODE; return VmStatus.INVALID_BYTECODE;
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        // JS: const cursor = ctx.cursors[cursor_idx]; const page_id = cursor.pageId;
        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);

        if (has_buffer_pool !== 0 && page_id > 0) {
          const slot: i32 = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            page_id,
          );
          if (slot < 0) {
            // JS: ctx.fault_page_id = page_id; ctx.status = VmStatus.PAGE_FAULT; ctx.pc = instr_pc;
            write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, page_id);
            write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
            write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
            return VmStatus.PAGE_FAULT;
          }
          // JS: cursor.slotIdx = slot;
          write_i32(view, cur_off + VM_CUR_SLOT_IDX, slot);
        }

        const page_offset: u32 = vm_resolve_page_offset(
          view,
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
            pc = instr_pc; // re-run REWIND on the next page (also handles a page fault)
          } else {
            // JS: pc = jump_target; (empty table -> jump to EOF)
            pc = jump_target;
          }
        } else {
          // JS:
          //   cursor.cellIdx = 0;
          //   cursor.rowOffset = page_offset + page_get_cell_offset(view, page_offset, 0);
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
        // JS: const cursor_idx = bytecode[pc]; const jump_target = bytecodeView.getUint16(pc + 1, true); pc += 3;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        // JS: const cursor = ctx.cursors[cursor_idx]; const page_id = cursor.pageId;
        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        const page_offset: u32 = vm_resolve_page_offset(
          view,
          has_buffer_pool,
          page_id,
        );
        if (page_get_type(view, page_offset) !== PAGE_TYPE_LEAF_DATA) {
          pc = jump_target;
          break;
        }
        const cell_count: i32 = page_get_cell_count(view, page_offset);

        // JS: const next_cell_idx = cursor.cellIdx + 1;
        const next_cell_idx: i32 = read_i32(view, cur_off + VM_CUR_CELL_IDX) + 1;
        if (next_cell_idx < cell_count) {
          // JS:
          //   cursor.cellIdx = next_cell_idx;
          //   cursor.rowOffset = page_offset + page_get_cell_offset(view, page_offset, next_cell_idx);
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
            if (has_buffer_pool !== 0) {
              const slot: i32 = buf_pool_get_resident_slot(
                view,
                PAGE_TO_SLOT_OFFSET,
                DEFAULT_PAGE_TO_SLOT_BUCKETS,
                next_page_id,
              );
              if (slot < 0) {
                // JS: ctx.fault_page_id = next_page_id; ctx.status = VmStatus.PAGE_FAULT; ctx.pc = instr_pc;
                write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, next_page_id);
                write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
                write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
                return VmStatus.PAGE_FAULT;
              }
              // JS: cursor.slotIdx = slot;
              write_i32(view, cur_off + VM_CUR_SLOT_IDX, slot);
            }

            const next_offset: u32 = vm_resolve_page_offset(
              view,
              has_buffer_pool,
              next_page_id,
            );
            if (page_get_type(view, next_offset) !== PAGE_TYPE_LEAF_DATA) {
              pc = jump_target;
              break;
            }

            // JS: cursor.pageId = next_page_id; cursor.cellIdx = 0;
            write_u32(view, cur_off + VM_CUR_PAGE_ID, next_page_id);
            write_i32(view, cur_off + VM_CUR_CELL_IDX, 0);
            const next_count: u16 = page_get_cell_count(view, next_offset);
            if (next_count > 0) {
              const rel_cell_offset: u16 = page_get_cell_offset(
                view,
                next_offset,
                0,
              );
              // JS: cursor.rowOffset = next_offset + rel_cell_offset;
              write_u32(
                view,
                cur_off + VM_CUR_ROW_OFFSET,
                next_offset + rel_cell_offset,
              );
            } else {
              // Empty page in the middle of the chain: step onto it and re-run NEXT_ROW so the
              // scan continues with the following page instead of ending early.
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
        // JS:
        //   const cursor = ctx.cursors[cursor_idx];
        //   if (cell_count === 0) pc = jump_target;
        //   else { cursor.cellIdx = cell_count - 1; cursor.rowOffset = page_offset + rel_cell_offset; }
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        const page_offset: u32 = vm_resolve_page_offset(
          view,
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
        // JS:
        //   const cursor = ctx.cursors[cursor_idx];
        //   if (cursor.cellIdx > 0) { cursor.cellIdx--; cursor.rowOffset = page_offset + rel_cell_offset; }
        //   else pc = jump_target;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const page_id: u32 = read_u32(view, cur_off + VM_CUR_PAGE_ID);
        const page_offset: u32 = vm_resolve_page_offset(
          view,
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

      case OpCode.OP_COLUMN_INT: {
        // JS:
        //   const rowOffset = ctx.cursors[cursor_idx].rowOffset;
        //   if (isColNull(rowOffset, col_idx)) ctx.registers[reg_idx] = null;
        //   else ctx.registers[reg_idx] = view.getInt32(col_offset, true); // or getBigInt64
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_idx: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;

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
        const col_type: u8 = read_u8(view, tbl_off + 4 + col_idx);

        if (col_type === DataType.INT32) {
          vm_reg_set_i32(view, reg_off, read_i32(view, col_offset));
        } else if (col_type === DataType.INT64) {
          vm_reg_set_i64(view, reg_off, read_i64(view, col_offset));
        }
        break;
      }

      case OpCode.OP_COLUMN_FLOAT: {
        // JS:
        //   const rowOffset = ctx.cursors[cursor_idx].rowOffset;
        //   if (isColNull(rowOffset, col_idx)) ctx.registers[reg_idx] = null;
        //   else ctx.registers[reg_idx] = view.getFloat64(col_offset, true);
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_idx: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;

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
        vm_reg_set_f64(view, reg_off, read_f64(view, col_offset));
        break;
      }

      case OpCode.OP_COLUMN_UUID:
      case OpCode.OP_COLUMN_ULID:
      case OpCode.OP_COLUMN_TEXT: {
        // JS:
        //   const rowOffset = ctx.cursors[cursor_idx].rowOffset;
        //   if (isColNull(rowOffset, col_idx)) ctx.registers[reg_idx] = null;
        //   else ctx.registers[reg_idx] = textDecoder.decode(rowSlice); // stored here as zero-copy (offset, len)
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_idx: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;

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

        const col_type: u8 = read_u8(view, tbl_off + 4 + col_idx);
        if (col_type === DataType.UUID || col_type === DataType.ULID) {
          const col_offset: u32 = vm_compute_fixed_col_offset(
            view,
            null_bitmap_offset,
            null_bitmap_bytes,
            tbl_off,
            col_idx,
          );
          if (col_type === DataType.UUID) {
            const out_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, 36);
            if (out_off === 0) {
              write_u32(view, ctx_off + VM_CTX_PC, pc);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
              return VmStatus.ARENA_EXHAUSTED;
            }
            vm_uuid_decode_view(view, col_offset, out_off);
            vm_reg_set_slice(view, reg_off, DataType.UUID, out_off, 36);
          } else {
            const out_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, 26);
            if (out_off === 0) {
              write_u32(view, ctx_off + VM_CTX_PC, pc);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
              return VmStatus.ARENA_EXHAUSTED;
            }
            vm_ulid_decode_view(view, col_offset, out_off);
            vm_reg_set_slice(view, reg_off, DataType.ULID, out_off, 26);
          }
          break;
        }

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
          DataType.TEXT,
          row_offset + rel_offset,
          len,
        );
        break;
      }

      case OpCode.OP_COLUMN_BLOB: {
        // JS:
        //   const rowOffset = ctx.cursors[cursor_idx].rowOffset;
        //   if (isColNull(rowOffset, col_idx)) ctx.registers[reg_idx] = null;
        //   else ctx.registers[reg_idx] = new Uint8Array(buffer, rowOffset + rel_offset, len);
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_idx: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;

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
          DataType.BLOB,
          row_offset + rel_offset,
          len,
        );
        break;
      }

      case OpCode.OP_OPEN_INDEX: {
        // JS:
        //   const cursor = ctx.cursors[cursor_idx];
        //   cursor.pageId = root_page_id;
        //   cursor.rootPageId = root_page_id;
        //   cursor.cellIdx = 0;
        //   cursor.rowOffset = 0;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const root_page_id: u32 = read_u32(view, code_off + pc + 1);
        pc += 5;

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        write_u32(view, cur_off + VM_CUR_PAGE_ID, root_page_id);
        write_u32(view, cur_off + VM_CUR_ROOT_PAGE_ID, root_page_id);
        write_i32(view, cur_off + VM_CUR_CELL_IDX, 0);
        write_u32(view, cur_off + VM_CUR_ROW_OFFSET, 0);

        if (has_buffer_pool !== 0 && root_page_id > 0) {
          const slot: i32 = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            root_page_id,
          );
          if (slot < 0) {
            write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, root_page_id);
            write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
            write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
            return VmStatus.PAGE_FAULT;
          }
          write_i32(view, cur_off + VM_CUR_SLOT_IDX, slot);
        }
        break;
      }

      case OpCode.OP_INDEX_SEEK_EQ: {
        const index_cursor_idx: u32 = read_u8(view, code_off + pc);
        const data_cursor_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_key: u32 = read_u8(view, code_off + pc + 2);
        const key_type: u8 = read_u8(view, code_off + pc + 3);
        const jump_not_found: u32 = read_u16(view, code_off + pc + 4);
        pc += 6;

        if (jump_not_found > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const key_reg_off: u32 = vm_reg_off(ctx_off, reg_key);
        if (read_u8(view, key_reg_off + VM_REG_IS_NULL) !== 0) {
          pc = jump_not_found;
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

        while (curr_page_id !== 0) {
          if (has_buffer_pool !== 0 && curr_page_id > 0) {
            const slot: i32 = buf_pool_get_resident_slot(
              view,
              PAGE_TO_SLOT_OFFSET,
              DEFAULT_PAGE_TO_SLOT_BUCKETS,
              curr_page_id,
            );
            if (slot < 0) {
              write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, curr_page_id);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
              write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
              return VmStatus.PAGE_FAULT;
            }
            write_i32(view, idx_cur_off + VM_CUR_SLOT_IDX, slot);
          }

          const page_offset: u32 = vm_resolve_page_offset(
            view,
            has_buffer_pool,
            curr_page_id,
          );
          const matched_slot: i32 = vm_index_seek_leaf_eq(
            view,
            ctx_off,
            page_offset,
            key_type,
            key_reg_off,
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
          pc = jump_not_found;
        } else {
          const data_page_id: u32 = i64_to_i32(matched_rowid >> 16n) as u32;
          const data_cell_idx: i32 = i64_to_i32(matched_rowid & 0xffffn);

          if (has_buffer_pool !== 0 && data_page_id > 0) {
            const slot: i32 = buf_pool_get_resident_slot(
              view,
              PAGE_TO_SLOT_OFFSET,
              DEFAULT_PAGE_TO_SLOT_BUCKETS,
              data_page_id,
            );
            if (slot < 0) {
              write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, data_page_id);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
              write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
              return VmStatus.PAGE_FAULT;
            }
          }

          const data_cur_off: u32 = vm_cursor_off(ctx_off, data_cursor_idx);
          write_u32(view, data_cur_off + VM_CUR_PAGE_ID, data_page_id);
          write_i32(view, data_cur_off + VM_CUR_CELL_IDX, data_cell_idx);
          const data_page_offset: u32 = vm_resolve_page_offset(
            view,
            has_buffer_pool,
            data_page_id,
          );
          const rel_cell_offset: u16 = page_get_cell_offset(
            view,
            data_page_offset,
            data_cell_idx as u16,
          );
          write_u32(
            view,
            data_cur_off + VM_CUR_ROW_OFFSET,
            data_page_offset + rel_cell_offset,
          );
        }
        break;
      }

      case OpCode.OP_INDEX_SEEK_GE: {
        const index_cursor_idx: u32 = read_u8(view, code_off + pc);
        const data_cursor_idx: u32 = read_u8(view, code_off + pc + 1);
        const reg_key: u32 = read_u8(view, code_off + pc + 2);
        const key_type: u8 = read_u8(view, code_off + pc + 3);
        const jump_eof: u32 = read_u16(view, code_off + pc + 4);
        pc += 6;

        if (jump_eof > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const key_reg_off: u32 = vm_reg_off(ctx_off, reg_key);
        if (read_u8(view, key_reg_off + VM_REG_IS_NULL) !== 0) {
          pc = jump_eof;
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

        while (curr_page_id !== 0) {
          if (has_buffer_pool !== 0 && curr_page_id > 0) {
            const slot: i32 = buf_pool_get_resident_slot(
              view,
              PAGE_TO_SLOT_OFFSET,
              DEFAULT_PAGE_TO_SLOT_BUCKETS,
              curr_page_id,
            );
            if (slot < 0) {
              write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, curr_page_id);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
              write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
              return VmStatus.PAGE_FAULT;
            }
            write_i32(view, idx_cur_off + VM_CUR_SLOT_IDX, slot);
          }

          const page_offset: u32 = vm_resolve_page_offset(
            view,
            has_buffer_pool,
            curr_page_id,
          );
          const candidate_slot: i32 = vm_index_seek_leaf_ge(
            view,
            ctx_off,
            page_offset,
            key_type,
            key_reg_off,
          );

          if (candidate_slot >= 0) {
            found = 1;
            write_u32(view, idx_cur_off + VM_CUR_PAGE_ID, curr_page_id);
            write_i32(view, idx_cur_off + VM_CUR_CELL_IDX, candidate_slot);
            const cell_offset: u16 = page_get_cell_offset(
              view,
              page_offset,
              candidate_slot as u16,
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
          pc = jump_eof;
        } else {
          const data_page_id: u32 = i64_to_i32(matched_rowid >> 16n) as u32;
          const data_cell_idx: i32 = i64_to_i32(matched_rowid & 0xffffn);

          if (has_buffer_pool !== 0 && data_page_id > 0) {
            const slot: i32 = buf_pool_get_resident_slot(
              view,
              PAGE_TO_SLOT_OFFSET,
              DEFAULT_PAGE_TO_SLOT_BUCKETS,
              data_page_id,
            );
            if (slot < 0) {
              write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, data_page_id);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
              write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
              return VmStatus.PAGE_FAULT;
            }
          }

          const data_cur_off: u32 = vm_cursor_off(ctx_off, data_cursor_idx);
          write_u32(view, data_cur_off + VM_CUR_PAGE_ID, data_page_id);
          write_i32(view, data_cur_off + VM_CUR_CELL_IDX, data_cell_idx);
          const data_page_offset: u32 = vm_resolve_page_offset(
            view,
            has_buffer_pool,
            data_page_id,
          );
          const rel_cell_offset: u16 = page_get_cell_offset(
            view,
            data_page_offset,
            data_cell_idx as u16,
          );
          write_u32(
            view,
            data_cur_off + VM_CUR_ROW_OFFSET,
            data_page_offset + rel_cell_offset,
          );
        }
        break;
      }

      case OpCode.OP_INDEX_NEXT: {
        const index_cursor_idx: u32 = read_u8(view, code_off + pc);
        const data_cursor_idx: u32 = read_u8(view, code_off + pc + 1);
        const jump_eof: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_eof > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const idx_cur_off: u32 = vm_cursor_off(ctx_off, index_cursor_idx);
        let curr_page_id: u32 = read_u32(view, idx_cur_off + VM_CUR_PAGE_ID);
        let page_offset: u32 = vm_resolve_page_offset(
          view,
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
          if (has_buffer_pool !== 0 && curr_page_id > 0) {
            const slot: i32 = buf_pool_get_resident_slot(
              view,
              PAGE_TO_SLOT_OFFSET,
              DEFAULT_PAGE_TO_SLOT_BUCKETS,
              curr_page_id,
            );
            if (slot < 0) {
              write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, curr_page_id);
              write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
              write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
              return VmStatus.PAGE_FAULT;
            }
            write_i32(view, idx_cur_off + VM_CUR_SLOT_IDX, slot);
          }
          page_offset = vm_resolve_page_offset(
            view,
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

        const data_page_id: u32 = i64_to_i32(matched_rowid >> 16n) as u32;
        const data_cell_idx: i32 = i64_to_i32(matched_rowid & 0xffffn);

        if (has_buffer_pool !== 0 && data_page_id > 0) {
          const slot: i32 = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            data_page_id,
          );
          if (slot < 0) {
            write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, data_page_id);
            write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.PAGE_FAULT);
            write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
            return VmStatus.PAGE_FAULT;
          }
        }

        write_u32(view, idx_cur_off + VM_CUR_PAGE_ID, curr_page_id);
        write_i32(view, idx_cur_off + VM_CUR_CELL_IDX, next_cell_idx);

        const data_cur_off: u32 = vm_cursor_off(ctx_off, data_cursor_idx);
        write_u32(view, data_cur_off + VM_CUR_PAGE_ID, data_page_id);
        write_i32(view, data_cur_off + VM_CUR_CELL_IDX, data_cell_idx);
        const data_page_offset: u32 = vm_resolve_page_offset(
          view,
          has_buffer_pool,
          data_page_id,
        );
        const rel_cell_offset: u16 = page_get_cell_offset(
          view,
          data_page_offset,
          data_cell_idx as u16,
        );
        write_u32(
          view,
          data_cur_off + VM_CUR_ROW_OFFSET,
          data_page_offset + rel_cell_offset,
        );
        break;
      }

      case OpCode.OP_IS_NULL: {
        // JS: if (isColNull(ctx.cursors[cursor_idx].rowOffset, col_idx)) pc = jump_target;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
        if (vm_row_is_null(view, row_offset + 3, col_idx) !== 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_IS_NOT_NULL: {
        // JS: if (!isColNull(ctx.cursors[cursor_idx].rowOffset, col_idx)) pc = jump_target;
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        const col_idx: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
        const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
        if (vm_row_is_null(view, row_offset + 3, col_idx) === 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_EQ: {
        // JS: if (compare3VL(ctx.registers[reg_a], ctx.registers[reg_b]) === 0) pc = jump_target;
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        if (cmp === 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_NE: {
        // JS: const cmp = compare3VL(ctx.registers[reg_a], ctx.registers[reg_b]); if (cmp !== UNKNOWN && cmp !== 0) pc = jump_target;
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        if (cmp !== -2 && cmp !== 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_GT: {
        // JS: if (compare3VL(ctx.registers[reg_a], ctx.registers[reg_b]) === 1) pc = jump_target;
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        if (cmp === 1) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_GE: {
        // JS: const cmp = compare3VL(ctx.registers[reg_a], ctx.registers[reg_b]); if (cmp === 0 || cmp === 1) pc = jump_target;
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        if (cmp === 0 || cmp === 1) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_LT: {
        // JS: if (compare3VL(ctx.registers[reg_a], ctx.registers[reg_b]) === -1) pc = jump_target;
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        if (cmp === -1) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_LE: {
        // JS: const cmp = compare3VL(ctx.registers[reg_a], ctx.registers[reg_b]); if (cmp === -1 || cmp === 0) pc = jump_target;
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp: i32 = vm_compare_reg_3vl(
          view,
          vm_reg_off(ctx_off, reg_a),
          vm_reg_off(ctx_off, reg_b),
        );
        if (cmp === -1 || cmp === 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_JUMP: {
        // JS: pc = bytecodeView.getUint16(pc, true);
        const jump_target: u32 = read_u16(view, code_off + pc);
        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }
        pc = jump_target;
        break;
      }

      case OpCode.OP_STR_LIKE: {
        const reg_str: u32 = read_u8(view, code_off + pc);
        const reg_pat: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }
        const s_off: u32 = vm_reg_off(ctx_off, reg_str);
        const p_off: u32 = vm_reg_off(ctx_off, reg_pat);
        if (
          read_u8(view, s_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, p_off + VM_REG_IS_NULL) !== 0
        ) {
          break;
        }
        if (
          sql_like_match_view(
            view,
            read_u32(view, s_off + VM_REG_DATA_OFF),
            read_u32(view, s_off + VM_REG_DATA_LEN),
            read_u32(view, p_off + VM_REG_DATA_OFF),
            read_u32(view, p_off + VM_REG_DATA_LEN),
          ) !== 0
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_STR_NOT_LIKE: {
        const reg_str: u32 = read_u8(view, code_off + pc);
        const reg_pat: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }
        const s_off: u32 = vm_reg_off(ctx_off, reg_str);
        const p_off: u32 = vm_reg_off(ctx_off, reg_pat);
        if (
          read_u8(view, s_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, p_off + VM_REG_IS_NULL) !== 0
        ) {
          break;
        }
        if (
          sql_like_match_view(
            view,
            read_u32(view, s_off + VM_REG_DATA_OFF),
            read_u32(view, s_off + VM_REG_DATA_LEN),
            read_u32(view, p_off + VM_REG_DATA_OFF),
            read_u32(view, p_off + VM_REG_DATA_LEN),
          ) === 0
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_STR_CONTAINS: {
        const reg_str: u32 = read_u8(view, code_off + pc);
        const reg_sub: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }
        const s_off: u32 = vm_reg_off(ctx_off, reg_str);
        const sub_off: u32 = vm_reg_off(ctx_off, reg_sub);
        if (
          read_u8(view, s_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, sub_off + VM_REG_IS_NULL) !== 0
        ) {
          break;
        }
        if (
          vm_str_contains_view(
            view,
            read_u32(view, s_off + VM_REG_DATA_OFF),
            read_u32(view, s_off + VM_REG_DATA_LEN),
            read_u32(view, sub_off + VM_REG_DATA_OFF),
            read_u32(view, sub_off + VM_REG_DATA_LEN),
          ) !== 0
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_STR_STARTS_WITH: {
        const reg_str: u32 = read_u8(view, code_off + pc);
        const reg_pfx: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }
        const s_off: u32 = vm_reg_off(ctx_off, reg_str);
        const pfx_off: u32 = vm_reg_off(ctx_off, reg_pfx);
        if (
          read_u8(view, s_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, pfx_off + VM_REG_IS_NULL) !== 0
        ) {
          break;
        }
        if (
          vm_str_starts_with_view(
            view,
            read_u32(view, s_off + VM_REG_DATA_OFF),
            read_u32(view, s_off + VM_REG_DATA_LEN),
            read_u32(view, pfx_off + VM_REG_DATA_OFF),
            read_u32(view, pfx_off + VM_REG_DATA_LEN),
          ) !== 0
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_STR_ENDS_WITH: {
        const reg_str: u32 = read_u8(view, code_off + pc);
        const reg_sfx: u32 = read_u8(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 2);
        pc += 4;
        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }
        const s_off: u32 = vm_reg_off(ctx_off, reg_str);
        const sfx_off: u32 = vm_reg_off(ctx_off, reg_sfx);
        if (
          read_u8(view, s_off + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, sfx_off + VM_REG_IS_NULL) !== 0
        ) {
          break;
        }
        if (
          vm_str_ends_with_view(
            view,
            read_u32(view, s_off + VM_REG_DATA_OFF),
            read_u32(view, s_off + VM_REG_DATA_LEN),
            read_u32(view, sfx_off + VM_REG_DATA_OFF),
            read_u32(view, sfx_off + VM_REG_DATA_LEN),
          ) !== 0
        ) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_IN: {
        const reg_val: u32 = read_u8(view, code_off + pc);
        const set_idx: u32 = read_u16(view, code_off + pc + 1);
        const jump_target: u32 = read_u16(view, code_off + pc + 3);
        pc += 5;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
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
        // JS: ctx.registers[reg_idx] = bytecodeView.getInt32(pc + 1, true);
        const reg_idx: u32 = read_u8(view, code_off + pc);
        const val: i32 = read_i32(view, code_off + pc + 1);
        pc += 5;
        vm_reg_set_i32(view, vm_reg_off(ctx_off, reg_idx), val);
        break;
      }

      case OpCode.OP_LOAD_FLOAT: {
        // JS: ctx.registers[reg_idx] = bytecodeView.getFloat64(pc + 1, true);
        const reg_idx: u32 = read_u8(view, code_off + pc);
        const val: f64 = read_f64(view, code_off + pc + 1);
        pc += 9;
        vm_reg_set_f64(view, vm_reg_off(ctx_off, reg_idx), val);
        break;
      }

      case OpCode.OP_LOAD_TEXT: {
        // JS: ctx.registers[reg_idx] = textDecoder.decode(bytecode.subarray(pc + 3, pc + 3 + len));
        // Flat memory: stores zero-copy pointer `(code_off + pc + 3, len)` directly into register
        const reg_idx: u32 = read_u8(view, code_off + pc);
        const len: u16 = read_u16(view, code_off + pc + 1);
        const str_off: u32 = code_off + pc + 3;
        pc += 3 + len;
        vm_reg_set_slice(
          view,
          vm_reg_off(ctx_off, reg_idx),
          DataType.TEXT,
          str_off,
          len,
        );
        break;
      }

      case OpCode.OP_LOAD_BLOB: {
        // JS: ctx.registers[reg_idx] = bytecode.slice(pc + 3, pc + 3 + len);
        // Flat memory: stores zero-copy pointer `(code_off + pc + 3, len)` directly into register
        const reg_idx: u32 = read_u8(view, code_off + pc);
        const len: u16 = read_u16(view, code_off + pc + 1);
        const blob_off: u32 = code_off + pc + 3;
        pc += 3 + len;
        vm_reg_set_slice(
          view,
          vm_reg_off(ctx_off, reg_idx),
          DataType.BLOB,
          blob_off,
          len,
        );
        break;
      }

      case OpCode.OP_LOAD_NULL: {
        // JS: ctx.registers[reg_idx] = null;
        const reg_idx: u32 = read_u8(view, code_off + pc);
        pc += 1;
        vm_reg_set_null(view, vm_reg_off(ctx_off, reg_idx));
        break;
      }

      case OpCode.OP_EMIT_ROW: {
        // JS:
        //   const rowOffset = ctx.cursors[cursor_idx].rowOffset;
        //   emitRawRowToResultBuffer(ctx, view, rowOffset, totalRowLength);
        const cursor_idx: u32 = read_u8(view, code_off + pc);
        pc += 1;

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

      case OpCode.OP_OFFSET: {
        // JS:
        //   const offsetVal = Number(ctx.registers[offset_reg] ?? 0);
        //   if (offsetVal > 0) { ctx.registers[offset_reg] = offsetVal - 1; pc = jump_target; }
        const offset_reg: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const reg_off: u32 = vm_reg_off(ctx_off, offset_reg);
        const offset_val: i32 =
          read_u8(view, reg_off + VM_REG_IS_NULL) !== 0
            ? 0
            : read_i32(view, reg_off + VM_REG_I32);
        if (offset_val > 0) {
          vm_reg_set_i32(view, reg_off, offset_val - 1);
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_LIMIT: {
        // JS:
        //   const limitVal = Number(ctx.registers[limit_reg] ?? 0);
        //   if (limitVal <= 1) { ctx.registers[limit_reg] = 0; pc = jump_target; }
        //   else { ctx.registers[limit_reg] = limitVal - 1; }
        const limit_reg: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        const reg_off: u32 = vm_reg_off(ctx_off, limit_reg);
        const limit_val: i32 =
          read_u8(view, reg_off + VM_REG_IS_NULL) !== 0
            ? 0
            : read_i32(view, reg_off + VM_REG_I32);
        if (limit_val <= 1) {
          vm_reg_set_i32(view, reg_off, 0);
          pc = jump_target;
        } else {
          vm_reg_set_i32(view, reg_off, limit_val - 1);
        }
        break;
      }

      case OpCode.OP_CALL_UDF: {
        // JS: ctx.registers[dest_reg] = ctx.udfs[udf_id](...ctx.registers.slice(start_arg_reg, start_arg_reg + num_args));
        // Flat memory: writes UDF call descriptor into `VM_CONTEXT` and yields `VM_STATUS_HOST_UDF` to host wrapper
        const udf_id: u32 = read_u16(view, code_off + pc);
        const start_arg_reg: u32 = read_u8(view, code_off + pc + 2);
        const num_args: u32 = read_u8(view, code_off + pc + 3);
        const dest_reg: u32 = read_u8(view, code_off + pc + 4);
        pc += 5;

        write_u32(view, ctx_off + VM_CTX_UDF_ID, udf_id);
        write_u32(view, ctx_off + VM_CTX_UDF_START_REG, start_arg_reg);
        write_u32(view, ctx_off + VM_CTX_UDF_NUM_ARGS, num_args);
        write_u32(view, ctx_off + VM_CTX_UDF_DEST_REG, dest_reg);
        write_u32(view, ctx_off + VM_CTX_PC, pc);
        write_i32(view, ctx_off + VM_CTX_STATUS, VM_STATUS_HOST_UDF);
        return VM_STATUS_HOST_UDF;
      }

      case OpCode.OP_STR_LOWER: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        vm_str_lower(
          view,
          ctx_off,
          arena_base,
          vm_reg_off(ctx_off, src_reg),
          vm_reg_off(ctx_off, dest_reg),
        );
        break;
      }

      case OpCode.OP_STR_UPPER: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        vm_str_upper(
          view,
          ctx_off,
          arena_base,
          vm_reg_off(ctx_off, src_reg),
          vm_reg_off(ctx_off, dest_reg),
        );
        break;
      }

      case OpCode.OP_STR_LENGTH: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
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
        const src_reg: u32 = read_u8(view, code_off + pc);
        const start_reg: u32 = read_u8(view, code_off + pc + 1);
        const len_reg: u32 = read_u8(view, code_off + pc + 2);
        const dest_reg: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;
        vm_utf8_substr(
          view,
          vm_reg_off(ctx_off, src_reg),
          vm_reg_off(ctx_off, start_reg),
          vm_reg_off(ctx_off, len_reg),
          vm_reg_off(ctx_off, dest_reg),
        );
        break;
      }

      case OpCode.OP_STR_TRIM: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        vm_str_trim(
          view,
          vm_reg_off(ctx_off, src_reg),
          vm_reg_off(ctx_off, dest_reg),
        );
        break;
      }

      case OpCode.OP_MATH_ABS: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
          vm_reg_set_null(view, dst_off);
        } else {
          vm_reg_set_f64(
            view,
            dst_off,
            vm_math_abs(read_f64(view, src_off + VM_REG_F64)),
          );
        }
        break;
      }

      case OpCode.OP_MATH_ROUND: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
          vm_reg_set_null(view, dst_off);
        } else {
          vm_reg_set_f64(
            view,
            dst_off,
            vm_math_round(read_f64(view, src_off + VM_REG_F64)),
          );
        }
        break;
      }

      case OpCode.OP_RESULT_ROW: {
        const start_reg: u32 = read_u8(view, code_off + pc);
        const num_cols: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;

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
        const sorter_id: u32 = read_u8(view, code_off + pc);
        const key_info_idx: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;

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
        const sorter_id: u32 = read_u8(view, code_off + pc);
        const start_reg: u32 = read_u8(view, code_off + pc + 1);
        const num_keys: u32 = read_u8(view, code_off + pc + 2);
        const cursor_idx: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;

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
        const sorter_id: u32 = read_u8(view, code_off + pc);
        pc += 1;

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
        const sorter_id: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
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

      case OpCode.OP_MATH_FLOOR: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
          vm_reg_set_null(view, dst_off);
        } else {
          vm_reg_set_f64(
            view,
            dst_off,
            vm_math_floor(read_f64(view, src_off + VM_REG_F64)),
          );
        }
        break;
      }

      case OpCode.OP_MATH_CEIL: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        const src_off: u32 = vm_reg_off(ctx_off, src_reg);
        const dst_off: u32 = vm_reg_off(ctx_off, dest_reg);
        if (read_u8(view, src_off + VM_REG_IS_NULL) !== 0) {
          vm_reg_set_null(view, dst_off);
        } else {
          vm_reg_set_f64(
            view,
            dst_off,
            vm_math_ceil(read_f64(view, src_off + VM_REG_F64)),
          );
        }
        break;
      }

      case OpCode.OP_ADD: {
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        const off_a: u32 = vm_reg_off(ctx_off, reg_a);
        const off_b: u32 = vm_reg_off(ctx_off, reg_b);
        const off_d: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, off_a + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, off_b + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, off_d);
        } else {
          vm_reg_set_f64(
            view,
            off_d,
            read_f64(view, off_a + VM_REG_F64) +
              read_f64(view, off_b + VM_REG_F64),
          );
        }
        break;
      }

      case OpCode.OP_SUB: {
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        const off_a: u32 = vm_reg_off(ctx_off, reg_a);
        const off_b: u32 = vm_reg_off(ctx_off, reg_b);
        const off_d: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, off_a + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, off_b + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, off_d);
        } else {
          vm_reg_set_f64(
            view,
            off_d,
            read_f64(view, off_a + VM_REG_F64) -
              read_f64(view, off_b + VM_REG_F64),
          );
        }
        break;
      }

      case OpCode.OP_MUL: {
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        const off_a: u32 = vm_reg_off(ctx_off, reg_a);
        const off_b: u32 = vm_reg_off(ctx_off, reg_b);
        const off_d: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, off_a + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, off_b + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, off_d);
        } else {
          vm_reg_set_f64(
            view,
            off_d,
            read_f64(view, off_a + VM_REG_F64) *
              read_f64(view, off_b + VM_REG_F64),
          );
        }
        break;
      }

      case OpCode.OP_DIV: {
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        const off_a: u32 = vm_reg_off(ctx_off, reg_a);
        const off_b: u32 = vm_reg_off(ctx_off, reg_b);
        const off_d: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, off_a + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, off_b + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, off_d);
        } else {
          const denom: f64 = read_f64(view, off_b + VM_REG_F64);
          if (denom === 0.0) {
            vm_reg_set_null(view, off_d);
          } else {
            vm_reg_set_f64(
              view,
              off_d,
              read_f64(view, off_a + VM_REG_F64) / denom,
            );
          }
        }
        break;
      }

      case OpCode.OP_MOD: {
        const reg_a: u32 = read_u8(view, code_off + pc);
        const reg_b: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        const off_a: u32 = vm_reg_off(ctx_off, reg_a);
        const off_b: u32 = vm_reg_off(ctx_off, reg_b);
        const off_d: u32 = vm_reg_off(ctx_off, dest_reg);
        if (
          read_u8(view, off_a + VM_REG_IS_NULL) !== 0 ||
          read_u8(view, off_b + VM_REG_IS_NULL) !== 0
        ) {
          vm_reg_set_null(view, off_d);
        } else {
          const denom: f64 = read_f64(view, off_b + VM_REG_F64);
          if (denom === 0.0) {
            vm_reg_set_null(view, off_d);
          } else {
            const num: f64 = read_f64(view, off_a + VM_REG_F64);
            const q: f64 = Math.trunc(num / denom);
            vm_reg_set_f64(view, off_d, num - q * denom);
          }
        }
        break;
      }

      case OpCode.OP_STR_CONCAT: {
        const start_reg: u32 = read_u8(view, code_off + pc);
        const num_regs: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
        vm_str_concat(view, ctx_off, arena_base, start_reg, num_regs, dest_reg);
        break;
      }

      case OpCode.OP_COALESCE: {
        const start_reg: u32 = read_u8(view, code_off + pc);
        const num_regs: u32 = read_u8(view, code_off + pc + 1);
        const dest_reg: u32 = read_u8(view, code_off + pc + 2);
        pc += 3;
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
        break;
      }

      case OpCode.OP_COPY: {
        const src_reg: u32 = read_u8(view, code_off + pc);
        const dest_reg: u32 = read_u8(view, code_off + pc + 1);
        pc += 2;
        vm_reg_copy(
          view,
          vm_reg_off(ctx_off, dest_reg),
          vm_reg_off(ctx_off, src_reg),
        );
        break;
      }

      case OpCode.OP_AGG_INIT: {
        const agg_id: u32 = read_u8(view, code_off + pc);
        const start_key_reg: u32 = read_u8(view, code_off + pc + 1);
        const num_keys: u32 = read_u8(view, code_off + pc + 2);
        const mode: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;

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
        const agg_id: u32 = read_u8(view, code_off + pc);
        const start_key_reg: u32 = read_u8(view, code_off + pc + 1);
        const num_keys: u32 = read_u8(view, code_off + pc + 2);
        const val_reg: u32 = read_u8(view, code_off + pc + 3);
        const raw_func_id: u32 = read_u8(view, code_off + pc + 4);
        pc += 5;

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
        const agg_id: u32 = read_u8(view, code_off + pc);
        const out_key_reg: u32 = read_u8(view, code_off + pc + 1);
        const out_acc_reg: u32 = read_u8(view, code_off + pc + 2);
        const jump_target: u32 = read_u16(view, code_off + pc + 3);
        pc += 5;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
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
        const sum_reg: u32 = read_u8(view, code_off + pc);
        const count_reg: u32 = read_u8(view, code_off + pc + 1);
        const out_reg: u32 = read_u8(view, code_off + pc + 2);
        const raw_func_id: u32 = read_u8(view, code_off + pc + 3);
        pc += 4;

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

      case OpCode.OP_REG_IS_NULL: {
        const reg: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        if (read_u8(view, vm_reg_off(ctx_off, reg) + VM_REG_IS_NULL) !== 0) {
          pc = jump_target;
        }
        break;
      }

      case OpCode.OP_REG_IS_NOT_NULL: {
        const reg: u32 = read_u8(view, code_off + pc);
        const jump_target: u32 = read_u16(view, code_off + pc + 1);
        pc += 3;

        if (jump_target > code_len) {
          write_u32(view, ctx_off + VM_CTX_PC, pc);
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
          return VmStatus.INVALID_BYTECODE;
        }

        if (read_u8(view, vm_reg_off(ctx_off, reg) + VM_REG_IS_NULL) === 0) {
          pc = jump_target;
        }
        break;
      }

      default:
        write_u32(view, ctx_off + VM_CTX_PC, pc);
        write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
        return VmStatus.INVALID_BYTECODE;
    }
  }

  write_u32(view, ctx_off + VM_CTX_PC, pc);
  write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.DONE);
  return VmStatus.DONE;
}

// ============================================================================
// 2. Host-Boundary Marshaling for JS & WASM Execution
// ============================================================================

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

function writeValueToSlot(
  view: DataView,
  ctx_off: number,
  arena_base: number,
  slot_off: number,
  val: any,
): void {
  if (val === null || val === undefined) {
    vm_reg_set_null(view, slot_off);
  } else if (typeof val === "boolean") {
    vm_reg_set_i32(view, slot_off, val ? 1 : 0);
  } else if (typeof val === "number") {
    if (Number.isInteger(val) && val >= -2147483648 && val <= 2147483647) {
      vm_reg_set_i32(view, slot_off, val);
    } else {
      vm_reg_set_f64(view, slot_off, val);
    }
  } else if (typeof val === "bigint") {
    vm_reg_set_i64(view, slot_off, val);
  } else if (typeof val === "string") {
    const bytes = text_encoder.encode(val);
    if (bytes.byteLength === 0) {
      vm_reg_set_slice(view, slot_off, DataType.TEXT, 0, 0);
    } else {
      const dst = vm_phys_alloc(view, ctx_off, arena_base, bytes.byteLength);
      new Uint8Array(view.buffer, view.byteOffset + dst, bytes.byteLength).set(
        bytes,
      );
      vm_reg_set_slice(view, slot_off, DataType.TEXT, dst, bytes.byteLength);
    }
  } else if (val instanceof Uint8Array) {
    if (val.byteLength === 0) {
      vm_reg_set_slice(view, slot_off, DataType.BLOB, 0, 0);
    } else {
      const dst = vm_phys_alloc(view, ctx_off, arena_base, val.byteLength);
      new Uint8Array(view.buffer, view.byteOffset + dst, val.byteLength).set(
        val,
      );
      vm_reg_set_slice(view, slot_off, DataType.BLOB, dst, val.byteLength);
    }
  } else {
    vm_reg_set_null(view, slot_off);
  }
}

function readValueFromSlot(view: DataView, slot_off: number): any {
  if (read_u8(view, slot_off + VM_REG_IS_NULL) !== 0) {
    return null;
  }
  const r_type = read_u8(view, slot_off + VM_REG_TYPE);
  if (r_type === DataType.INT32) {
    return read_i32(view, slot_off + VM_REG_I32);
  }
  if (r_type === DataType.INT64) {
    return Number(read_i64(view, slot_off + VM_REG_I64));
  }
  if (r_type === DataType.FLOAT64) {
    return read_f64(view, slot_off + VM_REG_F64);
  }
  const d_off = read_u32(view, slot_off + VM_REG_DATA_OFF);
  const d_len = read_u32(view, slot_off + VM_REG_DATA_LEN);
  if (
    r_type === DataType.TEXT ||
    r_type === DataType.UUID ||
    r_type === DataType.ULID
  ) {
    if (d_len === 0) return "";
    return text_decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + d_off, d_len),
    );
  }
  if (r_type === DataType.BLOB) {
    const out = new Uint8Array(d_len);
    if (d_len > 0) {
      out.set(new Uint8Array(view.buffer, view.byteOffset + d_off, d_len));
    }
    return out;
  }
  return null;
}

export function executeVmStepWithRunner(
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array,
  runRaw: (
    activeView: DataView,
    ctxOff: number,
    codeOff: number,
    codeLen: number,
    arenaBase: number,
  ) => number,
  targetBuffer?: ArrayBuffer,
): VmStatus {
  let activeView = view;
  let needsCopyBack = false;

  if (targetBuffer) {
    if (view.buffer === targetBuffer && view.byteOffset === 0) {
      activeView =
        view.byteLength >= TRANSIENT_ARENA_OFFSET + 65536
          ? view
          : new DataView(targetBuffer);
    } else {
      activeView = new DataView(targetBuffer);
      const copyLen = Math.min(view.byteLength, VM_CONTEXT_OFFSET);
      new Uint8Array(targetBuffer, 0, copyLen).set(
        new Uint8Array(view.buffer, view.byteOffset, copyLen),
      );
      needsCopyBack = true;
    }
  } else if (
    view.byteLength < TRANSIENT_ARENA_OFFSET + 65536 ||
    view.byteOffset !== 0
  ) {
    const holder = executeVmStepWithRunner as any;
    if (!holder._fallbackBuffer || !holder._fallbackView) {
      holder._fallbackBuffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      holder._fallbackView = new DataView(holder._fallbackBuffer);
    }
    const copyLen = Math.min(view.byteLength, VM_CONTEXT_OFFSET);
    new Uint8Array(holder._fallbackBuffer, 0, copyLen).set(
      new Uint8Array(view.buffer, view.byteOffset, copyLen),
    );
    activeView = holder._fallbackView;
    needsCopyBack = true;
  }

  const ctx_off = VM_CONTEXT_OFFSET;
  const code_off = BYTECODE_OFFSET;
  const arena_base = TRANSIENT_ARENA_OFFSET;
  const meta = ctx as any;
  const fastHost = ctx._fastHostMode === true;

  if (
    meta._syncedResetId !== ctx._resetId ||
    meta._syncedBuffer !== activeView.buffer
  ) {
    // Zero header + registers + cursors (0..2504) and sorters + aggregators (7184..7440)
    memset(activeView, ctx_off, 0, VM_CTX_CURSORS_OFF + 384);
    memset(activeView, ctx_off + VM_CTX_SORTERS_OFF, 0, 256);
    for (let r = 0; r < 64; r++) {
      write_u8(
        activeView,
        ctx_off + VM_CTX_REGISTERS_OFF + (r << 5) + VM_REG_IS_NULL,
        1,
      );
    }
    if (!fastHost) {
      if (!meta._lastSyncedRegs) {
        meta._lastSyncedRegs = new Array(64).fill(null);
      } else {
        meta._lastSyncedRegs.fill(null);
      }
    }
    meta._syncedInSetsRef = null;
    meta._syncedResetId = ctx._resetId;
    meta._syncedBuffer = activeView.buffer;
  }

  if (needsCopyBack && ctx.resultOffset > 0) {
    const resEnd = RESULT_BUFFER_OFFSET + ctx.resultOffset;
    if (view.byteLength >= resEnd) {
      new Uint8Array(
        activeView.buffer,
        activeView.byteOffset + RESULT_BUFFER_OFFSET,
        ctx.resultOffset,
      ).set(
        new Uint8Array(
          view.buffer,
          view.byteOffset + RESULT_BUFFER_OFFSET,
          ctx.resultOffset,
        ),
      );
    }
  }

  const tables = ctx.tables ?? (ctx.table ? [ctx.table] : []);
  const num_tables = Math.min(tables.length, 16);
  write_u32(activeView, ctx_off + VM_CTX_NUM_TABLES, num_tables);
  for (let t = 0; t < num_tables; t++) {
    const tbl = tables[t] ?? tables[0];
    const tbl_off = ctx_off + VM_CTX_TABLES_OFF + t * VM_TABLE_DESC_SIZE;
    if (tbl) {
      const num_cols = Math.min(tbl.columns.length, 256);
      write_u16(activeView, tbl_off + 0, num_cols);
      write_u16(activeView, tbl_off + 2, Math.ceil(num_cols / 8));
      for (let c = 0; c < num_cols; c++) {
        write_u8(activeView, tbl_off + 4 + c, tbl.columns[c].type);
      }
    }
  }

  // Sync outputColumns descriptor
  const out_cols_off = ctx_off + VM_CTX_OUTPUT_COLS_OFF;
  if (ctx.outputColumns && ctx.outputColumns.length > 0) {
    const n_out = Math.min(ctx.outputColumns.length, 256);
    write_u8(activeView, out_cols_off + 0, 1);
    write_u16(activeView, out_cols_off + 2, n_out);
    for (let c = 0; c < n_out; c++) {
      write_u8(activeView, out_cols_off + 4 + c, ctx.outputColumns[c].type);
    }
  } else {
    write_u8(activeView, out_cols_off + 0, 0);
    write_u16(activeView, out_cols_off + 2, 0);
  }

  // Sync keyInfos descriptors
  const num_ki = Math.min(ctx.keyInfos?.length ?? 0, 8);
  write_u32(activeView, ctx_off + VM_CTX_NUM_KEY_INFOS, num_ki);
  for (let k = 0; k < num_ki; k++) {
    const ki = ctx.keyInfos[k];
    const ki_off = ctx_off + VM_CTX_KEY_INFOS_OFF + k * VM_KEY_INFO_SIZE;
    const nk = Math.min(ki.numKeys, 8);
    write_u8(activeView, ki_off + VM_KI_NUM_KEYS, nk);
    write_u8(activeView, ki_off + VM_KI_HAS_LIMIT, ki.limit !== undefined ? 1 : 0);
    write_u32(activeView, ki_off + VM_KI_LIMIT, ki.limit ?? 0);
    write_u32(activeView, ki_off + VM_KI_OFFSET, ki.offset ?? 0);
    for (let d = 0; d < nk; d++) {
      const dir = ki.directions[d] ?? 0;
      const null_ord = ki.nullOrders?.[d] ?? (dir === 1 ? 1 : 0);
      write_u8(activeView, ki_off + VM_KI_DIRECTIONS + d, dir);
      write_u8(activeView, ki_off + VM_KI_NULL_ORDERS + d, null_ord);
    }
  }

  // Sync inSets into arena if changed
  if (ctx.inSets && ctx.inSets.length > 0 && meta._syncedInSetsRef !== ctx.inSets) {
    const num_sets = Math.min(ctx.inSets.length, 16);
    write_u32(activeView, ctx_off + VM_CTX_NUM_IN_SETS, num_sets);
    for (let s = 0; s < num_sets; s++) {
      const set = ctx.inSets[s];
      const set_desc_off = ctx_off + VM_CTX_IN_SETS_OFF + s * 8;
      if (!set || set.size === 0) {
        write_u32(activeView, set_desc_off + 0, 0);
        write_u32(activeView, set_desc_off + 4, 0);
      } else {
        const items = Array.from(set);
        const items_off = vm_phys_alloc(
          activeView,
          ctx_off,
          arena_base,
          items.length * 32,
        );
        write_u32(activeView, set_desc_off + 0, items.length);
        write_u32(activeView, set_desc_off + 4, items_off);
        for (let idx = 0; idx < items.length; idx++) {
          writeValueToSlot(
            activeView,
            ctx_off,
            arena_base,
            items_off + idx * 32,
            items[idx],
          );
        }
      }
    }
    meta._syncedInSetsRef = ctx.inSets;
  }

  if (!fastHost) {
    // Sync cursors
    for (let c = 0; c < 16; c++) {
      const cur = (ctx.cursors && ctx.cursors[c]) ?? (c === 0 ? ctx.cursor : undefined);
      const cur_off = vm_cursor_off(ctx_off, c);
      if (cur) {
        write_u32(activeView, cur_off + VM_CUR_PAGE_ID, cur.pageId);
        write_u32(activeView, cur_off + VM_CUR_ROOT_PAGE_ID, cur.rootPageId ?? 0);
        write_i32(activeView, cur_off + VM_CUR_SLOT_IDX, cur.slotIdx);
        write_i32(activeView, cur_off + VM_CUR_CELL_IDX, cur.cellIdx);
        write_u32(activeView, cur_off + VM_CUR_ROW_OFFSET, cur.rowOffset);
      }
    }

    // Sync registers changed on host since last step
    const lastRegs: any[] = meta._lastSyncedRegs;
    for (let r = 0; r < 64; r++) {
      if (ctx.registers[r] !== lastRegs[r]) {
        writeValueToSlot(
          activeView,
          ctx_off,
          arena_base,
          vm_reg_off(ctx_off, r),
          ctx.registers[r],
        );
        lastRegs[r] = ctx.registers[r];
      }
    }
  }

  // Sync scalar header fields
  const has_buffer_pool =
    view.byteLength >= SLOT_TO_PAGE_OFFSET + 4 &&
    view.getUint32(SLOT_TO_PAGE_OFFSET, true) > 0
      ? 1
      : 0;
  write_u32(activeView, ctx_off + VM_CTX_PC, ctx.pc);
  write_i32(activeView, ctx_off + VM_CTX_STATUS, ctx.status);
  write_u32(activeView, ctx_off + VM_CTX_FAULT_PAGE_ID, ctx.fault_page_id);
  write_u32(activeView, ctx_off + VM_CTX_RESULT_COUNT, ctx.resultCount);
  write_u32(activeView, ctx_off + VM_CTX_RESULT_OFFSET, ctx.resultOffset);
  write_u32(activeView, ctx_off + VM_CTX_ARENA_OFFSET, ctx.arenaOffset);
  write_u32(activeView, ctx_off + VM_CTX_MAX_QUERY_MEMORY, ctx.maxQueryMemory);
  write_u32(activeView, ctx_off + VM_CTX_HAS_BUFFER_POOL, has_buffer_pool);

  // Copy bytecode into BYTECODE_OFFSET
  new Uint8Array(
    activeView.buffer,
    activeView.byteOffset + code_off,
    bytecode.byteLength,
  ).set(bytecode);

  let status = runRaw(
    activeView,
    ctx_off,
    code_off,
    bytecode.byteLength,
    arena_base,
  );

  while (status === VM_STATUS_HOST_UDF) {
    const udf_id = read_u32(activeView, ctx_off + VM_CTX_UDF_ID);
    const start_arg_reg = read_u32(activeView, ctx_off + VM_CTX_UDF_START_REG);
    const num_args = read_u32(activeView, ctx_off + VM_CTX_UDF_NUM_ARGS);
    const dest_reg = read_u32(activeView, ctx_off + VM_CTX_UDF_DEST_REG);

    const fn = ctx.udfs?.[udf_id];
    if (!fn) {
      status = VmStatus.INVALID_BYTECODE;
      write_i32(activeView, ctx_off + VM_CTX_STATUS, status);
      break;
    }

    const args: any[] = [];
    for (let a = 0; a < num_args; a++) {
      args.push(
        readValueFromSlot(activeView, vm_reg_off(ctx_off, start_arg_reg + a)),
      );
    }

    try {
      const res = fn(...args);
      writeValueToSlot(
        activeView,
        ctx_off,
        arena_base,
        vm_reg_off(ctx_off, dest_reg),
        res,
      );
      write_i32(activeView, ctx_off + VM_CTX_STATUS, VmStatus.RUNNING);
      status = runRaw(
        activeView,
        ctx_off,
        code_off,
        bytecode.byteLength,
        arena_base,
      );
    } catch {
      status = VmStatus.ERROR;
      write_i32(activeView, ctx_off + VM_CTX_STATUS, status);
      break;
    }
  }

  // Sync back scalar fields
  ctx.pc = read_u32(activeView, ctx_off + VM_CTX_PC);
  ctx.status = status as VmStatus;
  ctx.resultCount = read_u32(activeView, ctx_off + VM_CTX_RESULT_COUNT);
  ctx.resultOffset = read_u32(activeView, ctx_off + VM_CTX_RESULT_OFFSET);
  ctx.arenaOffset = read_u32(activeView, ctx_off + VM_CTX_ARENA_OFFSET);

  if (fastHost) {
    if (status === VmStatus.PAGE_FAULT) {
      ctx.fault_page_id = read_u32(activeView, ctx_off + VM_CTX_FAULT_PAGE_ID);
      for (let c = 0; c < 16; c++) {
        const cur = ctx.cursors[c];
        if (cur) {
          cur.pageId = read_u32(
            activeView,
            vm_cursor_off(ctx_off, c) + VM_CUR_PAGE_ID,
          );
        }
      }
    }
  } else {
    ctx.fault_page_id = read_u32(activeView, ctx_off + VM_CTX_FAULT_PAGE_ID);

    // Sync back cursors
    for (let c = 0; c < 16; c++) {
      const cur_off = vm_cursor_off(ctx_off, c);
      const cur = ctx.cursors[c];
      if (cur) {
        cur.pageId = read_u32(activeView, cur_off + VM_CUR_PAGE_ID);
        cur.rootPageId = read_u32(activeView, cur_off + VM_CUR_ROOT_PAGE_ID);
        cur.slotIdx = read_i32(activeView, cur_off + VM_CUR_SLOT_IDX);
        cur.cellIdx = read_i32(activeView, cur_off + VM_CUR_CELL_IDX);
        cur.rowOffset = read_u32(activeView, cur_off + VM_CUR_ROW_OFFSET);
      }
    }
    if (ctx.cursor && ctx.cursors && ctx.cursor !== ctx.cursors[0]) {
      Object.assign(ctx.cursor, ctx.cursors[0]);
    }

    // Sync back registers
    const lastRegs: any[] = meta._lastSyncedRegs;
    for (let r = 0; r < 64; r++) {
      const val = readValueFromSlot(activeView, vm_reg_off(ctx_off, r));
      ctx.registers[r] = val;
      lastRegs[r] = val;
    }

    // Sync back aggregator metadata in-place
    for (let a = 0; a < 4; a++) {
      const agg_off = ctx_off + VM_CTX_AGGS_OFF + a * VM_AGG_SIZE;
      if (read_u8(activeView, agg_off + VM_AGG_IS_OPEN) !== 0) {
        const cap = read_u32(activeView, agg_off + VM_AGG_CAPACITY);
        const occ = read_u32(activeView, agg_off + VM_AGG_OCCUPIED);
        const rIdx = read_u32(activeView, agg_off + VM_AGG_READ_IDX);
        if (ctx.aggregators[a]) {
          ctx.aggregators[a].capacity = cap;
          ctx.aggregators[a].occupiedCount = occ;
          ctx.aggregators[a].readIdx = rIdx;
        } else {
          ctx.aggregators[a] = {
            mode: read_u8(activeView, agg_off + VM_AGG_MODE),
            startKeyReg: read_u8(activeView, agg_off + VM_AGG_START_KEY_REG),
            numKeys: read_u8(activeView, agg_off + VM_AGG_NUM_KEYS),
            capacity: cap,
            occupiedCount: occ,
            readIdx: rIdx,
            buckets: [],
            currentBucket: null,
          };
        }
      }
    }
  }

  if (needsCopyBack && ctx.resultOffset > 0) {
    const resEnd = RESULT_BUFFER_OFFSET + ctx.resultOffset;
    if (view.byteLength >= resEnd) {
      new Uint8Array(
        view.buffer,
        view.byteOffset + RESULT_BUFFER_OFFSET,
        ctx.resultOffset,
      ).set(
        new Uint8Array(
          activeView.buffer,
          activeView.byteOffset + RESULT_BUFFER_OFFSET,
          ctx.resultOffset,
        ),
      );
    }
  }

  return status as VmStatus;
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
