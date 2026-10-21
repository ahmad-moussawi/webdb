/**
 * WebDB C Core Engine - Slotted Page & B-Tree Node Operations
 */

#ifndef WEBDB_PAGE_H
#define WEBDB_PAGE_H

#include "webdb_types.h"

// 1. Page Header Accessors
WEBDB_EXPORT void page_init(uint32_t page_offset, uint8_t page_type, uint32_t next_page_id);
WEBDB_EXPORT void page_init_free(uint32_t page_offset, uint32_t next_free_page_id);
WEBDB_EXPORT uint8_t page_get_type(uint32_t page_offset);
WEBDB_EXPORT void page_set_type(uint32_t page_offset, uint8_t type);
WEBDB_EXPORT uint16_t page_get_cell_count(uint32_t page_offset);
WEBDB_EXPORT void page_set_cell_count(uint32_t page_offset, uint16_t count);
WEBDB_EXPORT uint16_t page_get_cell_content_offset(uint32_t page_offset);
WEBDB_EXPORT void page_set_cell_content_offset(uint32_t page_offset, uint16_t offset);
WEBDB_EXPORT uint32_t page_get_next_page_id(uint32_t page_offset);
WEBDB_EXPORT void page_set_next_page_id(uint32_t page_offset, uint32_t next_page_id);
WEBDB_EXPORT uint16_t page_get_free_bytes(uint32_t page_offset);
WEBDB_EXPORT void page_set_free_bytes(uint32_t page_offset, uint16_t free_bytes);
WEBDB_EXPORT uint32_t page_get_checksum(uint32_t page_offset);
WEBDB_EXPORT void page_set_checksum(uint32_t page_offset, uint32_t checksum);
WEBDB_EXPORT uint16_t page_get_cell_offset(uint32_t page_offset, uint16_t slot_idx);
WEBDB_EXPORT void page_set_cell_offset(uint32_t page_offset, uint16_t slot_idx, uint16_t cell_offset);

// 2. Free Space & Compaction
WEBDB_EXPORT uint16_t page_get_contiguous_free_space(uint32_t page_offset);
WEBDB_EXPORT uint16_t page_get_total_free_space(uint32_t page_offset);
WEBDB_EXPORT void page_compact(uint32_t page_offset, uint32_t scratchpad_offset);

// 3. Row Insert, Delete, Update
WEBDB_EXPORT uint16_t page_get_row_length(uint32_t row_abs_offset);
WEBDB_EXPORT void page_delete_row(uint32_t page_offset, uint16_t cell_idx);

// 4. B-Tree Table Interior
WEBDB_EXPORT void page_init_interior(uint32_t page_offset, uint32_t right_child_page_id);
WEBDB_EXPORT uint32_t page_get_right_child_page_id(uint32_t page_offset);
WEBDB_EXPORT void page_set_right_child_page_id(uint32_t page_offset, uint32_t right_child_page_id);
WEBDB_EXPORT int32_t page_insert_interior_cell(uint32_t page_offset, uint32_t child_page_id, int64_t rowid);
WEBDB_EXPORT uint32_t page_binary_search_interior(uint32_t page_offset, int64_t target_row_id);
WEBDB_EXPORT int32_t page_split_interior(
  uint32_t page_offset,
  uint32_t new_page_offset,
  int64_t *out_median_rowid,
  uint32_t *out_promoted_child,
  uint32_t *out_right_child
);

// 5. Secondary Index Leaf
WEBDB_EXPORT void page_init_index_leaf(uint32_t page_offset, uint32_t next_page_id);
WEBDB_EXPORT int32_t page_compare_index_raw_keys(
  uint8_t type_a,
  const uint8_t *data_a,
  uint16_t len_a,
  int64_t rowid_a,
  uint8_t type_b,
  const uint8_t *data_b,
  uint16_t len_b,
  int64_t rowid_b
);
WEBDB_EXPORT int32_t page_insert_index_leaf_cell_raw(
  uint32_t page_offset,
  uint8_t key_type,
  const uint8_t *key_bytes,
  uint16_t key_len,
  int64_t rowid,
  uint32_t scratchpad_offset
);
WEBDB_EXPORT int32_t page_binary_search_index_leaf_raw(
  uint32_t page_offset,
  uint8_t target_type,
  const uint8_t *target_bytes,
  uint16_t target_len,
  int64_t target_row_id,
  int32_t match_row_id,
  int32_t *out_found
);

#endif /* WEBDB_PAGE_H */
