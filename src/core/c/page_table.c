/**
 * WebDB C Core Engine - Page Table Implementation
 */

#include "page_table.h"

uint32_t page_table_hash(uint32_t page_id, uint32_t mask) {
  uint32_t h = page_id * KNUTH_GOLDEN_RATIO_32;
  return ((h ^ (h >> 16))) & mask;
}

int32_t page_table_get(
  uint32_t base_offset,
  uint32_t bucket_count,
  uint32_t page_id
) {
  uint32_t mask = bucket_count - 1;
  uint32_t idx = page_table_hash(page_id, mask);
  PageTableBucket *buckets = (PageTableBucket *)(uintptr_t)base_offset;

  for (uint32_t probe = 0; probe < bucket_count; probe++) {
    uint32_t entry_page_id = buckets[idx].page_id;
    if (entry_page_id == 0) {
      return -1;
    }
    if (entry_page_id == page_id) {
      return (int32_t)buckets[idx].slot_idx;
    }
    idx = (idx + 1) & mask;
  }
  return -1;
}

int32_t page_table_set(
  uint32_t base_offset,
  uint32_t bucket_count,
  uint32_t page_id,
  uint32_t slot_idx
) {
  uint32_t mask = bucket_count - 1;
  uint32_t idx = page_table_hash(page_id, mask);
  PageTableBucket *buckets = (PageTableBucket *)(uintptr_t)base_offset;

  for (uint32_t probe = 0; probe < bucket_count; probe++) {
    uint32_t entry_page_id = buckets[idx].page_id;
    if (entry_page_id == 0 || entry_page_id == page_id) {
      buckets[idx].page_id = page_id;
      buckets[idx].slot_idx = slot_idx;
      return 0; // Success
    }
    idx = (idx + 1) & mask;
  }
  return -1; // Table full
}

int32_t page_table_delete(
  uint32_t base_offset,
  uint32_t bucket_count,
  uint32_t page_id
) {
  uint32_t mask = bucket_count - 1;
  uint32_t i = page_table_hash(page_id, mask);
  PageTableBucket *buckets = (PageTableBucket *)(uintptr_t)base_offset;

  // 1. Locate entry
  bool found = false;
  for (uint32_t probe = 0; probe < bucket_count; probe++) {
    uint32_t entry_page_id = buckets[i].page_id;
    if (entry_page_id == 0) {
      return 0; // Key not found
    }
    if (entry_page_id == page_id) {
      found = true;
      break;
    }
    i = (i + 1) & mask;
  }

  if (!found) {
    return 0;
  }

  // 2. Backward shift deletion
  uint32_t j = i;
  while (1) {
    j = (j + 1) & mask;
    uint32_t j_page_id = buckets[j].page_id;
    if (j_page_id == 0) {
      break;
    }
    uint32_t k = page_table_hash(j_page_id, mask);
    if (((i - k) & mask) < ((j - k) & mask)) {
      buckets[i] = buckets[j];
      i = j;
    }
  }

  buckets[i].page_id = 0;
  buckets[i].slot_idx = 0;
  return 1; // Removed
}
