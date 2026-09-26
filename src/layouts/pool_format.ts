/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/pool_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

import { PAGE_SIZE } from "./page_format.js";

// ============================================================================
// Buffer Pool & Shared Memory Architecture Layout
// ============================================================================

/**
 * Default cache buffer pool size in bytes (4 MB = 1024 * 4096).
 */
export const DEFAULT_CACHE_SIZE_BYTES = 4194304;

/**
 * Default number of page cache slots in the buffer pool (1024).
 */
export const DEFAULT_SLOT_COUNT = 1024;

/**
 * Alias for DEFAULT_SLOT_COUNT (1024).
 */
export const DEFAULT_PAGE_SLOTS = 1024;

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
 * Padding bytes to align transient execution arena at boundary 0x420000 (12,160 bytes).
 */
export const ALIGNMENT_PADDING_SIZE = 12160;

/**
 * Maximum memory limit in bytes for transient query execution arena (16 MB).
 */
export const DEFAULT_MAX_QUERY_MEMORY = 16777216;

/**
 * Shared Memory Architecture Map (1024 Slots / 4MB Cache Default):
 * +----------------------+--------+-------------------+------------------------------------------------+
 * | Memory Address Range | Size   | Region Name       | Description                                    |
 * +----------------------+--------+-------------------+------------------------------------------------+
 * | 0x400000..0x400FFF   | 4096B  | SLOT_TO_PAGE      | Array of 1024 uint32 pageIds mapping slot -... |
 * | 0x401000..0x40107F   | 128B   | DIRTY_MASK        | Bitmask (128 bytes = 1024 bits) tracking di... |
 * | 0x401080..0x40407F   | 12288B | VM_CONTEXT        | Execution context frames for the SQL VM.       |
 * | 0x404080..0x41407F   | 65536B | RESULT_BUFFER     | Output buffer for query result rows.           |
 * | 0x414080..0x41C07F   | 32768B | BYTECODE          | Instruction buffer for compiled bytecode ro... |
 * | 0x41C080..0x41D07F   | 4096B  | PAGE_SCRATCHPAD   | Staging buffer for page compression or I/O ... |
 * | 0x41D080..0x41FFFF   | 12160B | ALIGNMENT_PADDING | Padding aligning transient arena to 0x420000.  |
 * +----------------------+--------+-------------------+------------------------------------------------+
 * | Arena Start: 0x420000 | Total Regions: 131072 Bytes                                                |
 * +----------------------------------------------------------------------------------------------------+
 */
export const DEFAULT_BUFFER_POOL_REGIONS = [
  ["SLOT_TO_PAGE", 4096],
  ["DIRTY_MASK", 128],
  ["VM_CONTEXT", 12288],
  ["RESULT_BUFFER", 65536],
  ["BYTECODE", 32768],
  ["PAGE_SCRATCHPAD", 4096],
  ["ALIGNMENT_PADDING", 12160],
] as const;

/**
 * Byte offset 0x400000: Array of 1024 uint32 pageIds mapping slot -> pageId.
 */
export const SLOT_TO_PAGE_OFFSET = 4194304; // 0x400000

/**
 * Byte offset 0x401000: Bitmask (128 bytes = 1024 bits) tracking dirty slots.
 */
export const DIRTY_MASK_OFFSET = 4198400; // 0x401000

/**
 * Byte offset 0x401080: Execution context frames for the SQL VM.
 */
export const VM_CONTEXT_OFFSET = 4198528; // 0x401080

/**
 * Byte offset 0x404080: Output buffer for query result rows.
 */
export const RESULT_BUFFER_OFFSET = 4210816; // 0x404080

/**
 * Byte offset 0x414080: Instruction buffer for compiled bytecode routines.
 */
export const BYTECODE_OFFSET = 4276352; // 0x414080

/**
 * Byte offset 0x41C080: Staging buffer for page compression or I/O reassembly.
 */
export const PAGE_SCRATCHPAD_OFFSET = 4309120; // 0x41C080

/**
 * Byte offset 0x41D080: Padding aligning transient arena to 0x420000.
 */
export const ALIGNMENT_PADDING_OFFSET = 4313216; // 0x41D080

/**
 * Byte offset 0x420000: Start of dynamic transient query execution arena.
 */
export const TRANSIENT_ARENA_OFFSET = 4325376; // 0x420000

/**
 * Total buffer pool and shared Wasm memory allocation in bytes (20.125 MB).
 */
export const TOTAL_MEMORY_BYTES = 21102592;

/**
 * Computes memory layout offsets for arbitrary slot counts.
 */
export function computeBufferPoolOffsets(
  slotCount: number,
  _maxQueryMemory: number = DEFAULT_MAX_QUERY_MEMORY,
) {
  const slotsEndOffset = slotCount * PAGE_SIZE;
  const slotToPageBytes = (slotCount * 4 + 7) & ~7;
  const dirtyMaskBytes = (Math.ceil(slotCount / 8) + 7) & ~7;

  if (slotCount === DEFAULT_SLOT_COUNT) {
    return {
      slotsEndOffset,
      slotToPageOffset: SLOT_TO_PAGE_OFFSET,
      dirtyMaskOffset: DIRTY_MASK_OFFSET,
      vmContextOffset: VM_CONTEXT_OFFSET,
      resultBufferOffset: RESULT_BUFFER_OFFSET,
      bytecodeOffset: BYTECODE_OFFSET,
      pageScratchpadOffset: PAGE_SCRATCHPAD_OFFSET,
      transientArenaOffset: TRANSIENT_ARENA_OFFSET,
    };
  }

  const slotToPageOffset = slotsEndOffset;
  const dirtyMaskOffset = slotToPageOffset + slotToPageBytes;
  const vmContextOffset = dirtyMaskOffset + dirtyMaskBytes;
  const resultBufferOffset = vmContextOffset + VM_CONTEXT_SIZE;
  const bytecodeOffset = resultBufferOffset + RESULT_BUFFER_SIZE;
  const pageScratchpadOffset = bytecodeOffset + BYTECODE_SIZE;
  const transientArenaOffset =
    pageScratchpadOffset + PAGE_SCRATCHPAD_SIZE + ALIGNMENT_PADDING_SIZE;

  return {
    slotsEndOffset,
    slotToPageOffset,
    dirtyMaskOffset,
    vmContextOffset,
    resultBufferOffset,
    bytecodeOffset,
    pageScratchpadOffset,
    transientArenaOffset,
  };
}
