/**
 * WebDB C Core Engine - Schema Catalog Implementation
 */

#include "catalog.h"

#define CAT_MEM(offset) ((uint8_t *)(uintptr_t)(offset))
#define DB_HDR(offset) ((DatabaseFileHeader *)(uintptr_t)(offset))

// ============================================================================
// CRC32 IEEE 802.3 Standard (Polynomial 0xEDB88320)
// ============================================================================

static uint32_t CRC_TABLE[256];
static int crc_table_initialized = 0;

static void init_crc_table(void) {
  if (crc_table_initialized) return;
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >> 1)) : (c >> 1);
    }
    CRC_TABLE[i] = c;
  }
  crc_table_initialized = 1;
}

uint32_t compute_crc32(const uint8_t *data, uint32_t length) {
  init_crc_table();
  uint32_t crc = 0xffffffff;
  for (uint32_t i = 0; i < length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  }
  return crc ^ 0xffffffff;
}

uint32_t compute_page_checksum(const uint8_t *page_bytes) {
  init_crc_table();
  uint32_t crc = 0xffffffff;
  for (uint32_t i = 0; i < PAGE_SIZE; i++) {
    uint8_t byte = (i >= 12 && i <= 15) ? 0 : page_bytes[i];
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >> 8);
  }
  return crc ^ 0xffffffff;
}

uint32_t compute_page1_checksum(const uint8_t *page1_bytes) {
  init_crc_table();
  uint32_t crc = 0xffffffff;
  for (uint32_t i = 0; i < PAGE_SIZE; i++) {
    uint8_t byte = (i >= 28 && i <= 31) ? 0 : page1_bytes[i];
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >> 8);
  }
  return crc ^ 0xffffffff;
}

// ============================================================================
// Fixed String Helpers
// ============================================================================

void catalog_write_fixed_string(uint32_t offset, const char *str, uint32_t max_len) {
  uint8_t *mem = CAT_MEM(offset);
  uint32_t i = 0;
  if (str) {
    for (; i < max_len && str[i] != '\0'; i++) {
      mem[i] = (uint8_t)str[i];
    }
  }
  for (; i < max_len; i++) {
    mem[i] = 0;
  }
}

void catalog_read_fixed_string(uint32_t offset, char *out_str, uint32_t max_len) {
  const uint8_t *mem = CAT_MEM(offset);
  uint32_t i = 0;
  for (; i < max_len; i++) {
    uint8_t b = mem[i];
    if (b == 0) break;
    out_str[i] = (char)b;
  }
  out_str[i] = '\0';
}

static inline char to_lower(char c) {
  if (c >= 'A' && c <= 'Z') return (char)(c + ('a' - 'A'));
  return c;
}

static int strcasecmp_custom(const char *s1, const char *s2) {
  while (*s1 && *s2) {
    char c1 = to_lower(*s1);
    char c2 = to_lower(*s2);
    if (c1 != c2) return (int)c1 - (int)c2;
    s1++;
    s2++;
  }
  return (int)to_lower(*s1) - (int)to_lower(*s2);
}

uint32_t catalog_parse_data_type(const char *type_str) {
  if (!type_str) return DATA_TYPE_NULL;
  if (strcasecmp_custom(type_str, "INTEGER") == 0 || strcasecmp_custom(type_str, "INT") == 0 ||
      strcasecmp_custom(type_str, "INT32") == 0) {
    return DATA_TYPE_INT32;
  }
  if (strcasecmp_custom(type_str, "BIGINT") == 0 || strcasecmp_custom(type_str, "INT64") == 0) {
    return DATA_TYPE_INT64;
  }
  if (strcasecmp_custom(type_str, "FLOAT") == 0 || strcasecmp_custom(type_str, "DOUBLE") == 0 ||
      strcasecmp_custom(type_str, "REAL") == 0 || strcasecmp_custom(type_str, "FLOAT64") == 0) {
    return DATA_TYPE_FLOAT64;
  }
  if (strcasecmp_custom(type_str, "TEXT") == 0 || strcasecmp_custom(type_str, "VARCHAR") == 0 ||
      strcasecmp_custom(type_str, "STRING") == 0) {
    return DATA_TYPE_TEXT;
  }
  if (strcasecmp_custom(type_str, "BLOB") == 0 || strcasecmp_custom(type_str, "BYTES") == 0) {
    return DATA_TYPE_BLOB;
  }
  if (strcasecmp_custom(type_str, "UUID") == 0) {
    return DATA_TYPE_UUID;
  }
  if (strcasecmp_custom(type_str, "ULID") == 0) {
    return DATA_TYPE_ULID;
  }
  return DATA_TYPE_NULL;
}

// ============================================================================
// Page 1 File Header Operations
// ============================================================================

static const uint8_t MAGIC_BYTES[] = {0x57, 0x45, 0x42, 0x44, 0x42, 0x00}; // "WEBDB\0"

