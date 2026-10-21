/**
 * WebDB C Core Engine - Buffer Pool Implementation
 */

#include "buffer_pool.h"
#include "page_table.h"

#define BP_MEM(offset) ((uint8_t *)(uintptr_t)(offset))
#define SLOT_MAP(offset) ((uint32_t *)(uintptr_t)(offset))

uint32_t buf_pool_get_slot_offset(uint32_t slot_idx) {
  return slot_idx * PAGE_SIZE;
}

uint32_t buf_pool_read_slot_to_page(uint32_t slot_to_page_offset, uint32_t slot_idx) {
  return SLOT_MAP(slot_to_page_offset)[slot_idx];
}

void buf_pool_write_slot_to_page(uint32_t slot_to_page_offset, uint32_t slot_idx, uint32_t page_id) {
  SLOT_MAP(slot_to_page_offset)[slot_idx] = page_id;
}

int32_t buf_pool_get_resident_slot(uint32_t page_to_slot_offset, uint32_t page_to_slot_buckets, uint32_t page_id) {
  return page_table_get(page_to_slot_offset, page_to_slot_buckets, page_id);
}

int32_t buf_pool_assign_slot(
  uint32_t slot_to_page_offset,
  uint32_t page_to_slot_offset,
  uint32_t page_to_slot_buckets,
  uint32_t slot_idx,
  uint32_t page_id
) {
  uint32_t *slot_to_page = SLOT_MAP(slot_to_page_offset);
  uint32_t old_page_id = slot_to_page[slot_idx];
  if (old_page_id > 0) {
    page_table_delete(page_to_slot_offset, page_to_slot_buckets, old_page_id);
  }

  slot_to_page[slot_idx] = page_id;
  return page_table_set(page_to_slot_offset, page_to_slot_buckets, page_id, slot_idx);
}

int32_t buf_pool_unassign_slot(
  uint32_t slot_to_page_offset,
  uint32_t page_to_slot_offset,
  uint32_t page_to_slot_buckets,
  uint32_t slot_idx
) {
  uint32_t *slot_to_page = SLOT_MAP(slot_to_page_offset);
  uint32_t old_page_id = slot_to_page[slot_idx];
  if (old_page_id > 0) {
    page_table_delete(page_to_slot_offset, page_to_slot_buckets, old_page_id);
    slot_to_page[slot_idx] = 0;
    return 1;
  }
  return 0;
}

void buf_pool_mark_dirty(uint32_t dirty_mask_offset, uint32_t slot_idx) {
  set_bit(BP_MEM(dirty_mask_offset), slot_idx);
}

void buf_pool_clear_dirty(uint32_t dirty_mask_offset, uint32_t slot_idx) {
  clear_bit(BP_MEM(dirty_mask_offset), slot_idx);
}

int32_t buf_pool_is_dirty(uint32_t dirty_mask_offset, uint32_t slot_idx) {
  return get_bit(BP_MEM(dirty_mask_offset), slot_idx);
}
