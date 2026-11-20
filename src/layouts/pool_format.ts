/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/pool_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

import { PAGE_SIZE } from "./page_format.js";

// ============================================================================
// Buffer Pool & Shared Memory Architecture Layout
// ============================================================================

/**
 * Top of the WASM C stack inside WASM_REGION (0x00C000 = 48 KB).
 */
export const WASM_STACK_TOP = 49152;

/**
 * Reserved low region for WASM C stack (48 KB) and .rodata/.data/.bss (16 KB) at 0x000000..0x00FFFF.
 */
export const WASM_REGION_SIZE = 65536;

/**
 * Default cache buffer pool size in bytes (4 MB = 1024 * 4096).
 */
export const DEFAULT_CACHE_SIZE_BYTES = 4194304;

/**
 * Default number of page cache slots in the buffer pool (1024).
 */
export const DEFAULT_SLOT_COUNT = 1024;

/**
 * Maximum supported number of page cache slots in the buffer pool (65536 = 256 MB).
 */
export const MAX_SLOT_COUNT = 65536;

/**
 * Alias for DEFAULT_SLOT_COUNT (1024).
 */
export const DEFAULT_PAGE_SLOTS = 1024;

/**
 * Default number of hash table buckets for page-to-slot mapping (2048, load factor <= 50%).
 */
export const DEFAULT_PAGE_TO_SLOT_BUCKETS = 2048;

/**
 * Size in bytes of each hash table bucket (uint32 page_id + uint32 slot_idx = 8 bytes).
 */
export const PAGE_TO_SLOT_BUCKET_SIZE = 8;

/**
 * Total size in bytes of the page-to-slot hash table (2048 * 8 = 16 KB).
 */
export const PAGE_TO_SLOT_SIZE = 16384;

/**
 * Size in bytes allocated for VM execution context state (12 KB).
 */
export const VM_CONTEXT_SIZE = 12288;

/**
 * Size in bytes allocated for SQL result row serialization buffer (64 KB).
 */
export const RESULT_BUFFER_SIZE = 65536;

/**
 * Size in bytes allocated for compiled query bytecode instructions (32 KB).
 */
export const BYTECODE_SIZE = 32768;

/**
 * Size in bytes allocated for temporary single-page staging / decompression (4 KB).
 */
export const PAGE_SCRATCHPAD_SIZE = 4096;

/**
 * Padding bytes aligning the start of dynamic page slots to 0x030000 (16 KB).
 */
export const ALIGNMENT_PADDING_SIZE = 16384;

/**
 * Maximum memory limit in bytes for transient query execution arena (16 MB).
 */
export const DEFAULT_MAX_QUERY_MEMORY = 16777216;

/**
 * Shared Memory Architecture Map (1024 Slots / 4MB Cache Default):
 * +----------------------+----------+-------------------------+------------------------------------------------+
 * | Memory Address Range | Size     | Region Name             | Description                                    |
 * +----------------------+----------+-------------------------+------------------------------------------------+
 * | 0x0..0xFFFF          | 65536B   | WASM_REGION             | WASM C stack (0x000000..0x00BFFF) and .roda... |
 * | 0x10000..0x12FFF     | 12288B   | VM_CONTEXT              | Execution context frames for the SQL VM.       |
 * | 0x13000..0x22FFF     | 65536B   | RESULT_BUFFER           | Output buffer for query result rows.           |
 * | 0x23000..0x2AFFF     | 32768B   | BYTECODE                | Instruction buffer for compiled bytecode ro... |
 * | 0x2B000..0x2BFFF     | 4096B    | PAGE_SCRATCHPAD         | Staging buffer for page compression or I/O ... |
 * | 0x2C000..0x2FFFF     | 16384B   | ALIGNMENT_PADDING       | Padding aligning page slots to 64 KB bounda... |
 * | 0x30000..0x42FFFF    | 4194304B | PAGE_SLOTS              | Contiguous 4 KB buffer pool page slots (def... |
 * | 0x430000..0x430FFF   | 4096B    | SLOT_TO_PAGE            | Array of uint32 pageIds mapping slot -> pag... |
 * | 0x431000..0x434FFF   | 16384B   | PAGE_TO_SLOT            | Open-addressing hash table mapping pageId -... |
 * | 0x435000..0x43507F   | 128B     | DIRTY_MASK              | Bitmask tracking dirty slots.                  |
 * | 0x435080..0x43FFFF   | 44928B   | ARENA_ALIGNMENT_PADDING | Padding aligning transient arena to 64 KB b... |
 * +----------------------+----------+-------------------------+------------------------------------------------+
 * | Arena Start: 0x440000 | Total Regions: 4456448 Bytes                                                       |
 * +------------------------------------------------------------------------------------------------------------+
 */
