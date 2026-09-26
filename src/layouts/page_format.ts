/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/page_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

/**
 * ============================================================================
 * CRITICAL WARNING: FROZEN ON-DISK PAGE FORMAT SPECIFICATION
 * DO NOT alter the order, types, or byte lengths of existing fields in this
 * layout! Changing any field offset will invalidate existing binary databases,
 * break cross-version read compatibility, and result in unrecoverable data
 * corruption.
 *
 * Any future extensions MUST use designated reserved bytes or bump
 * CURRENT_ENGINE_VERSION and CURRENT_MIN_READ_VERSION.
 * ============================================================================
 */

/**
 * Standard uniform page size in bytes across the entire database engine (4 KB).
 * Every page in the database file and buffer pool is rigidly aligned to this size.
 */
export const PAGE_SIZE = 4096;

/**
 * Strict maximum size in bytes allowed for a single serialized row record (2 KB).
 * Enforces the B-tree invariant that at least two rows fit on a leaf data page
 * without requiring overflow chaining in the v1 engine.
 */
export const MAX_ROW_SIZE = 2048;

// ============================================================================
// 1. SLOTTED PAGE HEADER Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for SLOTTED_PAGE_HEADER:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | TYPE (1B)       | FLAGS (1B)      | CELL_COUNT (2B)                   |
 * +-----------------+-----------------+-----------------------------------+
 * | CONTENT_OFFSET (2B)               | NEXT_PAGE_ID [0..1]               |
 * +-----------------------------------+-----------------------------------+
 * | NEXT_PAGE_ID [2..3]               | FREE_BYTES (2B)                   |
 * +-----------------------------------+-----------------------------------+
 * | CHECKSUM (4B)                                                         |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+----------------+----------+----------------------------------------------+
 * | Offset | Size | Field Name     | Type     | Description                                  |
 * +--------+------+----------------+----------+----------------------------------------------+
 * | 0      | 1B   | TYPE           | uint8_t  | Identifies the page structure and role.      |
 * | 1      | 1B   | FLAGS          | uint8_t  | Flags and reserved attributes for this page. |
 * | 2      | 2B   | CELL_COUNT     | uint16_t | Number of active records/cells               |
 * | 4      | 2B   | CONTENT_OFFSET | uint16_t | Byte offset pointing to the start            |
 * | 6      | 4B   | NEXT_PAGE_ID   | uint32_t | Multifunctional 32-bit pointer:              |
 * | 10     | 2B   | FREE_BYTES     | uint16_t | Cumulative count of fragmented               |
 * | 12     | 4B   | CHECKSUM       | uint32_t | IEEE 802.3 CRC32 checksum computed           |
 * +--------+------+----------------+----------+----------------------------------------------+
 * | Total: 16 Bytes                                                                          |
 * +------------------------------------------------------------------------------------------+
 */
/**
 * Ordered sequence of fields composing the 16-byte header of all standard
 * data and interior pages (pages 2+).
 * Defined as an immutable array of `[fieldName, byteSize]` tuples to guarantee
 * strict byte ordering across all JavaScript/TypeScript runtime engines.
 */
export const SLOTTED_PAGE_HEADER_FIELDS = [
  ["TYPE", 1], // uint8_t
  ["FLAGS", 1], // uint8_t
  ["CELL_COUNT", 2], // uint16_t
  ["CONTENT_OFFSET", 2], // uint16_t
  ["NEXT_PAGE_ID", 4], // uint32_t
  ["FREE_BYTES", 2], // uint16_t
  ["CHECKSUM", 4], // uint32_t
] as const;

/**
 * Total size in bytes of the standard slotted page header (16 bytes).
 */
export const PAGE_HEADER_SIZE = 16;

// Offsets for SLOTTED_PAGE_HEADER
/**
 * Byte offset 0 (uint8_t): Identifies the page structure and role.
 * Valid types:
 * - `0x00` (PAGE_TYPE_FREE): Free/recycled page on the free list.
 * - `0x02` (PAGE_TYPE_INDEX_INTERIOR): B-tree index interior node.
 * - `0x05` (PAGE_TYPE_TABLE_INTERIOR): B-tree table interior routing node.
 * - `0x0A` (PAGE_TYPE_INDEX_LEAF): B-tree index leaf node.
 * - `0x0C` (PAGE_TYPE_CATALOG_PAGE): Dedicated column catalog page.
 * - `0x0D` (PAGE_TYPE_LEAF_DATA): Table leaf data page storing rows.
 */
export const PAGE_HEADER_OFFSET_TYPE = 0;

