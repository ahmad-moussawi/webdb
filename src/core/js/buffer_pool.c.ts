import {
  PAGE_SIZE,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
  PAGE_TO_SLOT_BUCKET_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_CATALOG_PAGE,
  computeBufferPoolOffsets,
} from "../../constants.js";
import { page_get_type } from "./page.c.js";
import {
  page_table_get,
  page_table_set,
  page_table_delete,
} from "./page_table.c.js";
import {
  QueryArenaExhaustedError,
} from "../../types/index.js";
import {
  memcpy,
  memset,
  read_u8,
  write_u8,
  read_u16,
  write_u16,
  read_u32,
  write_u32,
  read_i32,
  write_i32,
  read_f64,
  write_f64,
  get_bit,
  set_bit,
  clear_bit,
  c_assert,
} from "../../shared/c_runtime.js";

// ============================================================================
// C-Style Functional Primitives (Drop-In C Port Reference Implementation)
// ============================================================================

/**
 * @export_c
 * Returns the byte offset for a given slot in linear memory.
 */
export function buf_pool_get_slot_offset(slot_idx: number): number {
  return slot_idx * PAGE_SIZE;
}

/**
 * @export_c
 * Reads the page ID currently assigned to slot_idx from the slot_to_page map.
 */
export function buf_pool_read_slot_to_page(
  view: DataView,
  slot_to_page_offset: number,
  slot_idx: number,
): number {
  return read_u32(view, slot_to_page_offset + slot_idx * 4);
}

/**
 * @export_c
 * Writes the page ID assigned to slot_idx in the slot_to_page map.
 */
export function buf_pool_write_slot_to_page(
  view: DataView,
  slot_to_page_offset: number,
  slot_idx: number,
  page_id: number,
): void {
  write_u32(view, slot_to_page_offset + slot_idx * 4, page_id);
}

/**
 * @export_c
 * Looks up the resident slot for page_id in the open-addressing hash table.
 * Returns slot index or -1 if not resident.
 */
export function buf_pool_get_resident_slot(
  view: DataView,
  page_to_slot_offset: number,
  page_to_slot_buckets: number,
  page_id: number,
): number {
  return page_table_get(
    view,
    page_to_slot_offset,
    page_to_slot_buckets,
    page_id,
  );
}

/**
 * @export_c
 * Assigns slot_idx to page_id, updating slot_to_page and page_to_slot hash tables.
 */
export function buf_pool_assign_slot(
  view: DataView,
  slot_to_page_offset: number,
  page_to_slot_offset: number,
  page_to_slot_buckets: number,
  slot_idx: number,
  page_id: number,
): void {
  c_assert(page_id > 0, "page_id must be > 0");
  const old_page = buf_pool_read_slot_to_page(
    view,
    slot_to_page_offset,
    slot_idx,
  );
  if (old_page > 0 && old_page !== page_id) {
    page_table_delete(
      view,
      page_to_slot_offset,
      page_to_slot_buckets,
      old_page,
    );
  }
  buf_pool_write_slot_to_page(view, slot_to_page_offset, slot_idx, page_id);
  page_table_set(
    view,
    page_to_slot_offset,
    page_to_slot_buckets,
    page_id,
    slot_idx,
  );
}

/**
 * @export_c
 * Unassigns slot_idx, clearing its page table entry and setting assigned page to 0.
 */
export function buf_pool_unassign_slot(
  view: DataView,
  slot_to_page_offset: number,
  page_to_slot_offset: number,
  page_to_slot_buckets: number,
  slot_idx: number,
): void {
  const old_page = buf_pool_read_slot_to_page(
    view,
    slot_to_page_offset,
    slot_idx,
  );
  if (old_page > 0) {
    page_table_delete(
      view,
      page_to_slot_offset,
      page_to_slot_buckets,
      old_page,
    );
  }
  buf_pool_write_slot_to_page(view, slot_to_page_offset, slot_idx, 0);
}

