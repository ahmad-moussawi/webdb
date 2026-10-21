/**
 * WebDB C Core Engine - Slotted Page Implementation
 */

#include "page.h"

#define P_MEM(offset) ((uint8_t *)(uintptr_t)(offset))
#define PAGE_HDR(offset) ((SlottedPageHeader *)(uintptr_t)(offset))
#define CELL_DIR(offset) ((uint16_t *)(uintptr_t)((offset) + PAGE_HEADER_SIZE))

// ============================================================================
// 1. Page Header Accessors
// ============================================================================

void page_init(uint32_t page_offset, uint8_t page_type, uint32_t next_page_id) {
  SlottedPageHeader *hdr = PAGE_HDR(page_offset);
  hdr->type = page_type;
  hdr->flags = 0;
  hdr->cell_count = 0;
  hdr->cell_content_offset = PAGE_SIZE;
  hdr->next_page_id = next_page_id;
  hdr->free_bytes = 0;
  hdr->checksum = 0;
}

void page_init_free(uint32_t page_offset, uint32_t next_free_page_id) {
  page_init(page_offset, PAGE_TYPE_FREE, next_free_page_id);
  PAGE_HDR(page_offset)->cell_content_offset = 0;
}

uint8_t page_get_type(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->type;
}

void page_set_type(uint32_t page_offset, uint8_t type) {
  PAGE_HDR(page_offset)->type = type;
}

uint16_t page_get_cell_count(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->cell_count;
}

void page_set_cell_count(uint32_t page_offset, uint16_t count) {
  PAGE_HDR(page_offset)->cell_count = count;
}

uint16_t page_get_cell_content_offset(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->cell_content_offset;
}

void page_set_cell_content_offset(uint32_t page_offset, uint16_t offset) {
  PAGE_HDR(page_offset)->cell_content_offset = offset;
}

uint32_t page_get_next_page_id(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->next_page_id;
}

void page_set_next_page_id(uint32_t page_offset, uint32_t next_page_id) {
  PAGE_HDR(page_offset)->next_page_id = next_page_id;
}

uint16_t page_get_free_bytes(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->free_bytes;
}

void page_set_free_bytes(uint32_t page_offset, uint16_t free_bytes) {
  PAGE_HDR(page_offset)->free_bytes = free_bytes;
}

uint32_t page_get_checksum(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->checksum;
}

void page_set_checksum(uint32_t page_offset, uint32_t checksum) {
  PAGE_HDR(page_offset)->checksum = checksum;
}

uint16_t page_get_cell_offset(uint32_t page_offset, uint16_t slot_idx) {
  return CELL_DIR(page_offset)[slot_idx];
}

void page_set_cell_offset(uint32_t page_offset, uint16_t slot_idx, uint16_t cell_offset) {
  CELL_DIR(page_offset)[slot_idx] = cell_offset;
}

// ============================================================================
// 2. Free Space & Compaction
// ============================================================================

uint16_t page_get_contiguous_free_space(uint32_t page_offset) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  uint16_t cell_content_offset = page_get_cell_content_offset(page_offset);
  uint16_t slot_dir_end = (uint16_t)(PAGE_HEADER_SIZE + cell_count * 2);
  if (cell_content_offset < slot_dir_end) return 0;
  return cell_content_offset - slot_dir_end;
}

uint16_t page_get_total_free_space(uint32_t page_offset) {
  return page_get_contiguous_free_space(page_offset) + page_get_free_bytes(page_offset);
}

uint16_t page_get_row_length(uint32_t row_abs_offset) {
  return load_u16(P_MEM(row_abs_offset) + 1);
}