export const DEFAULT_BUFFER_POOL_REGIONS = [
  ["WASM_REGION", 65536],
  ["VM_CONTEXT", 12288],
  ["RESULT_BUFFER", 65536],
  ["BYTECODE", 32768],
  ["PAGE_SCRATCHPAD", 4096],
  ["ALIGNMENT_PADDING", 16384],
  ["PAGE_SLOTS", 4194304],
  ["SLOT_TO_PAGE", 4096],
  ["PAGE_TO_SLOT", 16384],
  ["DIRTY_MASK", 128],
  ["ARENA_ALIGNMENT_PADDING", 44928],
] as const;

/**
 * Byte offset 0x000000: WASM C stack (0x000000..0x00BFFF) and .rodata/.data/.bss (0x00C000..0x00FFFF).
 */
export const WASM_REGION_OFFSET = 0; // 0x0

/**
 * Byte offset 0x010000: Execution context frames for the SQL VM.
 */
export const VM_CONTEXT_OFFSET = 65536; // 0x10000

/**
 * Byte offset 0x013000: Output buffer for query result rows.
 */
export const RESULT_BUFFER_OFFSET = 77824; // 0x13000

/**
 * Byte offset 0x023000: Instruction buffer for compiled bytecode routines.
 */
export const BYTECODE_OFFSET = 143360; // 0x23000

/**
 * Byte offset 0x02B000: Staging buffer for page compression or I/O reassembly.
 */
export const PAGE_SCRATCHPAD_OFFSET = 176128; // 0x2B000

/**
 * Byte offset 0x02C000: Padding aligning page slots to 64 KB boundary 0x030000.
 */
export const ALIGNMENT_PADDING_OFFSET = 180224; // 0x2C000

/**
 * Byte offset 0x030000: Contiguous 4 KB buffer pool page slots (default 1024 slots = 4 MB).
 */
export const SLOTS_BASE_OFFSET = 196608; // 0x30000

/**
 * Byte offset 0x430000 (default 1024 slots): Array of uint32 pageIds mapping slot -> pageId.
 */
export const SLOT_TO_PAGE_OFFSET = 4390912; // 0x430000

/**
 * Byte offset 0x431000 (default 1024 slots): Open-addressing hash table mapping pageId -> slot.
 */
export const PAGE_TO_SLOT_OFFSET = 4395008; // 0x431000

/**
 * Byte offset 0x435000 (default 1024 slots): Bitmask tracking dirty slots.
 */
export const DIRTY_MASK_OFFSET = 4411392; // 0x435000

/**
 * Byte offset 0x435080 (default 1024 slots): Padding aligning transient arena to 64 KB boundary 0x440000.
 */
export const ARENA_ALIGNMENT_PADDING_OFFSET = 4411520; // 0x435080

/**
 * Byte offset 0x440000 (default 1024 slots): Start of dynamic transient query execution arena.
 */
export const TRANSIENT_ARENA_OFFSET = 4456448; // 0x440000

/**
 * Total buffer pool and shared Wasm memory allocation in bytes for default 1024 slots (20.25 MB).
 */
export const TOTAL_MEMORY_BYTES = 21233664;

/**
 * Computes memory layout offsets for arbitrary slot counts.
 * Fixed engine & WASM regions sit at 0x000000..0x02FFFF; page slots, pool metadata,
 * and the transient query arena scale dynamically starting at SLOTS_BASE_OFFSET (0x030000).
 */
export function computeBufferPoolOffsets(
  slotCount: number,
  _maxQueryMemory: number = DEFAULT_MAX_QUERY_MEMORY,
) {
  const slotsBaseOffset = SLOTS_BASE_OFFSET;
  const slotsEndOffset = slotsBaseOffset + slotCount * PAGE_SIZE;
  const slotToPageBytes = (slotCount * 4 + 7) & ~7;
  let pageToSlotBuckets = 16;
  while (pageToSlotBuckets < slotCount * 2) {
    pageToSlotBuckets <<= 1;
  }
  const pageToSlotBytes = pageToSlotBuckets * 8;
  const dirtyMaskBytes = (Math.ceil(slotCount / 8) + 7) & ~7;

  const slotToPageOffset = slotsEndOffset;
  const pageToSlotOffset = slotToPageOffset + slotToPageBytes;
  const dirtyMaskOffset = pageToSlotOffset + pageToSlotBytes;
  const rawArenaStart = dirtyMaskOffset + dirtyMaskBytes;
  const transientArenaOffset = (rawArenaStart + 65535) & ~65535;

  return {
    slotsBaseOffset,
    slotsEndOffset,
    slotToPageOffset,
    pageToSlotOffset,
    pageToSlotBuckets,
    dirtyMaskOffset,
    vmContextOffset: VM_CONTEXT_OFFSET,
    resultBufferOffset: RESULT_BUFFER_OFFSET,
    bytecodeOffset: BYTECODE_OFFSET,
    pageScratchpadOffset: PAGE_SCRATCHPAD_OFFSET,
    transientArenaOffset,
  };
}