/**
 * @export_c
 * Marks slot_idx as dirty in the dirty bitmask.
 */
export function buf_pool_mark_dirty(
  dirty_mask: Uint8Array,
  dirty_mask_offset: number,
  slot_idx: number,
): void {
  set_bit(dirty_mask, (dirty_mask_offset << 3) + slot_idx);
}

/**
 * @export_c
 * Clears the dirty bit for slot_idx in the dirty bitmask.
 */
export function buf_pool_clear_dirty(
  dirty_mask: Uint8Array,
  dirty_mask_offset: number,
  slot_idx: number,
): void {
  clear_bit(dirty_mask, (dirty_mask_offset << 3) + slot_idx);
}

/**
 * @export_c
 * Checks if slot_idx is marked dirty in the dirty bitmask.
 */
export function buf_pool_is_dirty(
  dirty_mask: Uint8Array,
  dirty_mask_offset: number,
  slot_idx: number,
): boolean {
  return get_bit(dirty_mask, (dirty_mask_offset << 3) + slot_idx) === 1;
}

/**
 * @export_c
 * Increments pin count for slot_idx. Throws on uint32 overflow.
 */
export function buf_pool_pin_slot(
  pin_counts: Uint32Array,
  slot_idx: number,
): void {
  if (pin_counts[slot_idx] >= 0xffffffff) {
    throw new Error(`Pin count overflow on slot ${slot_idx}`);
  }
  pin_counts[slot_idx]++;
}

/**
 * @export_c
 * Decrements pin count for slot_idx. Slot 0 is permanently pinned.
 */
export function buf_pool_unpin_slot(
  pin_counts: Uint32Array,
  slot_idx: number,
): void {
  if (slot_idx === 0) return; // Slot 0 is permanently pinned
  if (pin_counts[slot_idx] > 0) {
    pin_counts[slot_idx]--;
  }
}

/**
 * @export_c
 * Returns true if slot_idx is pinned (pin_count > 0 or slot 0).
 */
export function buf_pool_is_pinned(
  pin_counts: Uint32Array,
  slot_idx: number,
): boolean {
  return slot_idx === 0 || pin_counts[slot_idx] > 0;
}

/**
 * @export_c
 * Finds an eviction candidate slot using Clock sweep with second-chance bit check.
 */
export function buf_pool_find_victim(
  buffer: ArrayBuffer,
  ref_bits: Uint8Array,
  pin_counts: Uint32Array,
  slot_to_page_offset: number,
  slot_count: number,
  current_clock_hand: number,
): { candidate_slot: number; next_clock_hand: number } {
  const view = new DataView(buffer);

  // 1. Scan for unallocated, unpinned slots (page_id == 0)
  for (let i = 1; i < slot_count; i++) {
    if (
      read_u32(view, slot_to_page_offset + i * 4) === 0 &&
      !buf_pool_is_pinned(pin_counts, i)
    ) {
      return { candidate_slot: i, next_clock_hand: current_clock_hand };
    }
  }

  // 2. Clock (Second-Chance) eviction loop
  let hand = current_clock_hand;
  for (let step = 0; step < slot_count * 2; step++) {
    hand = (hand + 1) % slot_count;
    if (hand === 0) continue; // Skip Page 1

    if (buf_pool_is_pinned(pin_counts, hand)) {
      continue;
    }

    // Defense-in-depth: Never evict system/catalog pages (0x0C)
    const slot_view = new DataView(buffer, hand * PAGE_SIZE, PAGE_SIZE);
    if (page_get_type(slot_view, 0) === PAGE_TYPE_CATALOG_PAGE) {
      continue;
    }

    if (ref_bits[hand] === 1) {
      ref_bits[hand] = 0;
    } else {
      return { candidate_slot: hand, next_clock_hand: hand };
    }
  }

  throw new Error("Cache deadlock: all slots are pinned");
}

