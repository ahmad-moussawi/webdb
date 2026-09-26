import { PAGE_TO_SLOT_BUCKET_SIZE } from "../../constants.js";

/**
 * Knuth's 32-bit multiplicative hash constant: floor(2^32 / phi).
 */
const KNUTH_GOLDEN_RATIO_32 = 0x9e3779b9;

/**
 * @export_c
 * Computes a 32-bit multiplicative integer hash for a page ID.
 *
 * @param page_id Positive 1-based page identifier
 * @param mask Bitmask for power-of-two bucket count (bucketCount - 1)
 * @returns Bucket index in range [0, mask]
 */
export function page_table_hash(page_id: number, mask: number): number {
  const h = Math.imul(page_id, KNUTH_GOLDEN_RATIO_32);
  return ((h ^ (h >>> 16)) >>> 0) & mask;
}

/**
 * @export_c
 * Probes the binary open-addressing hash table in shared memory for a page ID.
 *
 * Bucket Layout (8 bytes):
 * - [0..3] uint32_t page_id (0 = empty)
 * - [4..7] uint32_t slot_idx
 *
 * @param view Shared memory DataView
 * @param base_offset Byte offset where the hash table begins
 * @param bucket_count Total number of buckets (must be power of two)
 * @param page_id Positive 1-based page identifier
 * @returns Slot index if resident, or -1 if not found
 */
export function page_table_get(
  view: DataView,
  base_offset: number,
  bucket_count: number,
  page_id: number,
): number {
  const mask = bucket_count - 1;
  let idx = page_table_hash(page_id, mask);

  for (let probe = 0; probe < bucket_count; probe++) {
    const offset = base_offset + idx * PAGE_TO_SLOT_BUCKET_SIZE;
    const entryPageId = view.getUint32(offset, true);
    if (entryPageId === 0) {
      return -1;
    }
    if (entryPageId === page_id) {
      return view.getUint32(offset + 4, true);
    }
    idx = (idx + 1) & mask;
  }
  return -1;
}

/**
 * @export_c
 * Inserts or updates a page_id -> slot_idx mapping in the binary hash table.
 *
 * @param view Shared memory DataView
 * @param base_offset Byte offset where the hash table begins
 * @param bucket_count Total number of buckets (must be power of two)
 * @param page_id Positive 1-based page identifier
 * @param slot_idx Buffer pool cache slot index
 */
export function page_table_set(
  view: DataView,
  base_offset: number,
  bucket_count: number,
  page_id: number,
  slot_idx: number,
): void {
  const mask = bucket_count - 1;
  let idx = page_table_hash(page_id, mask);

  for (let probe = 0; probe < bucket_count; probe++) {
    const offset = base_offset + idx * PAGE_TO_SLOT_BUCKET_SIZE;
    const entryPageId = view.getUint32(offset, true);
    if (entryPageId === 0 || entryPageId === page_id) {
      view.setUint32(offset, page_id, true);
      view.setUint32(offset + 4, slot_idx, true);
      return;
    }
    idx = (idx + 1) & mask;
  }
  throw new Error(`BufferPool page table full: cannot insert page ${page_id}`);
}

/**
 * @export_c
 * Removes a page_id mapping using backward shift deletion (Robin Hood style).
 * This eliminates tombstones and guarantees linear probing chain continuity.
 *
 * @param view Shared memory DataView
 * @param base_offset Byte offset where the hash table begins
 * @param bucket_count Total number of buckets (must be power of two)
 * @param page_id Positive 1-based page identifier
 * @returns True if the page was found and removed, false otherwise
 */
export function page_table_delete(
  view: DataView,
  base_offset: number,
  bucket_count: number,
  page_id: number,
): boolean {
  const mask = bucket_count - 1;
  let i = page_table_hash(page_id, mask);

  // 1. Locate the entry
  let found = false;
  for (let probe = 0; probe < bucket_count; probe++) {
    const offset = base_offset + i * PAGE_TO_SLOT_BUCKET_SIZE;
    const entryPageId = view.getUint32(offset, true);
    if (entryPageId === 0) {
      return false; // Key not found
    }
    if (entryPageId === page_id) {
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
    const jOffset = base_offset + j * PAGE_TO_SLOT_BUCKET_SIZE;
    const jPageId = view.getUint32(jOffset, true);
    if (jPageId === 0) {
      break;
    }
    const k = page_table_hash(jPageId, mask);
    // Entry at j can be moved back to i if i lies between its natural hash k and current slot j (cyclically)
    if (((i - k) & mask) < ((j - k) & mask)) {
      const jSlotIdx = view.getUint32(jOffset + 4, true);
      const iOffset = base_offset + i * PAGE_TO_SLOT_BUCKET_SIZE;
      view.setUint32(iOffset, jPageId, true);
      view.setUint32(iOffset + 4, jSlotIdx, true);
      i = j;
    }
  }

  // Clear the final vacated slot
  const clearOffset = base_offset + i * PAGE_TO_SLOT_BUCKET_SIZE;
  view.setUint32(clearOffset, 0, true);
  view.setUint32(clearOffset + 4, 0, true);
  return true;
}
