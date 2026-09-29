// Re-export all layout-computed offsets and structures
export * from "./layouts/index.ts";

// Engine Versions
export const CURRENT_ENGINE_VERSION = 1;
export const CURRENT_MIN_READ_VERSION = 1;

// Page Types (§4.2)
export const PAGE_TYPE_FREE = 0x00;
export const PAGE_TYPE_INDEX_INTERIOR = 0x02;
export const PAGE_TYPE_TABLE_INTERIOR = 0x05;
export const PAGE_TYPE_INDEX_LEAF = 0x0a;
export const PAGE_TYPE_CATALOG_PAGE = 0x0c;
export const PAGE_TYPE_LEAF_DATA = 0x0d;

// VmContext Frame Limits
export const VM_FRAME_SIZE = 1280;
export const VM_FRAME_COUNT = 8;
export const MAX_REGISTERS_PER_FRAME = 64;
export const MAX_CURSORS_PER_FRAME = 16;
export const MAX_SUBQUERY_DEPTH = 7;

// WAL Specifications
export const WAL_HEADER_SIZE = 32;
export const WAL_FRAME_HEADER_SIZE = 32;
export const WAL_FRAME_SIZE = 4128; // 32B frame header + 4096B page

// Sorter & Query Optimization Limits
export const MAX_TOPK_HEAP_LIMIT = 10000;
export const MAX_IN_LIST_SIZE = 10000;