/**
 * @export_c
 * Selects an eviction candidate slot for a requested page using the Core Clock sweep.
 * Examines candidate slot to determine if it holds a dirty page that must be flushed.
 */
export function buf_pool_select_eviction_victim(
  buffer: ArrayBuffer,
  ref_bits: Uint8Array,
  pin_counts: Uint32Array,
  slot_to_page_offset: number,
  dirty_mask_offset: number,
  slot_count: number,
  current_clock_hand: number,
  page_id: number,
): { candidate_slot: number; flush_page_id: number; next_clock_hand: number } {
  const view = new DataView(buffer);

  let candidate_slot = -1;
  let next_clock_hand = current_clock_hand;

  if (
    page_id > 1 &&
    page_id <= slot_count &&
    buf_pool_read_slot_to_page(view, slot_to_page_offset, page_id - 1) === 0 &&
    !buf_pool_is_pinned(pin_counts, page_id - 1)
  ) {
    candidate_slot = page_id - 1;
  } else {
    const victim = buf_pool_find_victim(
      buffer,
      ref_bits,
      pin_counts,
      slot_to_page_offset,
      slot_count,
      current_clock_hand,
    );
    candidate_slot = victim.candidate_slot;
    next_clock_hand = victim.next_clock_hand;
  }

  const old_page_id = buf_pool_read_slot_to_page(
    view,
    slot_to_page_offset,
    candidate_slot,
  );
  const is_dirty = buf_pool_is_dirty(
    new Uint8Array(buffer),
    dirty_mask_offset,
    candidate_slot,
  );
  const slot_view = new DataView(
    buffer,
    candidate_slot * PAGE_SIZE,
    PAGE_SIZE,
  );
  const is_free_page =
    old_page_id > 0 && page_get_type(slot_view, 0) === PAGE_TYPE_FREE;
  const flush_page_id =
    is_dirty && !is_free_page && old_page_id > 0 ? old_page_id : 0;

  return { candidate_slot, flush_page_id, next_clock_hand };
}

// ============================================================================
// Buffer Pool Class Definition (Synchronous Core Memory Manager)
// ============================================================================

export interface BufferPoolOptions {
  slotCount?: number;
  maxQueryMemory?: number;
  vfs?: any; // Ignored, kept for backwards compatibility if passed
}

export class BufferPool {
  readonly slot_count: number;
  readonly max_query_memory: number;

  readonly wasm_memory: WebAssembly.Memory;
  buffer: ArrayBuffer;
  view: DataView;
  uint8: Uint8Array;

  // Offsets
  readonly slots_end_offset: number;
  readonly slot_to_page_offset: number;
  readonly page_to_slot_offset: number;
  readonly page_to_slot_buckets: number;
  readonly dirty_mask_offset: number;
  readonly vm_context_offset: number;
  readonly result_buffer_offset: number;
  readonly bytecode_offset: number;
  readonly page_scratchpad_offset: number;
  readonly transient_arena_offset: number;

  // State arrays (pre-allocated)
  readonly pin_counts: Uint32Array;
  readonly slot_dirty_generations: Uint32Array;
  readonly ref_bits: Uint8Array;
  private clock_hand: number = 0;
  private arena_offset: number = 0;

  // CamelCase property aliases for host callers
  get slotCount(): number {
    return this.slot_count;
  }
  get maxQueryMemory(): number {
    return this.max_query_memory;
  }
  get wasmMemory(): WebAssembly.Memory {
    return this.wasm_memory;
  }
  get slotsEndOffset(): number {
    return this.slots_end_offset;
  }
  get slotToPageOffset(): number {
    return this.slot_to_page_offset;
  }
  get pageToSlotOffset(): number {
    return this.page_to_slot_offset;
  }
  get pageToSlotBuckets(): number {
    return this.page_to_slot_buckets;
  }
  get dirtyMaskOffset(): number {
    return this.dirty_mask_offset;
  }
  get vmContextOffset(): number {
    return this.vm_context_offset;
  }
  get resultBufferOffset(): number {
    return this.result_buffer_offset;
  }
  get bytecodeOffset(): number {
    return this.bytecode_offset;
  }
  get pageScratchpadOffset(): number {
    return this.page_scratchpad_offset;
  }
  get transientArenaOffset(): number {
    return this.transient_arena_offset;
  }
  get pinCounts(): Uint32Array {
    return this.pin_counts;
  }
  get refBits(): Uint8Array {
    return this.ref_bits;
  }
  get clockHand(): number {
    return this.clock_hand;
  }