void page_compact(uint32_t page_offset, uint32_t scratchpad_offset) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  if (cell_count == 0) {
    page_set_cell_content_offset(page_offset, PAGE_SIZE);
    page_set_free_bytes(page_offset, 0);
    return;
  }

  uint8_t local_buffer[PAGE_SIZE];
  uint8_t *scratch = (scratchpad_offset > 0) ? P_MEM(scratchpad_offset) : local_buffer;
  uint8_t *mem = P_MEM(page_offset);

  // 1. Copy page header to scratchpad
  webdb_memcpy(scratch, mem, PAGE_HEADER_SIZE);

  // 2. Repack cells from end of page (4096) downwards
  uint16_t current_offset = PAGE_SIZE;

  for (uint16_t i = 0; i < cell_count; i++) {
    uint16_t old_offset = page_get_cell_offset(page_offset, i);
    uint16_t len = page_get_row_length((uint32_t)(uintptr_t)(mem + old_offset));
    const uint8_t *src_bytes = mem + old_offset;

    current_offset -= len;
    webdb_memcpy(scratch + current_offset, src_bytes, len);

    // Update slot directory in scratchpad
    ((uint16_t *)(scratch + PAGE_HEADER_SIZE))[i] = current_offset;
  }

  // 3. Update scratchpad header fields
  ((SlottedPageHeader *)scratch)->cell_content_offset = current_offset;
  ((SlottedPageHeader *)scratch)->free_bytes = 0;

  // 4. Copy back to page
  webdb_memcpy(mem, scratch, PAGE_SIZE);
}

// ============================================================================
// 3. Row Delete
// ============================================================================

void page_delete_row(uint32_t page_offset, uint16_t cell_idx) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  if (cell_idx >= cell_count) return;

  uint8_t *mem = P_MEM(page_offset);
  uint16_t offset = page_get_cell_offset(page_offset, cell_idx);
  uint16_t row_len = page_get_row_length((uint32_t)(uintptr_t)(mem + offset));

  uint32_t slot_dir_start = PAGE_HEADER_SIZE;
  uint32_t dst = slot_dir_start + cell_idx * 2;
  uint32_t src = slot_dir_start + (cell_idx + 1) * 2;
  uint32_t shift_length = (cell_count - 1 - cell_idx) * 2;

  for (uint32_t k = 0; k < shift_length; k++) {
    mem[dst + k] = mem[src + k];
  }

  page_set_cell_count(page_offset, cell_count - 1);
  page_set_free_bytes(page_offset, page_get_free_bytes(page_offset) + row_len);
}

// ============================================================================
// 4. B-Tree Table Interior
// ============================================================================

void page_init_interior(uint32_t page_offset, uint32_t right_child_page_id) {
  page_init(page_offset, PAGE_TYPE_TABLE_INTERIOR, right_child_page_id);
}

uint32_t page_get_right_child_page_id(uint32_t page_offset) {
  return PAGE_HDR(page_offset)->next_page_id;
}

void page_set_right_child_page_id(uint32_t page_offset, uint32_t right_child_page_id) {
  PAGE_HDR(page_offset)->next_page_id = right_child_page_id;
}

int32_t page_insert_interior_cell(uint32_t page_offset, uint32_t child_page_id, int64_t rowid) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  if (cell_count >= MAX_TABLE_INTERIOR_CELLS) {
    return -1;
  }

  uint8_t *mem = P_MEM(page_offset);
  uint16_t content_offset = page_get_cell_content_offset(page_offset);
  uint16_t new_content_offset = content_offset - TABLE_INTERIOR_CELL_SIZE;

  store_u32(mem + new_content_offset, child_page_id);
  store_i64(mem + new_content_offset + 4, rowid);

  page_set_cell_offset(page_offset, cell_count, new_content_offset);
  page_set_cell_count(page_offset, cell_count + 1);
  page_set_cell_content_offset(page_offset, new_content_offset);

  return cell_count + 1;
}

