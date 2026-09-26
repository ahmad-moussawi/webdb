/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/syspage_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

/**
 * ============================================================================
 * CRITICAL WARNING: FROZEN SYSTEM PAGES & CATALOG SPECIFICATION
 * DO NOT modify the order or length of existing fields in Page 1, catalog
 * descriptors, or dedicated column catalog pages!
 * Changing any layout defined here WILL corrupt existing database files,
 * render databases unreadable, and permanently break schema decoding.
 *
 * Any new metadata fields MUST be appended within designated RESERVED areas
 * or versioned via schema migrations.
 * ============================================================================
 */

/**
 * Maximum length in bytes for table and column names (UTF-8, null-padded).
 */
export const MAX_NAME_LENGTH = 64;

// ============================================================================
// 1. SYSPAGE FILE HEADER Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for SYSPAGE_FILE_HEADER:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | MAGIC [0..3]                                                          |
 * +-----------------------------------------------------------------------+
 * | MAGIC [4..5]                      | PAGE_SIZE (2B)                    |
 * +-----------------------------------+-----------------------------------+
 * | FILE_FORMAT_VERSION (2B)          | MIN_READ_VERSION (2B)             |
 * +-----------------------------------+-----------------------------------+
 * | TOTAL_PAGES (4B)                                                      |
 * +-----------------------------------------------------------------------+
 * | FREE_PAGE_HEAD (4B)                                                   |
 * +-----------------------------------------------------------------------+
 * | SCHEMA_VERSION (4B)                                                   |
 * +-----------------------------------------------------------------------+
 * | CHANGE_COUNTER (4B)                                                   |
 * +-----------------------------------------------------------------------+
 * | PAGE_CHECKSUM (4B)                                                    |
 * +-----------------------------------------------------------------------+
 * | NEXT_CATALOG_PAGE_ID (4B)                                             |
 * +-----------------------------------------------------------------------+
 * | NEXT_INDEX_CATALOG_PAGE_ID (4B)                                       |
 * +-----------------------------------------------------------------------+
 * | Bytes 40..99 (60B): RESERVED (uint8_t[60])                            |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+----------------------------+-------------+------------------------------------------------+
 * | Offset | Size | Field Name                 | Type        | Description                                    |
 * +--------+------+----------------------------+-------------+------------------------------------------------+
 * | 0      | 6B   | MAGIC                      | char[6]     | Magic string identifier 'WEBDB\0'              |
 * | 6      | 2B   | PAGE_SIZE                  | uint16_t    | Page size in bytes (4096, uint16 LE)           |
 * | 8      | 2B   | FILE_FORMAT_VERSION        | uint16_t    | File format version (uint16 LE)                |
 * | 10     | 2B   | MIN_READ_VERSION           | uint16_t    | Minimum engine read version required (uint1... |
 * | 12     | 4B   | TOTAL_PAGES                | uint32_t    | Total number of pages in database file (uin... |
 * | 16     | 4B   | FREE_PAGE_HEAD             | uint32_t    | Page ID of the first free page in the free ... |
 * | 20     | 4B   | SCHEMA_VERSION             | uint32_t    | User schema version cookie, bumped on DDL (... |
 * | 24     | 4B   | CHANGE_COUNTER             | uint32_t    | Transaction write change counter (uint32 LE)   |
 * | 28     | 4B   | PAGE_CHECKSUM              | uint32_t    | CRC32 checksum of Page 1 (uint32 LE)           |
 * | 32     | 4B   | NEXT_CATALOG_PAGE_ID       | uint32_t    | Chained catalog page pointer (always 0 in v... |
 * | 36     | 4B   | NEXT_INDEX_CATALOG_PAGE_ID | uint32_t    | Chained index catalog pointer (always 0 in ... |
 * | 40     | 60B  | RESERVED                   | uint8_t[60] | Reserved space for future file header exten... |
 * +--------+------+----------------------------+-------------+------------------------------------------------+
 * | Total: 100 Bytes                                                                                          |
 * +-----------------------------------------------------------------------------------------------------------+
 */
export const SYSPAGE_FILE_HEADER_FIELDS = [
  ["MAGIC", 6], // char[6]
  ["PAGE_SIZE", 2], // uint16_t
  ["FILE_FORMAT_VERSION", 2], // uint16_t
  ["MIN_READ_VERSION", 2], // uint16_t
  ["TOTAL_PAGES", 4], // uint32_t
  ["FREE_PAGE_HEAD", 4], // uint32_t
  ["SCHEMA_VERSION", 4], // uint32_t
  ["CHANGE_COUNTER", 4], // uint32_t
  ["PAGE_CHECKSUM", 4], // uint32_t
  ["NEXT_CATALOG_PAGE_ID", 4], // uint32_t
  ["NEXT_INDEX_CATALOG_PAGE_ID", 4], // uint32_t
  ["RESERVED", 60], // uint8_t[60]
] as const;

/**
 * Total size in bytes of the database file header in Page 1 (100 bytes).
 */
export const FILE_HEADER_SIZE = 100;

/**
 * 0..5: Magic string identifier 'WEBDB\0'
 */
export const HEADER_OFFSET_MAGIC = 0;

/**
 * 6..7: Page size in bytes (4096, uint16 LE)
 */
export const HEADER_OFFSET_PAGE_SIZE = 6;

/**
 * 8..9: File format version (uint16 LE)
 */
export const HEADER_OFFSET_FILE_FORMAT_VERSION = 8;

/**
 * 10..11: Minimum engine read version required (uint16 LE)
 */
export const HEADER_OFFSET_MIN_READ_VERSION = 10;

/**
 * 12..15: Total number of pages in database file (uint32 LE)
 */
export const HEADER_OFFSET_TOTAL_PAGES = 12;

/**
 * 16..19: Page ID of the first free page in the free list chain (uint32 LE)
 */
export const HEADER_OFFSET_FREE_PAGE_HEAD = 16;

/**
 * 20..23: User schema version cookie, bumped on DDL (uint32 LE)
 */
export const HEADER_OFFSET_SCHEMA_VERSION = 20;

/**
 * 24..27: Transaction write change counter (uint32 LE)
 */
export const HEADER_OFFSET_CHANGE_COUNTER = 24;

/**
 * 28..31: CRC32 checksum of Page 1 (uint32 LE)
 */
export const HEADER_OFFSET_PAGE_CHECKSUM = 28;

/**
 * 32..35: Chained catalog page pointer (always 0 in v1, uint32 LE)
 */
export const HEADER_OFFSET_NEXT_CATALOG_PAGE_ID = 32;

/**
 * 36..39: Chained index catalog pointer (always 0 in v1, uint32 LE)
 */
export const HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID = 36;

/**
 * 40..99: Reserved space for future file header extensions (zero-padded)
 */
export const HEADER_OFFSET_RESERVED = 40;

// ============================================================================
// Page 1 & Catalog Space Partition Offsets and Limits
// ============================================================================

/**
 * Page 1 Space Partition Map (4 KB Total):
 * +------------+-------+----------------------+--------------------------------------+
 * | Byte Range | Size  | Partition Region     | Description                          |
 * +------------+-------+----------------------+--------------------------------------+
 * | 0..99      | 100B  | FILE_HEADER          | Database file header                 |
 * | 100..2147  | 2048B | MASTER_TABLE_CATALOG | 16 Table Descriptors (128B each)     |
 * | 2148..3171 | 1024B | INDEX_CATALOG        | 8 Index Descriptors (128B each)      |
 * | 3172..3175 | 4B    | NEXT_DESCRIPTOR_PAGE | Chained descriptor page pointer      |
 * | 3176..4095 | 920B  | SYSPAGE_RESERVED     | Reserved space for Page 1 extensions |
 * +------------+-------+----------------------+--------------------------------------+
 * | Total: 4096 Bytes (Full Page 1 Allocation)                                       |
 * +----------------------------------------------------------------------------------+
 */

/**
 * Maximum number of table descriptors that fit in Page 1 (16).
 */
export const MAX_TABLES_SYSPAGE = 16;

/**
 * Maximum number of index descriptors that fit in Page 1 (8).
 */
export const MAX_INDEXES_SYSPAGE = 8;

/**
 * Alias for MAX_TABLES_SYSPAGE.
 */
export const MAX_TABLES_PAGE1 = 16;

/**
 * Alias for MAX_INDEXES_SYSPAGE.
 */
export const MAX_INDEXES_PAGE1 = 8;

/**
 * Byte offset where master table descriptors start in Page 1 (byte 100).
 */
export const MASTER_TABLE_OFFSET = 100;

/**
 * Byte offset where index descriptors start in Page 1 (100 + 16 * 128 = 2148).
 */
export const INDEX_CATALOG_OFFSET = 2148;

/**
 * Byte offset for chained descriptor page pointer (2148 + 8 * 128 = 3172).
 */
export const NEXT_DESCRIPTOR_CATALOG_PAGE_OFFSET = 3172;

/**
 * Size in bytes of chained descriptor catalog page pointer (4 bytes).
 */
export const NEXT_DESCRIPTOR_CATALOG_PAGE_SIZE = 4;

/**
 * Byte offset for Page 1 reserved partition (3172 + 4 = 3176).
 */
export const SYSPAGE_RESERVED_OFFSET = 3176;

/**
 * Size in bytes of Page 1 reserved partition (4096 - 3176 = 920).
 */
export const SYSPAGE_RESERVED_SIZE = 920;

/**
 * Maximum column records per catalog page: floor((4096 - 16) / 72) = 56.
 */
export const MAX_COLUMNS_PER_CATALOG_PAGE = 56;

/**
 * Maximum columns supported per table across all catalog pages (256).
 */
export const MAX_COLUMNS_PER_TABLE = 256;

// ============================================================================
// 2. TABLE DESCRIPTOR Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for TABLE_DESCRIPTOR:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | TABLE_ID (2B)                     | COLUMN_COUNT (2B)                 |
 * +-----------------------------------+-----------------------------------+
 * | ROOT_PAGE_ID (4B)                                                     |
 * +-----------------------------------------------------------------------+
 * | COL_CATALOG_PAGE_ID (4B)                                              |
 * +-----------------------------------------------------------------------+
 * | Bytes 12..75 (64B): NAME (char[64])                                   |
 * +-----------------------------------------------------------------------+
 * | FLAGS (4B)                                                            |
 * +-----------------------------------------------------------------------+
 * | ROW_COUNT_ESTIMATE (4B)                                               |
 * +-----------------------------------------------------------------------+
 * | Bytes 84..91 (8B): AUTO_INC_NEXT (uint64_t)                           |
 * +-----------------------------------------------------------------------+
 * | Bytes 92..127 (36B): RESERVED (uint8_t[36])                           |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+---------------------+-------------+------------------------------------------------+
 * | Offset | Size | Field Name          | Type        | Description                                    |
 * +--------+------+---------------------+-------------+------------------------------------------------+
 * | 0      | 2B   | TABLE_ID            | uint16_t    | uint16_t table_id (1-based, 0 = inactive slot) |
 * | 2      | 2B   | COLUMN_COUNT        | uint16_t    | uint16_t total columns in table                |
 * | 4      | 4B   | ROOT_PAGE_ID        | uint32_t    | uint32_t root data pageId                      |
 * | 8      | 4B   | COL_CATALOG_PAGE_ID | uint32_t    | uint32_t first column catalog pageId           |
 * | 12     | 64B  | NAME                | char[64]    | 64 bytes UTF-8 fixed string (null-padded)      |
 * | 76     | 4B   | FLAGS               | uint32_t    | uint32_t table flags (WAL, system, etc.)       |
 * | 80     | 4B   | ROW_COUNT_ESTIMATE  | uint32_t    | uint32_t estimated row count                   |
 * | 84     | 8B   | AUTO_INC_NEXT       | uint64_t    | uint64_t next auto_increment ID                |
 * | 92     | 36B  | RESERVED            | uint8_t[36] | 36 bytes reserved space (92..127)              |
 * +--------+------+---------------------+-------------+------------------------------------------------+
 * | Total: 128 Bytes                                                                                   |
 * +----------------------------------------------------------------------------------------------------+
 */
export const TABLE_DESCRIPTOR_FIELDS = [
  ["TABLE_ID", 2], // uint16_t
  ["COLUMN_COUNT", 2], // uint16_t
  ["ROOT_PAGE_ID", 4], // uint32_t
  ["COL_CATALOG_PAGE_ID", 4], // uint32_t
  ["NAME", 64], // char[64]
  ["FLAGS", 4], // uint32_t
  ["ROW_COUNT_ESTIMATE", 4], // uint32_t
  ["AUTO_INC_NEXT", 8], // uint64_t
  ["RESERVED", 36], // uint8_t[36]
] as const;

/**
 * Total size in bytes of a single table descriptor record (128 bytes).
 */
export const TABLE_DESCRIPTOR_SIZE = 128;

/**
 * uint16_t table_id (1-based, 0 = inactive slot)
 */
export const TABLE_DESCRIPTOR_OFFSET_TABLE_ID = 0;

/**
 * uint16_t total columns in table
 */
export const TABLE_DESCRIPTOR_OFFSET_COLUMN_COUNT = 2;

/**
 * uint32_t root data pageId
 */
export const TABLE_DESCRIPTOR_OFFSET_ROOT_PAGE_ID = 4;

/**
 * uint32_t first column catalog pageId
 */
export const TABLE_DESCRIPTOR_OFFSET_COL_CATALOG_PAGE_ID = 8;

/**
 * 64 bytes UTF-8 fixed string (null-padded)
 */
export const TABLE_DESCRIPTOR_OFFSET_NAME = 12;

/**
 * uint32_t table flags (WAL, system, etc.)
 */
export const TABLE_DESCRIPTOR_OFFSET_FLAGS = 76;

/**
 * uint32_t estimated row count
 */
export const TABLE_DESCRIPTOR_OFFSET_ROW_COUNT_ESTIMATE = 80;

/**
 * uint64_t next auto_increment ID
 */
export const TABLE_DESCRIPTOR_OFFSET_AUTO_INC_NEXT = 84;

/**
 * 36 bytes reserved space (92..127)
 */
export const TABLE_DESCRIPTOR_OFFSET_RESERVED = 92;

// ============================================================================
// 3. INDEX DESCRIPTOR Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for INDEX_DESCRIPTOR:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | INDEX_ID (2B)                     | TABLE_ID (2B)                     |
 * +-----------------------------------+-----------------------------------+
 * | ROOT_PAGE_ID (4B)                                                     |
 * +-----------------------------------------------------------------------+
 * | COLUMN_COUNT (1B) | FLAGS (1B)      | COLUMN_INDICES [0..1]             |
 * +-----------------+-----------------+-----------------------------------+
 * | COLUMN_INDICES [2..5]                                                 |
 * +-----------------------------------------------------------------------+
 * | COLUMN_INDICES [6..9]                                                 |
 * +-----------------------------------------------------------------------+
 * | COLUMN_INDICES [10..13]                                               |
 * +-----------------------------------------------------------------------+
 * | COLUMN_INDICES [14..15]           | COL_DIRECTIONS [0..1]             |
 * +-----------------------------------+-----------------------------------+
 * | COL_DIRECTIONS [2..5]                                                 |
 * +-----------------------------------------------------------------------+
 * | COL_DIRECTIONS [6..7]             | NAME [0..1]                       |
 * +-----------------------------------+-----------------------------------+
 * | NAME [2..5]                                                           |
 * +-----------------------------------------------------------------------+
 * | NAME [6..9]                                                           |
 * +-----------------------------------------------------------------------+
 * | NAME [10..13]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [14..17]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [18..21]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [22..25]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [26..29]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [30..33]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [34..37]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [38..41]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [42..45]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [46..49]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [50..53]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [54..57]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [58..61]                                                         |
 * +-----------------------------------------------------------------------+
 * | NAME [62..63]                     | RESERVED [0..1]                   |
 * +-----------------------------------+-----------------------------------+
 * | RESERVED [2..5]                                                       |
 * +-----------------------------------------------------------------------+
 * | RESERVED [6..9]                                                       |
 * +-----------------------------------------------------------------------+
 * | RESERVED [10..13]                                                     |
 * +-----------------------------------------------------------------------+
 * | RESERVED [14..17]                                                     |
 * +-----------------------------------------------------------------------+
 * | RESERVED [18..21]                                                     |
 * +-----------------------------------------------------------------------+
 * | RESERVED [22..25]                                                     |
 * +-----------------------------------------------------------------------+
 * | RESERVED [26..29]                                                     |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+----------------+-------------+------------------------------------------------+
 * | Offset | Size | Field Name     | Type        | Description                                    |
 * +--------+------+----------------+-------------+------------------------------------------------+
 * | 0      | 2B   | INDEX_ID       | uint16_t    | uint16_t index_id (1-based, 0 = inactive slot) |
 * | 2      | 2B   | TABLE_ID       | uint16_t    | uint16_t target table_id                       |
 * | 4      | 4B   | ROOT_PAGE_ID   | uint32_t    | uint32_t root index pageId                     |
 * | 8      | 1B   | COLUMN_COUNT   | uint8_t     | uint8_t indexed column count (1..8)            |
 * | 9      | 1B   | FLAGS          | uint8_t     | uint8_t index flags (unique, primary, etc.)    |
 * | 10     | 16B  | COLUMN_INDICES | uint16_t[8] | 8 * uint16_t column indices (16 bytes)         |
 * | 26     | 8B   | COL_DIRECTIONS | uint8_t[8]  | 8 * uint8_t sort directions (8 bytes: 0=ASC... |
 * | 34     | 64B  | NAME           | char[64]    | 64 bytes UTF-8 fixed string (null-padded)      |
 * | 98     | 30B  | RESERVED       | uint8_t[30] | 30 bytes reserved space (98..127)              |
 * +--------+------+----------------+-------------+------------------------------------------------+
 * | Total: 128 Bytes                                                                              |
 * +-----------------------------------------------------------------------------------------------+
 */
export const INDEX_DESCRIPTOR_FIELDS = [
  ["INDEX_ID", 2], // uint16_t
  ["TABLE_ID", 2], // uint16_t
  ["ROOT_PAGE_ID", 4], // uint32_t
  ["COLUMN_COUNT", 1], // uint8_t
  ["FLAGS", 1], // uint8_t
  ["COLUMN_INDICES", 16], // uint16_t[8]
  ["COL_DIRECTIONS", 8], // uint8_t[8]
  ["NAME", 64], // char[64]
  ["RESERVED", 30], // uint8_t[30]
] as const;

/**
 * Total size in bytes of a single index descriptor record (128 bytes).
 */
export const INDEX_DESCRIPTOR_SIZE = 128;

/**
 * uint16_t index_id (1-based, 0 = inactive slot)
 */
export const INDEX_DESCRIPTOR_OFFSET_INDEX_ID = 0;

/**
 * uint16_t target table_id
 */
export const INDEX_DESCRIPTOR_OFFSET_TABLE_ID = 2;

/**
 * uint32_t root index pageId
 */
export const INDEX_DESCRIPTOR_OFFSET_ROOT_PAGE_ID = 4;

/**
 * uint8_t indexed column count (1..8)
 */
export const INDEX_DESCRIPTOR_OFFSET_COLUMN_COUNT = 8;

/**
 * uint8_t index flags (unique, primary, etc.)
 */
export const INDEX_DESCRIPTOR_OFFSET_FLAGS = 9;

/**
 * 8 * uint16_t column indices (16 bytes)
 */
export const INDEX_DESCRIPTOR_OFFSET_COLUMN_INDICES = 10;

/**
 * 8 * uint8_t sort directions (8 bytes: 0=ASC, 1=DESC)
 */
export const INDEX_DESCRIPTOR_OFFSET_COL_DIRECTIONS = 26;

/**
 * 64 bytes UTF-8 fixed string (null-padded)
 */
export const INDEX_DESCRIPTOR_OFFSET_NAME = 34;

/**
 * 30 bytes reserved space (98..127)
 */
export const INDEX_DESCRIPTOR_OFFSET_RESERVED = 98;

// ============================================================================
// 4. CATALOG PAGE HEADER Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for CATALOG_PAGE_HEADER:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | PAGE_TYPE (1B)  | FLAGS (1B)      | COL_COUNT_IN_PAGE (2B)            |
 * +-----------------+-----------------+-----------------------------------+
 * | TABLE_ID (2B)                     | START_COL_INDEX (2B)              |
 * +-----------------------------------+-----------------------------------+
 * | NEXT_COL_CATALOG_PAGE_ID (4B)                                         |
 * +-----------------------------------------------------------------------+
 * | PAGE_CHECKSUM (4B)                                                    |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+--------------------------+----------+------------------------------------------------+
 * | Offset | Size | Field Name               | Type     | Description                                    |
 * +--------+------+--------------------------+----------+------------------------------------------------+
 * | 0      | 1B   | PAGE_TYPE                | uint8_t  | uint8_t 0x0C (PAGE_TYPE_CATALOG_PAGE)          |
 * | 1      | 1B   | FLAGS                    | uint8_t  | uint8_t reserved / flags                       |
 * | 2      | 2B   | COL_COUNT_IN_PAGE        | uint16_t | uint16_t columns stored in this page (0..56)   |
 * | 4      | 2B   | TABLE_ID                 | uint16_t | uint16_t table_id this page belongs to         |
 * | 6      | 2B   | START_COL_INDEX          | uint16_t | uint16_t starting global column index          |
 * | 8      | 4B   | NEXT_COL_CATALOG_PAGE_ID | uint32_t | uint32_t next column catalog pageId (0 = tail) |
 * | 12     | 4B   | PAGE_CHECKSUM            | uint32_t | uint32_t crc32 checksum                        |
 * +--------+------+--------------------------+----------+------------------------------------------------+
 * | Total: 16 Bytes                                                                                      |
 * +------------------------------------------------------------------------------------------------------+
 */
export const CATALOG_PAGE_HEADER_FIELDS = [
  ["PAGE_TYPE", 1], // uint8_t
  ["FLAGS", 1], // uint8_t
  ["COL_COUNT_IN_PAGE", 2], // uint16_t
  ["TABLE_ID", 2], // uint16_t
  ["START_COL_INDEX", 2], // uint16_t
  ["NEXT_COL_CATALOG_PAGE_ID", 4], // uint32_t
  ["PAGE_CHECKSUM", 4], // uint32_t
] as const;

/**
 * Total size in bytes of a dedicated column catalog page header (16 bytes).
 */
export const CATALOG_PAGE_HEADER_SIZE = 16;

/**
 * uint8_t 0x0C (PAGE_TYPE_CATALOG_PAGE)
 */
export const CATALOG_PAGE_HEADER_OFFSET_PAGE_TYPE = 0;

/**
 * uint8_t reserved / flags
 */
export const CATALOG_PAGE_HEADER_OFFSET_FLAGS = 1;

/**
 * uint16_t columns stored in this page (0..56)
 */
export const CATALOG_PAGE_HEADER_OFFSET_COL_COUNT_IN_PAGE = 2;

/**
 * uint16_t table_id this page belongs to
 */
export const CATALOG_PAGE_HEADER_OFFSET_TABLE_ID = 4;

/**
 * uint16_t starting global column index
 */
export const CATALOG_PAGE_HEADER_OFFSET_START_COL_INDEX = 6;

/**
 * uint32_t next column catalog pageId (0 = tail)
 */
export const CATALOG_PAGE_HEADER_OFFSET_NEXT_COL_CATALOG_PAGE_ID = 8;

/**
 * uint32_t crc32 checksum
 */
export const CATALOG_PAGE_HEADER_OFFSET_PAGE_CHECKSUM = 12;

// ============================================================================
// 5. COLUMN META Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for COLUMN_META:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | TYPE (1B)       | FLAGS (1B)      | COL_OFFSET (2B)                   |
 * +-----------------+-----------------+-----------------------------------+
 * | Bytes 4..67 (64B): NAME (char[64])                                    |
 * +-----------------------------------------------------------------------+
 * | RESERVED (4B)                                                         |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+------------+------------+------------------------------------------------+
 * | Offset | Size | Field Name | Type       | Description                                    |
 * +--------+------+------------+------------+------------------------------------------------+
 * | 0      | 1B   | TYPE       | uint8_t    | uint8_t DataType enum (1..7)                   |
 * | 1      | 1B   | FLAGS      | uint8_t    | uint8_t ColumnFlag bitmask (NOT_NULL, PRIMA... |
 * | 2      | 2B   | COL_OFFSET | uint16_t   | uint16_t fixed-slice offset or var-table index |
 * | 4      | 64B  | NAME       | char[64]   | 64 bytes UTF-8 column name (null-padded)       |
 * | 68     | 4B   | RESERVED   | uint8_t[4] | 4 bytes reserved (68..71)                      |
 * +--------+------+------------+------------+------------------------------------------------+
 * | Total: 72 Bytes                                                                          |
 * +------------------------------------------------------------------------------------------+
 */
export const COLUMN_META_FIELDS = [
  ["TYPE", 1], // uint8_t
  ["FLAGS", 1], // uint8_t
  ["COL_OFFSET", 2], // uint16_t
  ["NAME", 64], // char[64]
  ["RESERVED", 4], // uint8_t[4]
] as const;

/**
 * Total size in bytes of a single column metadata record (72 bytes).
 */
export const COLUMN_META_SIZE = 72;

/**
 * uint8_t DataType enum (1..7)
 */
export const COLUMN_META_OFFSET_TYPE = 0;

/**
 * uint8_t ColumnFlag bitmask (NOT_NULL, PRIMARY_KEY, etc.)
 */
export const COLUMN_META_OFFSET_FLAGS = 1;

/**
 * uint16_t fixed-slice offset or var-table index
 */
export const COLUMN_META_OFFSET_COL_OFFSET = 2;

/**
 * 64 bytes UTF-8 column name (null-padded)
 */
export const COLUMN_META_OFFSET_NAME = 4;

/**
 * 4 bytes reserved (68..71)
 */
export const COLUMN_META_OFFSET_RESERVED = 68;