  constructor(options?: BufferPoolOptions) {
    this.slot_count = options?.slotCount ?? DEFAULT_SLOT_COUNT;

    if (!Number.isInteger(this.slot_count) || this.slot_count < 2) {
      throw new Error(
        `Invalid slotCount: ${this.slot_count}. Must be an integer >= 2`,
      );
    }

    this.max_query_memory =
      options?.maxQueryMemory ?? DEFAULT_MAX_QUERY_MEMORY;

    if (
      !Number.isInteger(this.max_query_memory) ||
      this.max_query_memory <= 0
    ) {
      throw new Error(
        `Invalid maxQueryMemory: ${this.max_query_memory}. Must be a positive integer`,
      );
    }

    this.ref_bits = new Uint8Array(this.slot_count);
    this.pin_counts = new Uint32Array(this.slot_count);
    this.slot_dirty_generations = new Uint32Array(this.slot_count);

    const offsets = computeBufferPoolOffsets(
      this.slot_count,
      this.max_query_memory,
    );

    this.slots_end_offset = offsets.slotsEndOffset;
    this.slot_to_page_offset = offsets.slotToPageOffset;
    this.page_to_slot_offset = offsets.pageToSlotOffset;
    this.page_to_slot_buckets = offsets.pageToSlotBuckets;
    this.dirty_mask_offset = offsets.dirtyMaskOffset;
    this.vm_context_offset = offsets.vmContextOffset;
    this.result_buffer_offset = offsets.resultBufferOffset;
    this.bytecode_offset = offsets.bytecodeOffset;
    this.page_scratchpad_offset = offsets.pageScratchpadOffset;
    this.transient_arena_offset = offsets.transientArenaOffset;

    // Allocate WebAssembly.Memory (64KB per page)
    const initial_bytes = this.transient_arena_offset + 256 * 1024;
    const initial_wasm_pages = Math.ceil(initial_bytes / 65536);
    const max_wasm_pages = Math.ceil(
      (this.transient_arena_offset + this.max_query_memory) / 65536,
    );

    this.wasm_memory = new WebAssembly.Memory({
      initial: initial_wasm_pages,
      maximum: Math.max(initial_wasm_pages, max_wasm_pages),
    });

    this.buffer = this.wasm_memory.buffer;
    this.view = new DataView(this.buffer);
    this.uint8 = new Uint8Array(this.buffer);

    // Initialize slot-to-page map, page-to-slot hash table, and dirty mask to zeros
    memset(this.uint8, this.slot_to_page_offset, 0, this.slot_count * 4);
    memset(
      this.uint8,
      this.page_to_slot_offset,
      0,
      this.page_to_slot_buckets * PAGE_TO_SLOT_BUCKET_SIZE,
    );
    memset(
      this.uint8,
      this.dirty_mask_offset,
      0,
      Math.ceil(this.slot_count / 8),
    );

    // Page 1 is permanently assigned to slot 0 and pinned
    this.assign_slot(0, 1);
    this.pin_counts[0] = 1;
  }

  // ==========================================================================
  // Direct C-Style Memory Access Primitives (Little-Endian)
  // ==========================================================================

  read_u8(address: number): number {
    return read_u8(this.uint8, address);
  }

  write_u8(address: number, val: number): void {
    write_u8(this.uint8, address, val);
  }

