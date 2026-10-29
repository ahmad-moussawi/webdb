/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/wal_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

/**
 * ============================================================================
 * CRITICAL WARNING: FROZEN WAL BINARY FORMAT SPECIFICATION
 * DO NOT modify the order, types, or byte lengths of existing fields in
 * WalFileHeader or WalFrameHeader! Changing any offset or field size breaks
 * binary determinism, prevents crash recovery, and corrupts WAL logs.
 *
 * Both the WAL file header (32 bytes) and WAL frame headers (32 bytes)
 * must remain rigidly 8-byte aligned.
 * ============================================================================
 */

/**
 * Rigid page payload size in bytes per WAL frame (4096 bytes).
 */
export const WAL_PAGE_SIZE = 4096;

/**
 * Total size in bytes of a single WAL frame (32-byte header + 4096-byte page payload = 4128 bytes).
 */
export const WAL_FRAME_SIZE = 4128;

/**
 * Current WAL file format version (Version 1).
 */
export const WAL_CURRENT_VERSION = 1;

/**
 * Magic number for WAL frames (0x57414C46 in uint32 LE = 'WALF').
 */
export const WAL_FRAME_MAGIC = 1463897158;

/**
 * Frame type 0x0001: Committed 4KB page mutation for page_id.
 */
export const WAL_FRAME_TYPE_PAGE_DATA = 1;

/**
 * Frame type 0x0002: Commit marker for tx_id. Signals that all preceding frames for this tx_id are permanently committed.
 */
export const WAL_FRAME_TYPE_TX_COMMIT = 2;

/**
 * Frame type 0x0003: Cache spill frame under memory pressure. Ignored during recovery unless followed by a commit marker.
 */
export const WAL_FRAME_TYPE_TX_UNCOMMITTED = 3;

