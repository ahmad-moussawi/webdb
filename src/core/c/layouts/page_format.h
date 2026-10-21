/**
 * AUTO-GENERATED FROM src/layouts/schemas/page_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

#ifndef WEBDB_PAGE_FORMAT_H
#define WEBDB_PAGE_FORMAT_H

#include <stdint.h>

// Standard uniform page size in bytes across the entire database engine (4 KB).
#define PAGE_SIZE 4096

// Strict maximum size in bytes allowed for a single serialized row record (2 KB).
#define MAX_ROW_SIZE 2048

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