  read_u16(address: number): number {
    return read_u16(this.view, address);
  }

  write_u16(address: number, val: number): void {
    write_u16(this.view, address, val);
  }

  read_u32(address: number): number {
    return read_u32(this.view, address);
  }

  write_u32(address: number, val: number): void {
    write_u32(this.view, address, val);
  }

  read_i32(address: number): number {
    return read_i32(this.view, address);
  }

  write_i32(address: number, val: number): void {
    write_i32(this.view, address, val);
  }

  read_f64(address: number): number {
    return read_f64(this.view, address);
  }

  write_f64(address: number, val: number): void {
    write_f64(this.view, address, val);
  }

  get_bytes(address: number, length: number): Uint8Array {
    return this.uint8.subarray(address, address + length);
  }

  set_bytes(address: number, source: Uint8Array): void {
    memcpy(this.uint8, address, source, 0, source.byteLength);
  }

  fill_bytes(address: number, length: number, val: number = 0): void {
    memset(this.uint8, address, val, length);
  }

  // CamelCase wrappers
  readUint8(address: number): number {
    return this.read_u8(address);
  }
  writeUint8(address: number, value: number): void {
    this.write_u8(address, value);
  }
  readUint16(address: number): number {
    return this.read_u16(address);
  }
  writeUint16(address: number, value: number): void {
    this.write_u16(address, value);
  }
  readUint32(address: number): number {
    return this.read_u32(address);
  }
  writeUint32(address: number, value: number): void {
    this.write_u32(address, value);
  }
  readInt32(address: number): number {
    return this.read_i32(address);
  }
  writeInt32(address: number, value: number): void {
    this.write_i32(address, value);
  }
  readFloat64(address: number): number {
    return this.read_f64(address);
  }
  writeFloat64(address: number, value: number): void {
    this.write_f64(address, value);
  }
  getBytes(address: number, length: number): Uint8Array {
    return this.get_bytes(address, length);
  }
  setBytes(address: number, source: Uint8Array): void {
    this.set_bytes(address, source);
  }
  fillBytes(address: number, length: number, value: number = 0): void {
    this.fill_bytes(address, length, value);
  }

  // ==========================================================================
  // Validation Helpers
  // ==========================================================================

  private validate_slot_idx(slot_idx: number): void {
    if (
      !Number.isInteger(slot_idx) ||
      slot_idx < 0 ||
      slot_idx >= this.slot_count
    ) {
      throw new Error(
        `Invalid slot index: ${slot_idx}. Must be an integer between 0 and ${this.slot_count - 1}`,
      );
    }
  }

  private validate_page_id(page_id: number): void {
    if (!Number.isInteger(page_id) || page_id <= 0) {
      throw new Error(
        `Invalid page ID: ${page_id}. Page IDs must be positive integers.`,
      );
    }
  }

  // ==========================================================================
  // Slot Mapping & Dirty Bitmask
  // ==========================================================================

  get_assigned_page(slot_idx: number): number {
    this.validate_slot_idx(slot_idx);
    return buf_pool_read_slot_to_page(
      this.view,
      this.slot_to_page_offset,
      slot_idx,
    );
  }

  assign_slot(slot_idx: number, page_id: number): void {
    this.validate_slot_idx(slot_idx);

    if (!Number.isInteger(page_id) || page_id <= 0) {
      throw new Error(
        `Invalid page ID: ${page_id}. Must be a positive integer >= 1`,
      );
    }

    if (slot_idx === 0 && page_id !== 1) {
      throw new Error(
        `Cannot reassign slot 0: reserved permanently for page 1 (got page ${page_id})`,
      );
    }

    const existing_slot = this.get_resident_slot(page_id);
    if (existing_slot !== -1 && existing_slot !== slot_idx) {
      throw new Error(
        `Cannot map page ${page_id} to slot ${slot_idx}: already resident in slot ${existing_slot}`,
      );
    }

    buf_pool_assign_slot(
      this.view,
      this.slot_to_page_offset,
      this.page_to_slot_offset,
      this.page_to_slot_buckets,
      slot_idx,
      page_id,
    );
  }

