export const PAGE_SIZE = 4096;
export const MAX_ROW_SIZE = 2048;
export const FILE_HEADER_SIZE = 100;
export const PAGE_HEADER_SIZE = 12;

// Page types
export const PAGE_TYPE_LEAF_DATA = 0x0D;

// Page 1 File Header Offsets
export const HEADER_OFFSET_MAGIC = 0;
export const HEADER_OFFSET_PAGE_SIZE = 6;
export const HEADER_OFFSET_TOTAL_PAGES = 8;
export const HEADER_OFFSET_FREE_PAGE_HEAD = 12;
export const HEADER_OFFSET_SCHEMA_VERSION = 16;

// Binary Master Table Layout (Page 1: bytes 100..4095)
export const MASTER_TABLE_OFFSET = 100;
export const MAX_TABLES = 10;
export const MAX_COLUMNS_PER_TABLE = 16;
export const COLUMN_META_SIZE = 20; // 1B type + 1B flags + 2B colOffset + 16B name
export const TABLE_META_HEADER_SIZE = 24; // 2B id + 2B count + 4B rootPage + 16B name
export const TABLE_META_SIZE = TABLE_META_HEADER_SIZE + (MAX_COLUMNS_PER_TABLE * COLUMN_META_SIZE); // 24 + 320 = 344 bytes

// Memory Layout in ArrayBuffer (Prototype: 64 slots = 256KB)
export const DEFAULT_PAGE_SLOTS = 64;
export const RESULT_BUFFER_OFFSET = 64 * PAGE_SIZE; // Byte 262,144 (0x40000)
export const RESULT_BUFFER_SIZE = 32 * 1024;        // 32 KB
export const VM_CONTEXT_OFFSET = RESULT_BUFFER_OFFSET + RESULT_BUFFER_SIZE; // 294,912
export const TOTAL_MEMORY_BYTES = VM_CONTEXT_OFFSET + 8192; // ~303 KB (~5 Wasm pages)
