/**
 * WebDB C Core Engine - Common Types & Enumerations
 */

#ifndef WEBDB_TYPES_H
#define WEBDB_TYPES_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "layouts/page_format.h"
#include "layouts/syspage_format.h"
#include "layouts/pool_format.h"

#define WEBDB_EXPORT __attribute__((visibility("default")))

size_t strlen(const char *s);
#define webdb_strlen strlen

#define webdb_memcpy __builtin_memcpy
#define webdb_memset __builtin_memset
#define webdb_memcmp __builtin_memcmp

// Bitmask operations
static inline int get_bit(const uint8_t *mask, uint32_t bit_idx) {
  return (mask[bit_idx >> 3] & (1 << (bit_idx & 7))) != 0;
}

static inline void set_bit(uint8_t *mask, uint32_t bit_idx) {
  mask[bit_idx >> 3] |= (uint8_t)(1 << (bit_idx & 7));
}

static inline void clear_bit(uint8_t *mask, uint32_t bit_idx) {
  mask[bit_idx >> 3] &= (uint8_t)~(1 << (bit_idx & 7));
}

// Unaligned Little-Endian Loads & Stores (Lower to native WASM instructions)
static inline uint8_t load_u8(const void *p) { return *(const uint8_t *)p; }
static inline void store_u8(void *p, uint8_t v) { *(uint8_t *)p = v; }

static inline uint16_t load_u16(const void *p) {
  uint16_t v;
  __builtin_memcpy(&v, p, sizeof(v));
  return v;
}
static inline void store_u16(void *p, uint16_t v) {
  __builtin_memcpy(p, &v, sizeof(v));
}

static inline uint32_t load_u32(const void *p) {
  uint32_t v;
  __builtin_memcpy(&v, p, sizeof(v));
  return v;
}
static inline void store_u32(void *p, uint32_t v) {
  __builtin_memcpy(p, &v, sizeof(v));
}

static inline int32_t load_i32(const void *p) {
  int32_t v;
  __builtin_memcpy(&v, p, sizeof(v));
  return v;
}
static inline void store_i32(void *p, int32_t v) {
  __builtin_memcpy(p, &v, sizeof(v));
}

static inline uint64_t load_u64(const void *p) {
  uint64_t v;
  __builtin_memcpy(&v, p, sizeof(v));
  return v;
}
static inline void store_u64(void *p, uint64_t v) {
  __builtin_memcpy(p, &v, sizeof(v));
}

static inline int64_t load_i64(const void *p) {
  int64_t v;
  __builtin_memcpy(&v, p, sizeof(v));
  return v;
}
static inline void store_i64(void *p, int64_t v) {
  __builtin_memcpy(p, &v, sizeof(v));
}

static inline double load_f64(const void *p) {
  double v;
  __builtin_memcpy(&v, p, sizeof(v));
  return v;
}
static inline void store_f64(void *p, double v) {
  __builtin_memcpy(p, &v, sizeof(v));
}

// ============================================================================
// Engine Versions & Limits
// ============================================================================
#define CURRENT_ENGINE_VERSION 1
#define CURRENT_MIN_READ_VERSION 1

#define MAX_COLUMNS_PER_TABLE 256
#define MAX_TABLES_PAGE1 16
#define MAX_INDEXES_PAGE1 8
#define MAX_INDEX_COLUMNS 8
#define NULL_BITMAP_BYTES ((MAX_COLUMNS_PER_TABLE + 7) / 8) // 32 bytes

// ============================================================================
// Core Binary Struct Layouts
// ============================================================================

typedef struct __attribute__((packed)) {
  uint8_t type;
  uint8_t flags;
  uint16_t cell_count;
  uint16_t cell_content_offset;
  uint32_t next_page_id;
  uint16_t free_bytes;
  uint32_t checksum;
} SlottedPageHeader;

