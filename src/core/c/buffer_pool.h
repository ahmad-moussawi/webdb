#ifndef WEBDB_BUFFER_POOL_H
#define WEBDB_BUFFER_POOL_H

#include "webdb_types.h"

typedef struct {
  int32_t slotCount;
  uint32_t maxQueryMemory;
  void * vfs;
} BufferPoolOptions;

WEBDB_EXPORT uint32_t buf_pool_get_slot_offset(uint32_t slot_idx);
WEBDB_EXPORT uint32_t buf_pool_read_slot_to_page(uint32_t slot_to_page_offset, uint32_t slot_idx);
WEBDB_EXPORT void buf_pool_write_slot_to_page(uint32_t slot_to_page_offset, uint32_t slot_idx, uint32_t page_id);
WEBDB_EXPORT int32_t buf_pool_get_resident_slot(uint32_t page_to_slot_offset, uint32_t page_to_slot_buckets, uint32_t page_id);
WEBDB_EXPORT int32_t buf_pool_assign_slot(uint32_t slot_to_page_offset, uint32_t page_to_slot_offset, uint32_t page_to_slot_buckets, uint32_t slot_idx, uint32_t page_id);
WEBDB_EXPORT int32_t buf_pool_unassign_slot(uint32_t slot_to_page_offset, uint32_t page_to_slot_offset, uint32_t page_to_slot_buckets, uint32_t slot_idx);
WEBDB_EXPORT void buf_pool_mark_dirty(uint32_t dirty_mask_offset, uint32_t slot_idx);
WEBDB_EXPORT void buf_pool_clear_dirty(uint32_t dirty_mask_offset, uint32_t slot_idx);
WEBDB_EXPORT int32_t buf_pool_is_dirty(uint32_t dirty_mask_offset, uint32_t slot_idx);

#endif // WEBDB_BUFFER_POOL_H
