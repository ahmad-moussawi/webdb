import { PAGE_TO_SLOT_BUCKET_SIZE } from "../constants.js";

/**
 * Knuth's 32-bit multiplicative hash constant: floor(2^32 / phi).
 */
const KNUTH_GOLDEN_RATIO_32 = 0x9e3779b9;

/**
 * Computes a 32-bit multiplicative integer hash for a page ID.
 *
 * @param pageId Positive 1-based page identifier
 * @param mask Bitmask for power-of-two bucket count (bucketCount - 1)
 * @returns Bucket index in range [0, mask]
 */
export function hashPageId(pageId: number, mask: number): number {
  const h = Math.imul(pageId, KNUTH_GOLDEN_RATIO_32);
  return ((h ^ (h >>> 16)) >>> 0) & mask;
}

/**
 * Probes the binary open-addressing hash table in shared memory for a page ID.
 *
 * Bucket Layout (8 bytes):
 * - [0..3] uint32_t page_id (0 = empty)
 * - [4..7] uint32_t slot_idx
 *
 * @param view Shared memory DataView
 * @param baseOffset Byte offset where the hash table begins
 * @param bucketCount Total number of buckets (must be power of two)
 * @param pageId Positive 1-based page identifier
 * @returns Slot index if resident, or -1 if not found
 */
export function pageTableGet(
  view: DataView,
  baseOffset: number,
  bucketCount: number,
  pageId: number,
): number {
  const mask = bucketCount - 1;
  let idx = hashPageId(pageId, mask);

  for (let probe = 0; probe < bucketCount; probe++) {
    const offset = baseOffset + idx * PAGE_TO_SLOT_BUCKET_SIZE;
    const entryPageId = view.getUint32(offset, true);
    if (entryPageId === 0) {
      return -1;
    }
    if (entryPageId === pageId) {
      return view.getUint32(offset + 4, true);
    }
    idx = (idx + 1) & mask;
  }
  return -1;
}

/**
 * Inserts or updates a page_id -> slot_idx mapping in the binary hash table.
 *
 * @param view Shared memory DataView
 * @param baseOffset Byte offset where the hash table begins
 * @param bucketCount Total number of buckets (must be power of two)
 * @param pageId Positive 1-based page identifier
 * @param slotIdx Buffer pool cache slot index
 */
export function pageTableSet(
  view: DataView,
  baseOffset: number,
  bucketCount: number,
  pageId: number,
  slotIdx: number,
): void {
  const mask = bucketCount - 1;
  let idx = hashPageId(pageId, mask);

  for (let probe = 0; probe < bucketCount; probe++) {
    const offset = baseOffset + idx * PAGE_TO_SLOT_BUCKET_SIZE;
    const entryPageId = view.getUint32(offset, true);
    if (entryPageId === 0 || entryPageId === pageId) {
      view.setUint32(offset, pageId, true);
      view.setUint32(offset + 4, slotIdx, true);
      return;
    }
    idx = (idx + 1) & mask;
  }
  throw new Error(`BufferPool page table full: cannot insert page ${pageId}`);
}

/**
 * Removes a page_id mapping using backward shift deletion (Robin Hood style).
 * This eliminates tombstones and guarantees linear probing chain continuity.
 *
 * @param view Shared memory DataView
 * @param baseOffset Byte offset where the hash table begins
 * @param bucketCount Total number of buckets (must be power of two)
 * @param pageId Positive 1-based page identifier
 * @returns True if the page was found and removed, false otherwise
 */
export function pageTableDelete(
  view: DataView,
  baseOffset: number,
  bucketCount: number,
  pageId: number,
): boolean {
  const mask = bucketCount - 1;
  let i = hashPageId(pageId, mask);

  // 1. Locate the entry
  let found = false;
  for (let probe = 0; probe < bucketCount; probe++) {
    const offset = baseOffset + i * PAGE_TO_SLOT_BUCKET_SIZE;
    const entryPageId = view.getUint32(offset, true);
    if (entryPageId === 0) {
      return false; // Key not found
    }
    if (entryPageId === pageId) {
      found = true;
      break;
    }
    i = (i + 1) & mask;
  }

  if (!found) {
    return false;
  }

  // 2. Backward shift deletion (Robin Hood style open addressing)
  let j = i;
  while (true) {
    j = (j + 1) & mask;
    const jOffset = baseOffset + j * PAGE_TO_SLOT_BUCKET_SIZE;
    const jPageId = view.getUint32(jOffset, true);
    if (jPageId === 0) {
      break;
    }
    const k = hashPageId(jPageId, mask);
    // Entry at j can be moved back to i if i lies between its natural hash k and current slot j (cyclically)
    if (((i - k) & mask) < ((j - k) & mask)) {
      const jSlotIdx = view.getUint32(jOffset + 4, true);
      const iOffset = baseOffset + i * PAGE_TO_SLOT_BUCKET_SIZE;
      view.setUint32(iOffset, jPageId, true);
      view.setUint32(iOffset + 4, jSlotIdx, true);
      i = j;
    }
  }

  // Clear the final vacated slot
  const clearOffset = baseOffset + i * PAGE_TO_SLOT_BUCKET_SIZE;
  view.setUint32(clearOffset, 0, true);
  view.setUint32(clearOffset + 4, 0, true);
  return true;
}