/**
 * Byte offset 1 (uint8_t): Flags and reserved attributes for this page.
 * Initialized to `0x00` in v1.
 */
export const PAGE_HEADER_OFFSET_FLAGS = 1;

/**
 * Byte offset 2 (uint16_t, little-endian): Number of active records/cells
 * stored on this page. Also specifies the count of 2-byte slot directory entries.
 */
export const PAGE_HEADER_OFFSET_CELL_COUNT = 2;

/**
 * Byte offset 4 (uint16_t, little-endian): Byte offset pointing to the start
 * of the lower cell payload boundary. Payloads are allocated from byte 4096
 * growing upwards toward the slot directory. An empty page has this set to 4096.
 */
export const PAGE_HEADER_OFFSET_CONTENT_OFFSET = 4;

/**
 * Byte offset 6 (uint32_t, little-endian): Multifunctional 32-bit pointer:
 * - Table Leaf Data (0x0D): Forward sibling pointer (`next_page_id`) linking data pages.
 * - Table Interior (0x05): Rightmost child pointer (`right_child_page_id`).
 * - Free Page (0x00): Next pageId on the free list chain (`next_free_page_id`).
 */
export const PAGE_HEADER_OFFSET_NEXT_PAGE_ID = 6;

/**
 * Byte offset 10 (uint16_t, little-endian): Cumulative count of fragmented
 * unallocated bytes left behind by deleted or shrunk records. This space is
 * reclaimed when page defragmentation (`compactPage`) is invoked.
 */
export const PAGE_HEADER_OFFSET_FREE_BYTES = 10;

/**
 * Byte offset 12 (uint32_t, little-endian): IEEE 802.3 CRC32 checksum computed
 * over the entire 4KB page (with bytes 12..15 zeroed during calculation) to detect
 * torn writes or on-disk storage corruption.
 */
export const PAGE_HEADER_OFFSET_CHECKSUM = 12;

// ============================================================================
// 2. TABLE INTERIOR CELL Layout
// ============================================================================

/**
 * 32-bit Word Byte Layout Grid for TABLE_INTERIOR_CELL:
 *   Byte 0           Byte 1           Byte 2           Byte 3         
 * +-----------------+-----------------+-----------------+-----------------+
 * | CHILD_PAGE_ID (4B)                                                    |
 * +-----------------------------------------------------------------------+
 * | Bytes 4..11 (8B): ROWID (int64_t)                                     |
 * +-----------------------------------------------------------------------+
 *
 * Field Details:
 * +--------+------+---------------+----------+-------------+
 * | Offset | Size | Field Name    | Type     | Description |
 * +--------+------+---------------+----------+-------------+
 * | 0      | 4B   | CHILD_PAGE_ID | uint32_t |             |
 * | 4      | 8B   | ROWID         | int64_t  |             |
 * +--------+------+---------------+----------+-------------+
 * | Total: 12 Bytes                                        |
 * +--------------------------------------------------------+
 */
/**
 * Ordered sequence of fields composing a single 12-byte routing cell in a
 * Table Interior B-tree node (`page_type = 0x05`).
 */
export const TABLE_INTERIOR_CELL_FIELDS = [
  ["CHILD_PAGE_ID", 4], // uint32_t
  ["ROWID", 8], // int64_t
] as const;

/**
 * Total size in bytes of a single table interior cell (12 bytes).
 * Composed of a 4-byte child `page_id` and an 8-byte signed `rowid` separator key.
 */
export const TABLE_INTERIOR_CELL_SIZE = 12;

// Offsets for TABLE_INTERIOR_CELL
/**
 * Byte offset 0 within an interior cell (uint32_t, little-endian):
 * The `page_id` of the child subtree containing keys less than or equal to `rowid`.
 */
export const TABLE_INTERIOR_CELL_OFFSET_CHILD_PAGE_ID = 0;

/**
 * Byte offset 4 within an interior cell (int64_t, little-endian):
 * The separator `rowid` key. Keys $\le \text{rowid}$ route to `child_page_id`;
 * keys $> \text{rowid}$ continue searching to the right.
 */
export const TABLE_INTERIOR_CELL_OFFSET_ROWID = 4;

/**
 * Maximum number of 12-byte interior cells that can fit inside one 4KB interior page:
 * \lfloor(4096 - 16) / (12 + 2)\rfloor = 291 cells (where 2 is the slot directory entry size).
 */
export const MAX_TABLE_INTERIOR_CELLS = 291;

/**
 * Median split index for interior page splits. When splitting a full 291-cell
 * interior node, entry 145 is promoted to the parent routing node.
 */
export const TABLE_INTERIOR_SPLIT_INDEX = 145;

