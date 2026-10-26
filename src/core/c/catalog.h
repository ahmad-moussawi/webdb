#ifndef WEBDB_CATALOG_H
#define WEBDB_CATALOG_H

#include "webdb_types.h"

WEBDB_EXPORT uint32_t compute_crc32(const uint8_t * data, uint32_t length);
WEBDB_EXPORT uint32_t compute_page_checksum(uint32_t page_offset);
WEBDB_EXPORT uint32_t compute_page1_checksum(uint32_t page1_offset);
WEBDB_EXPORT void catalog_init_page1(uint32_t page1_offset);
WEBDB_EXPORT uint32_t catalog_get_total_pages(uint32_t page1_offset);
WEBDB_EXPORT void catalog_set_total_pages(uint32_t page1_offset, uint32_t count);
WEBDB_EXPORT uint32_t catalog_get_free_page_head(uint32_t page1_offset);
WEBDB_EXPORT void catalog_set_free_page_head(uint32_t page1_offset, uint32_t page_id);
WEBDB_EXPORT uint32_t catalog_get_schema_version(uint32_t page1_offset);
WEBDB_EXPORT uint32_t catalog_increment_schema_version(uint32_t page1_offset);
WEBDB_EXPORT uint32_t catalog_get_change_counter(uint32_t page1_offset);
WEBDB_EXPORT uint32_t catalog_increment_change_counter(uint32_t page1_offset);
WEBDB_EXPORT uint32_t catalog_update_page1_checksum(uint32_t page1_offset);
WEBDB_EXPORT void catalog_write_fixed_string(uint32_t offset, const char * str, uint32_t max_len);
WEBDB_EXPORT int32_t catalog_find_free_table_slot(uint32_t page1_offset);
WEBDB_EXPORT int32_t catalog_find_free_index_slot(uint32_t page1_offset);
WEBDB_EXPORT int32_t catalog_delete_index_descriptor(uint32_t page1_offset, uint32_t slot_idx);
WEBDB_EXPORT int32_t catalog_delete_table_descriptor(uint32_t page1_offset, uint32_t slot_idx);
WEBDB_EXPORT void catalog_init_page(uint32_t page_offset, uint16_t table_id, uint16_t start_col_index, uint32_t next_col_catalog_page_id);
WEBDB_EXPORT void catalog_write_page_header(uint32_t page_offset, uint16_t col_count_in_page, uint16_t table_id, uint16_t start_col_index, uint32_t next_col_catalog_page_id);

#endif // WEBDB_CATALOG_H