// ============================================================================
// 1. WAL FILE HEADER Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for WAL_FILE_HEADER:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | MAGIC [0..3]                                                          |
 * +-----------------------------------------------------------------------+
 * | MAGIC [4..5]                      | WAL_VERSION (2B)                  |
 * +-----------------------------------+-----------------------------------+
 * | PAGE_SIZE (4B)                                                        |
 * +-----------------------------------------------------------------------+
 * | CHECKPOINT_SEQ (4B)                                                   |
 * +-----------------------------------------------------------------------+
 * | SALT1 (4B)                                                            |
 * +-----------------------------------------------------------------------+
 * | SALT2 (4B)                                                            |
 * +-----------------------------------------------------------------------+
 * | CHECKSUM (4B)                                                         |
 * +-----------------------------------------------------------------------+
 * | RESERVED (4B)                                                         |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+----------------+----------+------------------------------------------------+
 * | Offset | Size | Field Name     | Type     | Description                                    |
 * +--------+------+----------------+----------+------------------------------------------------+
 * | 0      | 6B   | MAGIC          | char[6]  | Magic string identifier 'WEBWAL'               |
 * | 6      | 2B   | WAL_VERSION    | uint16_t | WAL format version (1 for V1, uint16 LE)       |
 * | 8      | 4B   | PAGE_SIZE      | uint32_t | Rigid page size (4096, uint32 LE)              |
 * | 12     | 4B   | CHECKPOINT_SEQ | uint32_t | Monotonic checkpoint counter (uint32 LE)       |
 * | 16     | 4B   | SALT1          | uint32_t | Random salt generated on checkpoint (uint32... |
 * | 20     | 4B   | SALT2          | uint32_t | Random salt tie-breaker (uint32 LE)            |
 * | 24     | 4B   | CHECKSUM       | uint32_t | CRC32 checksum over bytes 0..23 (uint32 LE)    |
 * | 28     | 4B   | RESERVED       | uint32_t | Zero padding for 8-byte alignment (uint32 LE)  |
 * +--------+------+----------------+----------+------------------------------------------------+
 * | Total: 32 Bytes                                                                            |
 * +--------------------------------------------------------------------------------------------+
 */
export const WAL_FILE_HEADER_FIELDS = [
  ["MAGIC", 6], // char[6]
  ["WAL_VERSION", 2], // uint16_t
  ["PAGE_SIZE", 4], // uint32_t
  ["CHECKPOINT_SEQ", 4], // uint32_t
  ["SALT1", 4], // uint32_t
  ["SALT2", 4], // uint32_t
  ["CHECKSUM", 4], // uint32_t
  ["RESERVED", 4], // uint32_t
] as const;

/**
 * Total size in bytes of the WAL file header (32 bytes).
 */
export const WAL_FILE_HEADER_SIZE = 32;

/**
 * 0..5: Magic string identifier 'WEBWAL'
 */
export const WAL_HEADER_OFFSET_MAGIC = 0;

/**
 * 6..7: WAL format version (1 for V1, uint16 LE)
 */
export const WAL_HEADER_OFFSET_WAL_VERSION = 6;

/**
 * 8..11: Rigid page size (4096, uint32 LE)
 */
export const WAL_HEADER_OFFSET_PAGE_SIZE = 8;

/**
 * 12..15: Monotonic checkpoint counter (uint32 LE)
 */
export const WAL_HEADER_OFFSET_CHECKPOINT_SEQ = 12;

/**
 * 16..19: Random salt generated on checkpoint (uint32 LE)
 */
export const WAL_HEADER_OFFSET_SALT1 = 16;

/**
 * 20..23: Random salt tie-breaker (uint32 LE)
 */
export const WAL_HEADER_OFFSET_SALT2 = 20;

/**
 * 24..27: CRC32 checksum over bytes 0..23 (uint32 LE)
 */
export const WAL_HEADER_OFFSET_CHECKSUM = 24;

/**
 * 28..31: Zero padding for 8-byte alignment (uint32 LE)
 */
export const WAL_HEADER_OFFSET_RESERVED = 28;

// ============================================================================
// 2. WAL FRAME HEADER Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for WAL_FRAME_HEADER:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | MAGIC (4B)                                                            |
 * +-----------------------------------------------------------------------+
 * | FRAME_TYPE (2B)                   | FLAGS (2B)                        |
 * +-----------------------------------+-----------------------------------+
 * | TX_ID (4B)                                                            |
 * +-----------------------------------------------------------------------+
 * | PAGE_ID (4B)                                                          |
 * +-----------------------------------------------------------------------+
 * | DB_SIZE_PAGES (4B)                                                    |
 * +-----------------------------------------------------------------------+
 * | FRAME_SEQ (4B)                                                        |
 * +-----------------------------------------------------------------------+
 * | CHECKSUM (4B)                                                         |
 * +-----------------------------------------------------------------------+
 * | RESERVED (4B)                                                         |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+---------------+----------+------------------------------------------------+
 * | Offset | Size | Field Name    | Type     | Description                                    |
 * +--------+------+---------------+----------+------------------------------------------------+
 * | 0      | 4B   | MAGIC         | uint32_t | Frame magic 0x57414C46 ('WALF', uint32 LE)     |
 * | 4      | 2B   | FRAME_TYPE    | uint16_t | Frame type (1=PAGE_DATA, 2=TX_COMMIT, 3=TX_... |
 * | 6      | 2B   | FLAGS         | uint16_t | Reserved flags (0x0000, uint16 LE)             |
 * | 8      | 4B   | TX_ID         | uint32_t | Monotonic transaction identifier (uint32 LE)   |
 * | 12     | 4B   | PAGE_ID       | uint32_t | Target database Page ID (1..N, uint32 LE)      |
 * | 16     | 4B   | DB_SIZE_PAGES | uint32_t | Size of DB in pages after commit (uint32 LE)   |
 * | 20     | 4B   | FRAME_SEQ     | uint32_t | Monotonic frame sequence counter in WAL (ui... |
 * | 24     | 4B   | CHECKSUM      | uint32_t | CRC32 over header bytes 0..23 + 4096 page b... |
 * | 28     | 4B   | RESERVED      | uint32_t | Zero padding for 8-byte alignment (uint32 LE)  |
 * +--------+------+---------------+----------+------------------------------------------------+
 * | Total: 32 Bytes                                                                           |
 * +-------------------------------------------------------------------------------------------+
 */
export const WAL_FRAME_HEADER_FIELDS = [
  ["MAGIC", 4], // uint32_t
  ["FRAME_TYPE", 2], // uint16_t
  ["FLAGS", 2], // uint16_t
  ["TX_ID", 4], // uint32_t
  ["PAGE_ID", 4], // uint32_t
  ["DB_SIZE_PAGES", 4], // uint32_t
  ["FRAME_SEQ", 4], // uint32_t
  ["CHECKSUM", 4], // uint32_t
  ["RESERVED", 4], // uint32_t
] as const;

/**
 * Total size in bytes of a single WAL frame header (32 bytes).
 */
export const WAL_FRAME_HEADER_SIZE = 32;

/**
 * 0..3: Frame magic 0x57414C46 ('WALF', uint32 LE)
 */
export const WAL_FRAME_OFFSET_MAGIC = 0;

/**
 * 4..5: Frame type (1=PAGE_DATA, 2=TX_COMMIT, 3=TX_UNCOMMITTED, uint16 LE)
 */
export const WAL_FRAME_OFFSET_FRAME_TYPE = 4;

/**
 * 6..7: Reserved flags (0x0000, uint16 LE)
 */
export const WAL_FRAME_OFFSET_FLAGS = 6;

/**
 * 8..11: Monotonic transaction identifier (uint32 LE)
 */
export const WAL_FRAME_OFFSET_TX_ID = 8;

/**
 * 12..15: Target database Page ID (1..N, uint32 LE)
 */
export const WAL_FRAME_OFFSET_PAGE_ID = 12;

/**
 * 16..19: Size of DB in pages after commit (uint32 LE)
 */
export const WAL_FRAME_OFFSET_DB_SIZE_PAGES = 16;

/**
 * 20..23: Monotonic frame sequence counter in WAL (uint32 LE)
 */
export const WAL_FRAME_OFFSET_FRAME_SEQ = 20;

/**
 * 24..27: CRC32 over header bytes 0..23 + 4096 page bytes (uint32 LE)
 */
export const WAL_FRAME_OFFSET_CHECKSUM = 24;

/**
 * 28..31: Zero padding for 8-byte alignment (uint32 LE)
 */
export const WAL_FRAME_OFFSET_RESERVED = 28;

