/**
 * AUTO-GENERATED FROM src/layouts/schemas/wal_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

#ifndef WEBDB_WAL_FORMAT_H
#define WEBDB_WAL_FORMAT_H

#include <stdint.h>

// Rigid page payload size in bytes per WAL frame (4096 bytes).
#define WAL_PAGE_SIZE 4096

// Total size in bytes of a single WAL frame (32-byte header + 4096-byte page pa...
#define WAL_FRAME_SIZE 4128

// Current WAL file format version (Version 1).
#define WAL_CURRENT_VERSION 1

// Magic number for WAL frames (0x57414C46 in uint32 LE = 'WALF').
#define WAL_FRAME_MAGIC 1463897158

// Frame type 0x0001: Committed 4KB page mutation for page_id.
#define WAL_FRAME_TYPE_PAGE_DATA 1

// Frame type 0x0002: Commit marker for tx_id. Signals that all preceding frames...
#define WAL_FRAME_TYPE_TX_COMMIT 2

// Frame type 0x0003: Cache spill frame under memory pressure. Ignored during re...
#define WAL_FRAME_TYPE_TX_UNCOMMITTED 3

// WAL_FILE_HEADER
#define WAL_HEADER_OFFSET_MAGIC 0
#define WAL_HEADER_OFFSET_WAL_VERSION 6
#define WAL_HEADER_OFFSET_PAGE_SIZE 8
#define WAL_HEADER_OFFSET_CHECKPOINT_SEQ 12
#define WAL_HEADER_OFFSET_SALT1 16
#define WAL_HEADER_OFFSET_SALT2 20
#define WAL_HEADER_OFFSET_CHECKSUM 24
#define WAL_HEADER_OFFSET_RESERVED 28
#define WAL_FILE_HEADER_SIZE 32

// WAL_FRAME_HEADER
#define WAL_FRAME_OFFSET_MAGIC 0
#define WAL_FRAME_OFFSET_FRAME_TYPE 4
#define WAL_FRAME_OFFSET_FLAGS 6
#define WAL_FRAME_OFFSET_TX_ID 8
#define WAL_FRAME_OFFSET_PAGE_ID 12
#define WAL_FRAME_OFFSET_DB_SIZE_PAGES 16
#define WAL_FRAME_OFFSET_FRAME_SEQ 20
#define WAL_FRAME_OFFSET_CHECKSUM 24
#define WAL_FRAME_OFFSET_RESERVED 28
#define WAL_FRAME_HEADER_SIZE 32

#endif /* WEBDB_WAL_FORMAT_H */