  unassign_slot(slot_idx: number): void {
    this.validate_slot_idx(slot_idx);

    if (slot_idx === 0) {
      throw new Error(
        `Cannot unassign slot 0: reserved permanently for page 1`,
      );
    }

    buf_pool_unassign_slot(
      this.view,
      this.slot_to_page_offset,
      this.page_to_slot_offset,
      this.page_to_slot_buckets,
      slot_idx,
    );
  }

  mark_dirty(slot_idx: number): void {
    this.validate_slot_idx(slot_idx);
    buf_pool_mark_dirty(this.uint8, this.dirty_mask_offset, slot_idx);
    this.slot_dirty_generations[slot_idx]++;
  }

  clear_dirty(slot_idx: number): void {
    this.validate_slot_idx(slot_idx);
    buf_pool_clear_dirty(this.uint8, this.dirty_mask_offset, slot_idx);
  }

  is_dirty(slot_idx: number): boolean {
    this.validate_slot_idx(slot_idx);
    return buf_pool_is_dirty(this.uint8, this.dirty_mask_offset, slot_idx);
  }

  // CamelCase wrappers
  getAssignedPage(slotIdx: number): number {
    return this.get_assigned_page(slotIdx);
  }
  assignSlot(slotIdx: number, pageId: number): void {
    this.assign_slot(slotIdx, pageId);
  }
  unassignSlot(slotIdx: number): void {
    this.unassign_slot(slotIdx);
  }
  markDirty(slotIdx: number): void {
    this.mark_dirty(slotIdx);
  }
  clearDirty(slotIdx: number): void {
    this.clear_dirty(slotIdx);
  }
  isDirty(slotIdx: number): boolean {
    return this.is_dirty(slotIdx);
  }

  // ==========================================================================
  // Pinning Invariant (Reference Counted)
  // ==========================================================================

  pin_slot(slot_idx: number): void {
    this.validate_slot_idx(slot_idx);
    buf_pool_pin_slot(this.pin_counts, slot_idx);
  }

  unpin_slot(slot_idx: number): void {
    this.validate_slot_idx(slot_idx);
    buf_pool_unpin_slot(this.pin_counts, slot_idx);
  }

  pin_page(page_id: number): void {
    this.validate_page_id(page_id);
    const slot = this.get_resident_slot(page_id);
    if (slot === -1) {
      throw new Error(
        `Cannot pin page ${page_id}: page is not resident in buffer pool`,
      );
    }
    this.pin_slot(slot);
  }

  unpin_page(page_id: number): void {
    this.validate_page_id(page_id);
    if (page_id === 1) return;
    const slot = this.get_resident_slot(page_id);
    if (slot !== -1) {
      this.unpin_slot(slot);
    }
  }

  is_pinned(slot_idx: number): boolean {
    this.validate_slot_idx(slot_idx);
    return buf_pool_is_pinned(this.pin_counts, slot_idx);
  }

  get_pin_count(slot_idx: number): number {
    this.validate_slot_idx(slot_idx);
    return this.pin_counts[slot_idx];
  }

  get_ref_bit(slot_idx: number): number {
    this.validate_slot_idx(slot_idx);
    return this.ref_bits[slot_idx];
  }

  set_ref_bit(slot_idx: number, val: number): void {
    this.validate_slot_idx(slot_idx);
    this.ref_bits[slot_idx] = val ? 1 : 0;
  }