void catalog_init_page1(uint32_t page1_offset) {
  uint8_t *mem = CAT_MEM(page1_offset);
  webdb_memset(mem, 0, PAGE_SIZE);

  DatabaseFileHeader *hdr = DB_HDR(page1_offset);
  webdb_memcpy(hdr->magic, MAGIC_BYTES, 6);
  hdr->page_size = PAGE_SIZE;
  hdr->file_format_version = CURRENT_ENGINE_VERSION;
  hdr->min_read_version = CURRENT_MIN_READ_VERSION;
  hdr->total_pages = 1;
  hdr->free_page_head = 0;
  hdr->schema_version = 1;
  hdr->change_counter = 0;
  hdr->page_checksum = 0;
  hdr->next_catalog_page_id = 0;
  hdr->next_index_catalog_page_id = 0;

  hdr->page_checksum = compute_page1_checksum(mem);
}

uint32_t catalog_get_total_pages(uint32_t page1_offset) {
  return DB_HDR(page1_offset)->total_pages;
}

void catalog_set_total_pages(uint32_t page1_offset, uint32_t count) {
  DB_HDR(page1_offset)->total_pages = count;
}

uint32_t catalog_get_free_page_head(uint32_t page1_offset) {
  return DB_HDR(page1_offset)->free_page_head;
}

void catalog_set_free_page_head(uint32_t page1_offset, uint32_t page_id) {
  DB_HDR(page1_offset)->free_page_head = page_id;
}

uint32_t catalog_get_schema_version(uint32_t page1_offset) {
  return DB_HDR(page1_offset)->schema_version;
}

uint32_t catalog_increment_schema_version(uint32_t page1_offset) {
  DatabaseFileHeader *hdr = DB_HDR(page1_offset);
  return ++hdr->schema_version;
}

uint32_t catalog_get_change_counter(uint32_t page1_offset) {
  return DB_HDR(page1_offset)->change_counter;
}

uint32_t catalog_increment_change_counter(uint32_t page1_offset) {
  DatabaseFileHeader *hdr = DB_HDR(page1_offset);
  return ++hdr->change_counter;
}

uint32_t catalog_update_page1_checksum(uint32_t page1_offset) {
  DatabaseFileHeader *hdr = DB_HDR(page1_offset);
  hdr->page_checksum = compute_page1_checksum((const uint8_t *)hdr);
  return hdr->page_checksum;
}

int32_t catalog_find_free_table_slot(uint32_t page1_offset) {
  TableDescriptor *tables = (TableDescriptor *)(CAT_MEM(page1_offset) + MASTER_TABLE_OFFSET);
  for (uint32_t i = 0; i < MAX_TABLES_PAGE1; i++) {
    if (tables[i].table_id == 0) return (int32_t)i;
  }
  return -1;
}

int32_t catalog_delete_table_descriptor(uint32_t page1_offset, uint32_t slot_idx) {
  if (slot_idx >= MAX_TABLES_PAGE1) return -1;
  TableDescriptor *tables = (TableDescriptor *)(CAT_MEM(page1_offset) + MASTER_TABLE_OFFSET);
  webdb_memset(&tables[slot_idx], 0, sizeof(TableDescriptor));
  return 0;
}

int32_t catalog_find_free_index_slot(uint32_t page1_offset) {
  IndexDescriptor *indexes = (IndexDescriptor *)(CAT_MEM(page1_offset) + INDEX_CATALOG_OFFSET);
  for (uint32_t i = 0; i < MAX_INDEXES_PAGE1; i++) {
    if (indexes[i].index_id == 0) return (int32_t)i;
  }
  return -1;
}

int32_t catalog_delete_index_descriptor(uint32_t page1_offset, uint32_t slot_idx) {
  if (slot_idx >= MAX_INDEXES_PAGE1) return -1;
  IndexDescriptor *indexes = (IndexDescriptor *)(CAT_MEM(page1_offset) + INDEX_CATALOG_OFFSET);
  webdb_memset(&indexes[slot_idx], 0, sizeof(IndexDescriptor));
  return 0;
}

void catalog_init_page(
  uint32_t page_offset,
  uint16_t table_id,
  uint16_t start_col_index,
  uint32_t next_col_catalog_page_id
) {
  uint8_t *mem = CAT_MEM(page_offset);
  webdb_memset(mem, 0, PAGE_SIZE);

  CatalogPageHeader *hdr = (CatalogPageHeader *)mem;
  hdr->page_type = PAGE_TYPE_CATALOG_PAGE;
  hdr->flags = 0;
  hdr->col_count_in_page = 0;
  hdr->table_id = table_id;
  hdr->start_col_index = start_col_index;
  hdr->next_col_catalog_page_id = next_col_catalog_page_id;
  hdr->checksum = 0;
}

void catalog_write_page_header(
  uint32_t page_offset,
  uint16_t col_count_in_page,
  uint16_t table_id,
  uint16_t start_col_index,
  uint32_t next_col_catalog_page_id
) {
  CatalogPageHeader *hdr = (CatalogPageHeader *)CAT_MEM(page_offset);
  hdr->page_type = PAGE_TYPE_CATALOG_PAGE;
  hdr->flags = 0;
  hdr->col_count_in_page = col_count_in_page;
  hdr->table_id = table_id;
  hdr->start_col_index = start_col_index;
  hdr->next_col_catalog_page_id = next_col_catalog_page_id;
}
