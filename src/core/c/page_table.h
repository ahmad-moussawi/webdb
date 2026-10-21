/**
 * WebDB C Core Engine - Page Table Binary Open-Addressing Hash Table
 */

#ifndef WEBDB_PAGE_TABLE_H
#define WEBDB_PAGE_TABLE_H

#include "webdb_types.h"

#define KNUTH_GOLDEN_RATIO_32 0x9e3779b9

WEBDB_EXPORT uint32_t page_table_hash(uint32_t page_id, uint32_t mask);
WEBDB_EXPORT int32_t page_table_get(uint32_t base_offset, uint32_t bucket_count, uint32_t page_id);
WEBDB_EXPORT int32_t page_table_set(uint32_t base_offset, uint32_t bucket_count, uint32_t page_id, uint32_t slot_idx);
WEBDB_EXPORT int32_t page_table_delete(uint32_t base_offset, uint32_t bucket_count, uint32_t page_id);

#endif /* WEBDB_PAGE_TABLE_H */