uint32_t page_binary_search_interior(uint32_t page_offset, int64_t target_row_id) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  if (cell_count == 0) {
    return page_get_right_child_page_id(page_offset);
  }

  uint8_t *mem = P_MEM(page_offset);
  int32_t lo = 0;
  int32_t hi = cell_count - 1;
  int32_t candidate_child = -1;

  while (lo <= hi) {
    int32_t mid = (lo + hi) >> 1;
    uint16_t cell_offset = page_get_cell_offset(page_offset, (uint16_t)mid);
    int64_t cell_rowid = load_i64(mem + cell_offset + 4);

    if (target_row_id <= cell_rowid) {
      candidate_child = (int32_t)load_u32(mem + cell_offset);
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  if (candidate_child != -1) {
    return (uint32_t)candidate_child;
  }

  return page_get_right_child_page_id(page_offset);
}

int32_t page_split_interior(
  uint32_t page_offset,
  uint32_t new_page_offset,
  int64_t *out_median_rowid,
  uint32_t *out_promoted_child,
  uint32_t *out_right_child
) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  uint16_t median_idx = TABLE_INTERIOR_SPLIT_INDEX; // 145

  if (cell_count <= median_idx) {
    return -1;
  }

  uint8_t *mem = P_MEM(page_offset);
  uint16_t median_cell_offset = page_get_cell_offset(page_offset, median_idx);
  uint32_t promoted_child_page_id = load_u32(mem + median_cell_offset);
  int64_t median_rowid = load_i64(mem + median_cell_offset + 4);

  uint32_t old_right_child = page_get_right_child_page_id(page_offset);
  page_init_interior(new_page_offset, old_right_child);

  for (uint16_t i = median_idx + 1; i < cell_count; i++) {
    uint16_t offset = page_get_cell_offset(page_offset, i);
    uint32_t child_id = load_u32(mem + offset);
    int64_t r_id = load_i64(mem + offset + 4);
    page_insert_interior_cell(new_page_offset, child_id, r_id);
  }

  page_set_right_child_page_id(page_offset, promoted_child_page_id);
  page_set_cell_count(page_offset, median_idx);

  if (out_median_rowid) *out_median_rowid = median_rowid;
  if (out_promoted_child) *out_promoted_child = promoted_child_page_id;
  if (out_right_child) *out_right_child = old_right_child;
  return 0;
}

// ============================================================================
// 5. Secondary Index Leaf
// ============================================================================

void page_init_index_leaf(uint32_t page_offset, uint32_t next_page_id) {
  page_init(page_offset, PAGE_TYPE_INDEX_LEAF, next_page_id);
}

int32_t page_compare_index_raw_keys(
  uint8_t type_a,
  const uint8_t *data_a,
  uint16_t len_a,
  int64_t rowid_a,
  uint8_t type_b,
  const uint8_t *data_b,
  uint16_t len_b,
  int64_t rowid_b
) {
  if (type_a != type_b) {
    return (int32_t)type_a - (int32_t)type_b;
  }

  if (type_a == DATA_TYPE_NULL || len_a == 0 || len_b == 0) {
    if (len_a == 0 && len_b == 0) {
      return (rowid_a < rowid_b) ? -1 : (rowid_a > rowid_b) ? 1 : 0;
    }
    return (len_a < len_b) ? -1 : 1;
  }

  int32_t diff = 0;
  if (type_a == DATA_TYPE_INT32) {
    int32_t val_a = load_i32(data_a);
    int32_t val_b = load_i32(data_b);
    diff = (val_a < val_b) ? -1 : (val_a > val_b) ? 1 : 0;
  } else if (type_a == DATA_TYPE_INT64) {
    int64_t val_a = load_i64(data_a);
    int64_t val_b = load_i64(data_b);
    diff = (val_a < val_b) ? -1 : (val_a > val_b) ? 1 : 0;
  } else if (type_a == DATA_TYPE_FLOAT64) {
    double val_a = load_f64(data_a);
    double val_b = load_f64(data_b);
    diff = (val_a < val_b) ? -1 : (val_a > val_b) ? 1 : 0;
  } else {
    uint16_t min_len = (len_a < len_b) ? len_a : len_b;
    for (uint16_t i = 0; i < min_len; i++) {
      if (data_a[i] != data_b[i]) {
        diff = (data_a[i] < data_b[i]) ? -1 : 1;
        break;
      }
    }
    if (diff == 0) {
      diff = (int32_t)len_a - (int32_t)len_b;
    }
  }

  if (diff != 0) return diff;
  return (rowid_a < rowid_b) ? -1 : (rowid_a > rowid_b) ? 1 : 0;
}

