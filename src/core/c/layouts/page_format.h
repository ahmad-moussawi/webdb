/**
 * AUTO-GENERATED FROM src/layouts/schemas/page_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

#ifndef WEBDB_PAGE_FORMAT_H
#define WEBDB_PAGE_FORMAT_H

#include <stdint.h>

// Standard uniform page size in bytes across the entire database engine (4 KB).
#define PAGE_SIZE 4096

// Maximum inline size in bytes allowed for a single serialized row record on a
#define MAX_ROW_SIZE 3800

// Target inline row budget (2 KB) before spilling large variable-length columns
#define MAX_INLINE_ROW_SIZE 2048

// Maximum serialized key length in bytes allowed in a secondary B-tree index.
#define MAX_INDEX_KEY_SIZE 1024

// 0x0E: Dedicated overflow page holding out-of-line variable-length payload chu...
#define PAGE_TYPE_OVERFLOW 14

// Header size in bytes of an overflow page (matches standard 16-byte page header).
#define OVERFLOW_HEADER_SIZE 16

// Usable contiguous payload bytes per overflow page (PAGE_SIZE - OVERFLOW_HEADE...
#define OVERFLOW_PAYLOAD_SIZE 4080

// Size in bytes of an inline OverflowDescriptor (uint32 first_page_id + uint32 ...
#define OVERFLOW_DESCRIPTOR_SIZE 8

// 0x8000: High bit in var-offset table length field indicating an OverflowDescr...
#define OVERFLOW_LEN_FLAG 32768

// 0x01: Record header flag indicating an active (non-deleted) row.
#define ROW_FLAG_ACTIVE 1

// 0x02: Record header flag indicating at least one column is stored in overflow...
#define ROW_FLAG_HAS_OVERFLOW 2

// SLOTTED_PAGE_HEADER
#define PAGE_HEADER_OFFSET_TYPE 0
#define PAGE_HEADER_OFFSET_FLAGS 1
#define PAGE_HEADER_OFFSET_CELL_COUNT 2
#define PAGE_HEADER_OFFSET_CONTENT_OFFSET 4
#define PAGE_HEADER_OFFSET_NEXT_PAGE_ID 6
#define PAGE_HEADER_OFFSET_FREE_BYTES 10
#define PAGE_HEADER_OFFSET_CHECKSUM 12
#define PAGE_HEADER_SIZE 16

// TABLE_INTERIOR_CELL
#define TABLE_INTERIOR_CELL_OFFSET_CHILD_PAGE_ID 0
#define TABLE_INTERIOR_CELL_OFFSET_ROWID 4
#define TABLE_INTERIOR_CELL_SIZE 12

// Maximum number of 12-byte interior cells that can fit inside one 4KB interior...
#define MAX_TABLE_INTERIOR_CELLS 291

// Median split index for interior page splits. When splitting a full 291-cell
#define TABLE_INTERIOR_SPLIT_INDEX 145

#endif /* WEBDB_PAGE_FORMAT_H */