typedef struct __attribute__((packed)) {
  uint8_t magic[6];                    // "WEBDB\0"
  uint16_t page_size;                  // 4096
  uint16_t file_format_version;
  uint16_t min_read_version;
  uint32_t total_pages;
  uint32_t free_page_head;
  uint32_t schema_version;
  uint32_t change_counter;
  uint32_t page_checksum;
  uint32_t next_catalog_page_id;
  uint32_t next_index_catalog_page_id;
  uint8_t reserved[60];
} DatabaseFileHeader;

typedef struct __attribute__((packed)) {
  uint16_t table_id;
  uint16_t column_count;
  uint32_t root_page_id;
  uint32_t col_catalog_page_id;
  char name[MAX_NAME_LENGTH];
  uint32_t flags;
  uint32_t row_count_estimate;
  uint64_t auto_inc_next;
  uint8_t reserved[36];
} TableDescriptor;

typedef struct __attribute__((packed)) {
  uint16_t index_id;
  uint16_t table_id;
  uint32_t root_page_id;
  uint8_t column_count;
  uint8_t flags;
  char name[MAX_NAME_LENGTH];
  uint8_t col_indexes[MAX_INDEX_COLUMNS];
  uint8_t reserved[46];
} IndexDescriptor;

typedef struct __attribute__((packed)) {
  uint8_t page_type;
  uint8_t flags;
  uint16_t col_count_in_page;
  uint16_t table_id;
  uint16_t start_col_index;
  uint32_t next_col_catalog_page_id;
  uint32_t checksum;
} CatalogPageHeader;

typedef struct __attribute__((packed)) {
  uint32_t page_id;
  uint32_t slot_idx;
} PageTableBucket;

// Page Types (§4.2)
#define PAGE_TYPE_FREE            0x00
#define PAGE_TYPE_INDEX_INTERIOR  0x02
#define PAGE_TYPE_TABLE_INTERIOR  0x05
#define PAGE_TYPE_INDEX_LEAF      0x0A
#define PAGE_TYPE_CATALOG_PAGE    0x0C
#define PAGE_TYPE_LEAF_DATA       0x0D

// ============================================================================
// Data Types
// ============================================================================
typedef enum {
  DATA_TYPE_NULL    = 0,
  DATA_TYPE_INT32   = 1,
  DATA_TYPE_INT64   = 2,
  DATA_TYPE_FLOAT64 = 3,
  DATA_TYPE_TEXT    = 4,
  DATA_TYPE_BLOB    = 5,
  DATA_TYPE_UUID    = 6,
  DATA_TYPE_ULID    = 7
} DataType;

// ============================================================================
// Column & Table Flags
// ============================================================================
typedef enum {
  COL_FLAG_NONE        = 0x00,
  COL_FLAG_PRIMARY_KEY = 0x01,
  COL_FLAG_NOT_NULL    = 0x02,
  COL_FLAG_INDEXED     = 0x04,
  COL_FLAG_AUTO_INC    = 0x08
} ColumnFlag;

typedef enum {
  TABLE_FLAG_NONE   = 0x00,
  TABLE_FLAG_ACTIVE = 0x01,
  TABLE_FLAG_SYSTEM = 0x02
} TableFlag;

typedef enum {
  INDEX_FLAG_NONE           = 0x00,
  INDEX_FLAG_UNIQUE         = 0x01,
  INDEX_FLAG_PRIMARY        = 0x02,
  INDEX_FLAG_SPATIAL_VECTOR = 0x04
} IndexFlag;

// ============================================================================
// VM Execution Status & OpCodes
// ============================================================================
typedef enum {
  VM_STATUS_INIT             = 0,
  VM_STATUS_RUNNING          = 1,
  VM_STATUS_YIELD            = 2,
  VM_STATUS_PAGE_FAULT       = 3,
  VM_STATUS_DONE             = 4,
  VM_STATUS_ERROR            = 5,
  VM_STATUS_TIMEOUT          = 6,
  VM_STATUS_BUFFER_FULL      = 7,
  VM_STATUS_INVALID_BYTECODE = 8
} VmStatus;