int32_t page_insert_index_leaf_cell_raw(
  uint32_t page_offset,
  uint8_t key_type,
  const uint8_t *key_bytes,
  uint16_t key_len,
  int64_t rowid,
  uint32_t scratchpad_offset
) {
  uint16_t cell_len = 2 + key_len + 8;
  uint16_t needed_bytes = cell_len + 2;

  uint16_t cell_count = page_get_cell_count(page_offset);
  uint16_t contiguous_free = page_get_contiguous_free_space(page_offset);
  uint16_t total_free = page_get_total_free_space(page_offset);

  if (needed_bytes > total_free) {
    return -1;
  }

  if (needed_bytes > contiguous_free) {
    page_compact(page_offset, scratchpad_offset);
  }

  uint8_t *mem = P_MEM(page_offset);
  uint16_t content_offset = page_get_cell_content_offset(page_offset);
  uint16_t new_content_offset = content_offset - cell_len;

  store_u16(mem + new_content_offset, key_len);
  if (key_len > 0 && key_bytes) {
    webdb_memcpy(mem + new_content_offset + 2, key_bytes, key_len);
  }
  store_i64(mem + new_content_offset + 2 + key_len, rowid);

  int32_t lo = 0;
  int32_t hi = cell_count - 1;
  int32_t insert_slot = cell_count;

  while (lo <= hi) {
    int32_t mid = (lo + hi) >> 1;
    uint16_t offset = page_get_cell_offset(page_offset, (uint16_t)mid);
    uint16_t existing_k_len = load_u16(mem + offset);
    int64_t r_id = load_i64(mem + offset + 2 + existing_k_len);
    const uint8_t *existing_data = mem + offset + 2;

    int32_t cmp = page_compare_index_raw_keys(
      key_type, key_bytes, key_len, rowid,
      key_type, existing_data, existing_k_len, r_id
    );

    if (cmp < 0) {
      insert_slot = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  uint32_t slot_dir_start = PAGE_HEADER_SIZE;
  for (int32_t k = (int32_t)cell_count - 1; k >= insert_slot; k--) {
    uint16_t off = load_u16(mem + slot_dir_start + k * 2);
    store_u16(mem + slot_dir_start + (k + 1) * 2, off);
  }

  page_set_cell_offset(page_offset, (uint16_t)insert_slot, new_content_offset);
  page_set_cell_count(page_offset, cell_count + 1);
  page_set_cell_content_offset(page_offset, new_content_offset);

  return insert_slot;
}

int32_t page_binary_search_index_leaf_raw(
  uint32_t page_offset,
  uint8_t target_type,
  const uint8_t *target_bytes,
  uint16_t target_len,
  int64_t target_row_id,
  int32_t match_row_id,
  int32_t *out_found
) {
  uint16_t cell_count = page_get_cell_count(page_offset);
  uint8_t *mem = P_MEM(page_offset);
  int32_t lo = 0;
  int32_t hi = cell_count - 1;

  while (lo <= hi) {
    int32_t mid = (lo + hi) >> 1;
    uint16_t offset = page_get_cell_offset(page_offset, (uint16_t)mid);
    uint16_t k_len = load_u16(mem + offset);
    int64_t r_id = load_i64(mem + offset + 2 + k_len);
    const uint8_t *mid_bytes = mem + offset + 2;

    int64_t rowid_to_cmp = match_row_id ? target_row_id : r_id;
    int32_t cmp = page_compare_index_raw_keys(
      target_type, target_bytes, target_len, rowid_to_cmp,
      target_type, mid_bytes, k_len, r_id
    );

    if (cmp == 0) {
      if (!match_row_id) {
        int32_t first_slot = mid;
        while (first_slot > 0) {
          int32_t prev_slot = first_slot - 1;
          uint16_t prev_off = page_get_cell_offset(page_offset, (uint16_t)prev_slot);
          uint16_t prev_len = load_u16(mem + prev_off);
          const uint8_t *prev_b = mem + prev_off + 2;

          if (page_compare_index_raw_keys(
                target_type, target_bytes, target_len, 0,
                target_type, prev_b, prev_len, 0
              ) == 0) {
            first_slot = prev_slot;
          } else {
            break;
          }
        }
        if (out_found) *out_found = 1;
        return first_slot;
      }
      if (out_found) *out_found = 1;
      return mid;
    } else if (cmp < 0) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  if (out_found) *out_found = 0;
  return lo;
}
