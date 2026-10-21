/**
 * WebDB C Core Engine - Virtual Machine Implementation
 */

#include "vm.h"
#include "page.h"
#include "buffer_pool.h"

#define MAX_CYCLES 10000000

int32_t vm_step_raw(
  uint8_t *mem,
  uint32_t ctx_offset,
  const uint8_t *bytecode,
  uint32_t code_len
) {
  if (!mem || !bytecode) return VM_STATUS_ERROR;

  C_VmContext *ctx = (C_VmContext *)(mem + ctx_offset);
  uint32_t cycles = 0;

  int has_buffer_pool = (load_u32(mem + SLOT_TO_PAGE_OFFSET) > 0);

  while (ctx->pc < code_len) {
    if (++cycles > MAX_CYCLES) {
      ctx->status = VM_STATUS_TIMEOUT;
      return VM_STATUS_TIMEOUT;
    }

    uint32_t instr_pc = ctx->pc;
    uint8_t op = bytecode[ctx->pc++];

    switch (op) {
      case OP_HALT: {
        ctx->arena_offset = 0;
        ctx->status = VM_STATUS_DONE;
        return VM_STATUS_DONE;
      }

      case OP_OPEN_CURSOR: {
        uint8_t cursor_idx = bytecode[ctx->pc++];
        uint32_t root_page_id = load_u32(bytecode + ctx->pc);
        ctx->pc += 4;

        if (cursor_idx < 16) {
          ctx->cursors[cursor_idx].page_id = root_page_id;
          ctx->cursors[cursor_idx].cell_idx = 0;
          ctx->cursors[cursor_idx].row_offset = 0;

          if (has_buffer_pool && root_page_id > 0) {
            int32_t slot = buf_pool_get_resident_slot(PAGE_TO_SLOT_OFFSET, DEFAULT_PAGE_TO_SLOT_BUCKETS, root_page_id);
            if (slot < 0) {
              ctx->fault_page_id = root_page_id;
              ctx->status = VM_STATUS_PAGE_FAULT;
              ctx->pc = instr_pc;
              return VM_STATUS_PAGE_FAULT;
            }
            ctx->cursors[cursor_idx].slot_idx = (uint32_t)slot;
          }
        }
        break;
      }

      case OP_REWIND: {
        uint8_t cursor_idx = bytecode[ctx->pc++];
        uint16_t jump_target = load_u16(bytecode + ctx->pc);
        ctx->pc += 2;

        if (jump_target > code_len) {
          ctx->status = VM_STATUS_INVALID_BYTECODE;
          return VM_STATUS_INVALID_BYTECODE;
        }

        if (cursor_idx < 16) {
          uint32_t page_id = ctx->cursors[cursor_idx].page_id;
          if (has_buffer_pool && page_id > 0) {
            int32_t slot = buf_pool_get_resident_slot(PAGE_TO_SLOT_OFFSET, DEFAULT_PAGE_TO_SLOT_BUCKETS, page_id);
            if (slot < 0) {
              ctx->fault_page_id = page_id;
              ctx->status = VM_STATUS_PAGE_FAULT;
              ctx->pc = instr_pc;
              return VM_STATUS_PAGE_FAULT;
            }
            ctx->cursors[cursor_idx].slot_idx = (uint32_t)slot;
          }

          uint32_t page_offset = (page_id > 0) ? (page_id - 1) * PAGE_SIZE : 0;
          if (has_buffer_pool && page_id > 0) {
            int32_t s = buf_pool_get_resident_slot(PAGE_TO_SLOT_OFFSET, DEFAULT_PAGE_TO_SLOT_BUCKETS, page_id);
            if (s >= 0) page_offset = (uint32_t)s * PAGE_SIZE;
          }

          uint16_t cell_count = page_get_cell_count(page_offset);
          if (cell_count == 0) {
            ctx->pc = jump_target;
          } else {
            ctx->cursors[cursor_idx].cell_idx = 0;
            uint16_t rel_cell_offset = page_get_cell_offset(page_offset, 0);
            ctx->cursors[cursor_idx].row_offset = page_offset + rel_cell_offset;
          }
        }
        break;
      }

      case OP_NEXT_ROW: {
        uint8_t cursor_idx = bytecode[ctx->pc++];
        uint16_t jump_target = load_u16(bytecode + ctx->pc);
        ctx->pc += 2;

        if (cursor_idx < 16) {
          uint32_t page_id = ctx->cursors[cursor_idx].page_id;
          uint32_t page_offset = (page_id > 0) ? (page_id - 1) * PAGE_SIZE : 0;
          if (has_buffer_pool && page_id > 0) {
            int32_t s = buf_pool_get_resident_slot(PAGE_TO_SLOT_OFFSET, DEFAULT_PAGE_TO_SLOT_BUCKETS, page_id);
            if (s >= 0) page_offset = (uint32_t)s * PAGE_SIZE;
          }

          uint16_t cell_count = page_get_cell_count(page_offset);
          ctx->cursors[cursor_idx].cell_idx++;

          if (ctx->cursors[cursor_idx].cell_idx < cell_count) {
            uint16_t rel_cell_offset = page_get_cell_offset(page_offset, ctx->cursors[cursor_idx].cell_idx);
            ctx->cursors[cursor_idx].row_offset = page_offset + rel_cell_offset;
          } else {
            uint32_t next_page_id = page_get_next_page_id(page_offset);
            if (next_page_id == 0) {
              ctx->pc = jump_target; // EOF
            } else {
              if (has_buffer_pool) {
                int32_t slot = buf_pool_get_resident_slot(PAGE_TO_SLOT_OFFSET, DEFAULT_PAGE_TO_SLOT_BUCKETS, next_page_id);
                if (slot < 0) {
                  ctx->fault_page_id = next_page_id;
                  ctx->status = VM_STATUS_PAGE_FAULT;
                  ctx->pc = instr_pc;
                  return VM_STATUS_PAGE_FAULT;
                }
                ctx->cursors[cursor_idx].slot_idx = (uint32_t)slot;
              }
              ctx->cursors[cursor_idx].page_id = next_page_id;
              ctx->cursors[cursor_idx].cell_idx = 0;

              uint32_t next_offset = (next_page_id - 1) * PAGE_SIZE;
              if (has_buffer_pool) {
                int32_t s = buf_pool_get_resident_slot(PAGE_TO_SLOT_OFFSET, DEFAULT_PAGE_TO_SLOT_BUCKETS, next_page_id);
                if (s >= 0) next_offset = (uint32_t)s * PAGE_SIZE;
              }
              uint16_t rel_cell_offset = page_get_cell_offset(next_offset, 0);
              ctx->cursors[cursor_idx].row_offset = next_offset + rel_cell_offset;
            }
          }
        }
        break;
      }

      case OP_JUMP: {
        uint16_t target = load_u16(bytecode + ctx->pc);
        ctx->pc += 2;
        ctx->pc = target;
        break;
      }

      default:
        break;
    }
  }

  ctx->status = VM_STATUS_DONE;
  return VM_STATUS_DONE;
}