  // CamelCase wrappers
  pinSlot(slotIdx: number): void {
    this.pin_slot(slotIdx);
  }
  unpinSlot(slotIdx: number): void {
    this.unpin_slot(slotIdx);
  }
  pinPage(pageId: number): void {
    this.pin_page(pageId);
  }
  unpinPage(pageId: number): void {
    this.unpin_page(pageId);
  }
  isSlotPinned(slotIdx: number): boolean {
    return this.is_pinned(slotIdx);
  }
  getPinCount(slotIdx: number): number {
    return this.get_pin_count(slotIdx);
  }
  getRefBit(slotIdx: number): number {
    return this.get_ref_bit(slotIdx);
  }
  setRefBit(slotIdx: number, val: number): void {
    this.set_ref_bit(slotIdx, val);
  }

  // ==========================================================================
  // Page Access & Resident Lookups
  // ==========================================================================

  get_slot_offset(slot_idx: number): number {
    this.validate_slot_idx(slot_idx);
    return buf_pool_get_slot_offset(slot_idx);
  }

  get_page_bytes_in_slot(slot_idx: number): Uint8Array {
    this.validate_slot_idx(slot_idx);
    return this.get_bytes(slot_idx * PAGE_SIZE, PAGE_SIZE);
  }

  get_slot_data_view(slot_idx: number): DataView {
    this.validate_slot_idx(slot_idx);
    return new DataView(this.buffer, slot_idx * PAGE_SIZE, PAGE_SIZE);
  }

  get_resident_slot(page_id: number): number {
    this.validate_page_id(page_id);
    return buf_pool_get_resident_slot(
      this.view,
      this.page_to_slot_offset,
      this.page_to_slot_buckets,
      page_id,
    );
  }

  // CamelCase wrappers
  getSlotOffset(slotIdx: number): number {
    return this.get_slot_offset(slotIdx);
  }
  getPageBytesInSlot(slotIdx: number): Uint8Array {
    return this.get_page_bytes_in_slot(slotIdx);
  }
  getSlotDataView(slotIdx: number): DataView {
    return this.get_slot_data_view(slotIdx);
  }
  getResidentSlot(pageId: number): number {
    return this.get_resident_slot(pageId);
  }

  find_eviction_candidate_slot(): number {
    const res = buf_pool_find_victim(
      this.buffer,
      this.ref_bits,
      this.pin_counts,
      this.slot_to_page_offset,
      this.slot_count,
      this.clock_hand,
    );
    this.clock_hand = res.next_clock_hand;
    return res.candidate_slot;
  }

  findEvictionCandidateSlot(): number {
    return this.find_eviction_candidate_slot();
  }

  // ==========================================================================
  // Transient Query Arena
  // ==========================================================================

  get_arena_offset(): number {
    return this.arena_offset;
  }

  getArenaOffset(): number {
    return this.get_arena_offset();
  }

  alloc_arena(size: number): number {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(
        `Invalid arena allocation size: ${size}. Size must be a positive integer.`,
      );
    }

    const aligned_size = (size + 7) & ~7;
    if (this.arena_offset + aligned_size > this.max_query_memory) {
      throw new QueryArenaExhaustedError();
    }

    const required_bytes =
      this.transient_arena_offset + this.arena_offset + aligned_size;
    if (required_bytes > this.buffer.byteLength) {
      const needed_bytes = required_bytes - this.buffer.byteLength;
      const pages_to_grow = Math.ceil(needed_bytes / 65536);
      this.wasm_memory.grow(pages_to_grow);
      this.buffer = this.wasm_memory.buffer;
      this.view = new DataView(this.buffer);
      this.uint8 = new Uint8Array(this.buffer);
    }

    const current = this.transient_arena_offset + this.arena_offset;
    this.arena_offset += aligned_size;
    return current;
  }

  allocateInArena(size: number): number {
    return this.alloc_arena(size);
  }

  allocArena(size: number): number {
    return this.alloc_arena(size);
  }

  reset_arena(): void {
    if (this.arena_offset > 0) {
      this.fill_bytes(this.transient_arena_offset, this.arena_offset, 0);
      this.arena_offset = 0;
    }
  }

  resetArena(): void {
    this.reset_arena();
  }
}