typedef enum {
  OP_HALT               = 0x00,
  OP_OPEN_CURSOR        = 0x01,
  OP_REWIND             = 0x02,
  OP_NEXT_ROW           = 0x03,
  OP_COLUMN_INT         = 0x04,
  OP_COLUMN_FLOAT       = 0x05,
  OP_COLUMN_TEXT        = 0x06,
  OP_COLUMN_BLOB        = 0x07,
  OP_LAST               = 0x08,
  OP_PREV_ROW           = 0x09,
  OP_COLUMN_UUID        = 0x0a,
  OP_COLUMN_ULID        = 0x0b,
  OP_OPEN_INDEX         = 0x0c,
  OP_INDEX_SEEK_EQ      = 0x0d,
  OP_INDEX_SEEK_GE      = 0x0e,
  OP_INDEX_NEXT         = 0x0f,

  OP_IS_NULL            = 0x10,
  OP_IS_NOT_NULL        = 0x11,
  OP_EQ                 = 0x12,
  OP_NE                 = 0x13,
  OP_GT                 = 0x14,
  OP_GE                 = 0x15,
  OP_LT                 = 0x16,
  OP_LE                 = 0x17,
  OP_JUMP               = 0x18,
  OP_STR_LIKE           = 0x19,
  OP_STR_NOT_LIKE       = 0x1a,
  OP_STR_CONTAINS       = 0x1b,
  OP_STR_STARTS_WITH    = 0x1c,
  OP_STR_ENDS_WITH      = 0x1d,
  OP_LOAD_BLOB          = 0x1e,
  OP_IN                 = 0x1f,

  OP_LOAD_INT           = 0x20,
  OP_LOAD_FLOAT         = 0x21,
  OP_LOAD_TEXT          = 0x22,
  OP_LOAD_NULL          = 0x23,
  OP_EMIT_ROW           = 0x24,
  OP_RESULT_ROW         = 0x25,
  OP_OFFSET             = 0x26,
  OP_LIMIT              = 0x27,
  OP_CALL_UDF           = 0x28,
  OP_STR_LOWER          = 0x29,
  OP_STR_UPPER          = 0x2a,
  OP_STR_LENGTH         = 0x2b,
  OP_STR_SUBSTR         = 0x2c,
  OP_STR_TRIM           = 0x2d,
  OP_MATH_ABS           = 0x2e,
  OP_MATH_ROUND         = 0x2f,

  OP_SORTER_OPEN        = 0x30,
  OP_SORTER_INSERT      = 0x31,
  OP_SORTER_SORT        = 0x32,
  OP_SORTER_NEXT        = 0x33,

  OP_MATH_FLOOR         = 0x34,
  OP_MATH_CEIL          = 0x35,

  OP_ADD                = 0x36,
  OP_SUB                = 0x37,
  OP_MUL                = 0x38,
  OP_DIV                = 0x39,
  OP_MOD                = 0x3a,
  OP_NEGATE             = 0x3b,
  OP_AND                = 0x3c,
  OP_OR                 = 0x3d,
  OP_NOT                = 0x3e,

  OP_AGG_STEP           = 0x40,
  OP_AGG_FINAL          = 0x41,
  OP_GROUP_BY_KEY       = 0x42,
  OP_GROUP_BY_EMIT      = 0x43,

  OP_SEEK_ROWID         = 0x50,
  OP_ROWID              = 0x51,
  OP_INDEX_SEEK_LE      = 0x52,
  OP_INDEX_PREV         = 0x53,
  OP_INDEX_KEY_IS_NULL  = 0x54,
  OP_INDEX_KEY_IS_NOT_NULL = 0x55,
  OP_INDEX_REWIND       = 0x56,
  OP_INDEX_LAST         = 0x57,
  OP_COLUMN_VALUE       = 0x58
} OpCode;

#endif /* WEBDB_TYPES_H */
