/**
 * WebDB C Core Engine - Virtual Machine Header
 */

#ifndef WEBDB_VM_H
#define WEBDB_VM_H

#include "webdb_types.h"
#include "vm_helpers.h"

// Context cursor struct in C
typedef struct {
  uint32_t page_id;
  uint32_t root_page_id;
  uint32_t slot_idx;
  uint32_t cell_idx;
  uint32_t row_offset;
  uint32_t btree_depth;
  uint32_t flags;
} C_VmCursor;

// C VM Execution Context State
typedef struct {
  uint32_t pc;
  uint32_t status;
  uint32_t fault_page_id;
  uint32_t result_count;
  uint32_t result_offset;
  uint32_t arena_offset;
  uint32_t rows_affected;
  C_VmCursor cursors[16];
} C_VmContext;

WEBDB_EXPORT int32_t vm_step_raw(
  uint8_t *mem,
  uint32_t ctx_offset,
  const uint8_t *bytecode,
  uint32_t code_len
);

#endif /* WEBDB_VM_H */
