import {
  PAGE_SIZE,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
  PAGE_TO_SLOT_BUCKET_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_CATALOG_PAGE,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
  PAGE_HEADER_OFFSET_TYPE,
  PAGE_HEADER_SIZE,
  computeBufferPoolOffsets,
} from "../../constants.js";

export type BufferPoolOffsets = ReturnType<typeof computeBufferPoolOffsets>;

import { IVfsAdapter } from "../storage/vfs.js";
import { Io } from "../storage/io.js";
import {
  read_u32,
  write_u32,
  read_u8,
  memset,
} from "../../shared/index.js";
import {
  CorruptPageError,
  QueryArenaExhaustedError,
  VmStatus,
  VmContext,
} from "../../types/index.js";
import {
  page_init,
  page_init_free,
  page_get_type,
  vm_step,
  buf_pool_read_slot_to_page,
  buf_pool_get_resident_slot,
  buf_pool_assign_slot,
  buf_pool_unassign_slot,
  buf_pool_mark_dirty,
  buf_pool_clear_dirty,
  buf_pool_is_dirty,
  buf_pool_pin_slot,
  buf_pool_unpin_slot,
  buf_pool_is_pinned,
  buf_pool_select_eviction_victim,
} from "../../core/index.js";

// ============================================================================
// Helper to create Wasm Memory
// ============================================================================

export function createWasmMemory(
  slotCount: number = DEFAULT_SLOT_COUNT,
  maxQueryMemory: number = DEFAULT_MAX_QUERY_MEMORY,
): WebAssembly.Memory {
  const offsets = computeBufferPoolOffsets(slotCount, maxQueryMemory);
  const initial_bytes = offsets.transientArenaOffset + 256 * 1024;
  const initial_wasm_pages = Math.ceil(initial_bytes / 65536);
  const max_wasm_pages = Math.ceil(
    (offsets.transientArenaOffset + maxQueryMemory) / 65536,
  );
  return new WebAssembly.Memory({
    initial: initial_wasm_pages,
    maximum: Math.max(initial_wasm_pages, max_wasm_pages),
  });
}

// ============================================================================
// Async I/O Driver Loop (Host Layer)
// ============================================================================

export interface IoDriverOptions {
  vfs?: IVfsAdapter;
  io?: Io;
  memory?: WebAssembly.Memory;
  pool?: {
    wasmMemory: WebAssembly.Memory;
    slotCount?: number;
    maxQueryMemory?: number;
  };
  slotCount?: number;
  maxQueryMemory?: number;
}

/**
 * Async I/O Driver Loop.
 *
 * Implemented 100% in TypeScript on the Host Layer.
 * Interacts with the C Engine purely through shared WebAssembly.Memory and layout offsets.
 * Does NOT import or invoke any C-layer classes.
 */
export class IoDriver {
  readonly io: Io;
  readonly wasmMemory: WebAssembly.Memory;
  readonly buffer: ArrayBuffer;
  readonly view: DataView;
  readonly uint8: Uint8Array;
  readonly slotCount: number;
  readonly maxQueryMemory: number;
  readonly offsets: BufferPoolOffsets;

  // Offsets shortcuts
  readonly slotsEndOffset: number;
  readonly slotToPageOffset: number;
  readonly pageToSlotOffset: number;
  readonly pageToSlotBuckets: number;
  readonly dirtyMaskOffset: number;
  readonly vmContextOffset: number;
  readonly resultBufferOffset: number;
  readonly bytecodeOffset: number;
  readonly pageScratchpadOffset: number;
  readonly transientArenaOffset: number;

  readonly pin_counts: Uint32Array;
  readonly slot_dirty_generations: Uint32Array;
  readonly ref_bits: Uint8Array;
  private clock_hand: number = 0;
  private arena_offset: number = 0;

  private in_flight_acquires = new Map<number, Promise<number>>();
  private allocation_lock: Promise<void> = Promise.resolve();

  get pinCounts(): Uint32Array {
    return this.pin_counts;
  }
  get refBits(): Uint8Array {
    return this.ref_bits;
  }
  get clockHand(): number {
    return this.clock_hand;
  }

  constructor(options: IoDriverOptions) {
    this.slotCount =
      options.slotCount ?? options.pool?.slotCount ?? DEFAULT_SLOT_COUNT;

    this.maxQueryMemory =
      options.maxQueryMemory ??
      options.pool?.maxQueryMemory ??
      DEFAULT_MAX_QUERY_MEMORY;

    const memory = options.memory ?? options.pool?.wasmMemory;

    if (!memory) {
      throw new Error(
        "IoDriver requires a valid WebAssembly.Memory (or pool with wasmMemory)",
      );
    }

    this.wasmMemory = memory;
    this.buffer = this.wasmMemory.buffer;
    this.view = new DataView(this.buffer);
    this.uint8 = new Uint8Array(this.buffer);

    this.offsets = computeBufferPoolOffsets(
      this.slotCount,
      this.maxQueryMemory,
    );

    this.slotsEndOffset = this.offsets.slotsEndOffset;
    this.slotToPageOffset = this.offsets.slotToPageOffset;
    this.pageToSlotOffset = this.offsets.pageToSlotOffset;
    this.pageToSlotBuckets = this.offsets.pageToSlotBuckets;
    this.dirtyMaskOffset = this.offsets.dirtyMaskOffset;
    this.vmContextOffset = this.offsets.vmContextOffset;
    this.resultBufferOffset = this.offsets.resultBufferOffset;
    this.bytecodeOffset = this.offsets.bytecodeOffset;
    this.pageScratchpadOffset = this.offsets.pageScratchpadOffset;
    this.transientArenaOffset = this.offsets.transientArenaOffset;

    this.ref_bits = new Uint8Array(this.slotCount);
    this.pin_counts = new Uint32Array(this.slotCount);
    this.slot_dirty_generations = new Uint32Array(this.slotCount);

    if (options.io) {
      this.io = options.io;
    } else if (options.vfs) {
      this.io = new Io({ vfs: options.vfs, memory: this.wasmMemory });
    } else {
      throw new Error("IoDriver requires either an Io instance or IVfsAdapter");
    }

    // Initialize slot-to-page map, page-to-slot hash table, and dirty mask to zeros
    memset(this.uint8, this.slotToPageOffset, 0, this.slotCount * 4);
    memset(
      this.uint8,
      this.pageToSlotOffset,
      0,
      this.pageToSlotBuckets * PAGE_TO_SLOT_BUCKET_SIZE,
    );
    memset(this.uint8, this.dirtyMaskOffset, 0, Math.ceil(this.slotCount / 8));

    // Slot 0 is reserved permanently for Page 1 and pinned
    this.assignSlot(0, 1);
    this.pin_counts[0] = 1;
  }

  private validate_slot_idx(slot_idx: number): void {
    if (
      !Number.isInteger(slot_idx) ||
      slot_idx < 0 ||
      slot_idx >= this.slotCount
    ) {
      throw new Error(
        `Invalid slot index: ${slot_idx}. Must be an integer between 0 and ${this.slotCount - 1}`,
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

  private async with_allocation_lock<T>(fn: () => Promise<T>): Promise<T> {
    const prev_lock = this.allocation_lock;
    let release: () => void;
    this.allocation_lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev_lock;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  // ==========================================================================
  // In-Memory Slot Mapping & Hash Table Primitives
  // ==========================================================================

  getSlotOffset(slotIdx: number): number {
    this.validate_slot_idx(slotIdx);
    return slotIdx * PAGE_SIZE;
  }

  getPageBytesInSlot(slotIdx: number): Uint8Array {
    this.validate_slot_idx(slotIdx);
    return this.uint8.subarray(slotIdx * PAGE_SIZE, (slotIdx + 1) * PAGE_SIZE);
  }

  getSlotDataView(slotIdx: number): DataView {
    this.validate_slot_idx(slotIdx);
    return new DataView(this.buffer, slotIdx * PAGE_SIZE, PAGE_SIZE);
  }

  getResidentSlot(pageId: number): number {
    this.validate_page_id(pageId);
    return buf_pool_get_resident_slot(
      this.view,
      this.pageToSlotOffset,
      this.pageToSlotBuckets,
      pageId,
    );
  }

  getAssignedPage(slotIdx: number): number {
    this.validate_slot_idx(slotIdx);
    return buf_pool_read_slot_to_page(
      this.view,
      this.slotToPageOffset,
      slotIdx,
    );
  }

  assignSlot(slotIdx: number, pageId: number): void {
    this.validate_slot_idx(slotIdx);
    if (!Number.isInteger(pageId) || pageId <= 0) {
      throw new Error(
        `Invalid page ID: ${pageId}. Must be a positive integer >= 1`,
      );
    }
    if (slotIdx === 0 && pageId !== 1) {
      throw new Error(
        `Cannot reassign slot 0: reserved permanently for page 1 (got page ${pageId})`,
      );
    }

    const existing_slot = this.getResidentSlot(pageId);
    if (existing_slot !== -1 && existing_slot !== slotIdx) {
      throw new Error(
        `Cannot map page ${pageId} to slot ${slotIdx}: already resident in slot ${existing_slot}`,
      );
    }

    buf_pool_assign_slot(
      this.view,
      this.slotToPageOffset,
      this.pageToSlotOffset,
      this.pageToSlotBuckets,
      slotIdx,
      pageId,
    );
    this.ref_bits[slotIdx] = 1;
  }

  unassignSlot(slotIdx: number): void {
    this.validate_slot_idx(slotIdx);
    if (slotIdx === 0) {
      throw new Error(
        `Cannot unassign slot 0: reserved permanently for page 1`,
      );
    }

    buf_pool_unassign_slot(
      this.view,
      this.slotToPageOffset,
      this.pageToSlotOffset,
      this.pageToSlotBuckets,
      slotIdx,
    );
    this.ref_bits[slotIdx] = 0;
  }

  markDirty(slotIdx: number): void {
    this.validate_slot_idx(slotIdx);
    buf_pool_mark_dirty(this.uint8, this.dirtyMaskOffset, slotIdx);
    this.slot_dirty_generations[slotIdx]++;
  }

  clearDirty(slotIdx: number): void {
    this.validate_slot_idx(slotIdx);
    buf_pool_clear_dirty(this.uint8, this.dirtyMaskOffset, slotIdx);
  }

  isDirty(slotIdx: number): boolean {
    this.validate_slot_idx(slotIdx);
    return buf_pool_is_dirty(this.uint8, this.dirtyMaskOffset, slotIdx);
  }

  pinSlot(slotIdx: number): void {
    this.validate_slot_idx(slotIdx);
    buf_pool_pin_slot(this.pin_counts, slotIdx);
  }

  unpinSlot(slotIdx: number): void {
    this.validate_slot_idx(slotIdx);
    buf_pool_unpin_slot(this.pin_counts, slotIdx);
  }

  pinPage(pageId: number): void {
    this.validate_page_id(pageId);
    const slot = this.getResidentSlot(pageId);
    if (slot === -1) {
      throw new Error(
        `Cannot pin page ${pageId}: page is not resident in buffer pool`,
      );
    }
    this.pinSlot(slot);
  }

  unpinPage(pageId: number): void {
    this.validate_page_id(pageId);
    if (pageId === 1) return;
    const slot = this.getResidentSlot(pageId);
    if (slot !== -1) {
      this.unpinSlot(slot);
    }
  }

  isSlotPinned(slotIdx: number): boolean {
    this.validate_slot_idx(slotIdx);
    return buf_pool_is_pinned(this.pin_counts, slotIdx);
  }

  getPinCount(slotIdx: number): number {
    this.validate_slot_idx(slotIdx);
    return this.pin_counts[slotIdx];
  }

  getRefBit(slotIdx: number): number {
    this.validate_slot_idx(slotIdx);
    return this.ref_bits[slotIdx];
  }

  setRefBit(slotIdx: number, val: number): void {
    this.validate_slot_idx(slotIdx);
    this.ref_bits[slotIdx] = val ? 1 : 0;
  }


  allocArena(size: number): number {
    const aligned = (size + 7) & ~7;
    if (this.arena_offset + aligned > this.maxQueryMemory) {
      throw new QueryArenaExhaustedError();
    }
    const current = this.transientArenaOffset + this.arena_offset;
    this.arena_offset += aligned;
    return current;
  }
  resetArena(): void {
    if (this.arena_offset > 0) {
      memset(this.uint8, this.transientArenaOffset, 0, this.arena_offset);
      this.arena_offset = 0;
    }
  }
  getArenaOffset(): number {
    return this.arena_offset;
  }

  // ==========================================================================
  // Asynchronous Page Acquisition & Eviction Coordination
  // ==========================================================================

  async acquirePage(page_id: number, pin: boolean = false): Promise<number> {
    this.validate_page_id(page_id);

    // Fast Path: Cache Hit
    const existing_slot = this.getResidentSlot(page_id);
    if (existing_slot !== -1) {
      this.setRefBit(existing_slot, 1);
      if (pin) {
        this.pinSlot(existing_slot);
      }
      return existing_slot;
    }

    // Coalesce concurrent in-flight acquires for the same page_id
    const existing_acquire = this.in_flight_acquires.get(page_id);
    if (existing_acquire) {
      const slot = await existing_acquire;
      if (pin) {
        this.pinSlot(slot);
      }
      return slot;
    }

    const acquire_promise = (async () => {
      // Core Engine FFI: Core selects candidate slot via Clock sweep and determines flushPageId
      const { candidate_slot, flush_page_id, next_clock_hand } =
        buf_pool_select_eviction_victim(
          this.buffer,
          this.ref_bits,
          this.pin_counts,
          this.slotToPageOffset,
          this.dirtyMaskOffset,
          this.slotCount,
          this.clock_hand,
          page_id,
        );
      this.clock_hand = next_clock_hand;

      // Pin candidate slot so concurrent eviction cannot steal it during async I/O
      this.pinSlot(candidate_slot);

      try {
        // Resolve PAGE_FAULT via pure Block I/O
        await this.io.resolvePageFault(candidate_slot, page_id, flush_page_id);

        // Update slot mappings
        this.assignSlot(candidate_slot, page_id);
        this.setRefBit(candidate_slot, 1);
        this.clearDirty(candidate_slot);

        return candidate_slot;
      } catch (err) {
        if (candidate_slot !== -1) {
          this.unpinSlot(candidate_slot);
        }
        throw err;
      }
    })();

    this.in_flight_acquires.set(page_id, acquire_promise);

    try {
      const slot = await acquire_promise;
      if (!pin) {
        this.unpinSlot(slot);
      }
      return slot;
    } finally {
      this.in_flight_acquires.delete(page_id);
    }
  }

  acquireAndPinPage(page_id: number): Promise<number> {
    return this.acquirePage(page_id, true);
  }

  async flushSlot(slot_idx: number): Promise<void> {
    this.validate_slot_idx(slot_idx);
    const page_id = this.getAssignedPage(slot_idx);
    if (page_id === 0) return;

    if (slot_idx === 0 && page_id !== 1) {
      throw new Error(
        `Corruption detected: slot 0 is assigned to page ${page_id} instead of page 1`,
      );
    }

    const generation_at_flush = this.slot_dirty_generations[slot_idx];
    await this.io.writeSlot(slot_idx, page_id);

    if (this.slot_dirty_generations[slot_idx] === generation_at_flush) {
      this.clearDirty(slot_idx);
    }
  }

  async flushPage(page_id: number): Promise<void> {
    this.validate_page_id(page_id);
    const slot = this.getResidentSlot(page_id);
    if (slot !== -1 && this.isDirty(slot)) {
      await this.flushSlot(slot);
    }
  }

  async flushAllDirty(): Promise<void> {
    for (let i = 0; i < this.slotCount; i++) {
      if (this.isDirty(i)) {
        await this.flushSlot(i);
      }
    }
    await this.io.flush();
  }

  async allocatePage(pin: boolean = false): Promise<number> {
    return this.with_allocation_lock(async () => {
      const page1_view = this.getSlotDataView(0);
      const free_head = read_u32(page1_view, HEADER_OFFSET_FREE_PAGE_HEAD);
      const current_total = read_u32(page1_view, HEADER_OFFSET_TOTAL_PAGES);

      if (free_head > 0) {
        if (
          free_head <= 1 ||
          (current_total > 0 && free_head > current_total)
        ) {
          throw new CorruptPageError(
            free_head,
            `Corrupted free_page_head pointer ${free_head} (totalPages: ${current_total})`,
          );
        }

        const slot = await this.acquirePage(free_head, pin);
        const free_page_view = this.getSlotDataView(slot);

        const page_type = read_u8(free_page_view, PAGE_HEADER_OFFSET_TYPE);
        if (page_type !== PAGE_TYPE_FREE) {
          throw new CorruptPageError(
            free_head,
            `Expected free page type 0x00, got 0x${page_type.toString(16)}`,
          );
        }

        const next_free_id = read_u32(
          free_page_view,
          PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
        );
        if (
          next_free_id === free_head ||
          (current_total > 0 && next_free_id > current_total)
        ) {
          throw new CorruptPageError(
            free_head,
            `Corrupted next_free_page_id pointer ${next_free_id} in free page ${free_head}`,
          );
        }

        write_u32(page1_view, HEADER_OFFSET_FREE_PAGE_HEAD, next_free_id);
        this.markDirty(0);

        page_init(free_page_view, 0);
        this.markDirty(slot);

        return free_head;
      }

      const new_page_id = current_total + 1;
      write_u32(page1_view, HEADER_OFFSET_TOTAL_PAGES, new_page_id);
      this.markDirty(0);

      const slot = await this.acquirePage(new_page_id, pin);
      const new_page_view = this.getSlotDataView(slot);
      page_init(new_page_view, 0);
      this.markDirty(slot);

      return new_page_id;
    });
  }

  allocateAndPinPage(): Promise<number> {
    return this.allocatePage(true);
  }

  async freePage(page_id: number): Promise<void> {
    this.validate_page_id(page_id);

    if (page_id <= 1) {
      throw new Error(`Cannot free reserved database page ${page_id}`);
    }

    return this.with_allocation_lock(async () => {
      const page1_view = this.getSlotDataView(0);
      const current_total = read_u32(page1_view, HEADER_OFFSET_TOTAL_PAGES);
      if (current_total > 0 && page_id > current_total) {
        throw new Error(
          `Cannot free page ${page_id} beyond total pages ${current_total}`,
        );
      }

      const existing_slot = this.getResidentSlot(page_id);
      if (existing_slot !== -1 && this.isSlotPinned(existing_slot)) {
        throw new Error(`Cannot free pinned/active database page ${page_id}`);
      }

      const slot = await this.acquirePage(page_id, true);
      try {
        const view = this.getSlotDataView(slot);
        const page_type = page_get_type(view, 0);
        if (page_type === PAGE_TYPE_FREE) {
          this.unassignSlot(slot);
          throw new Error(
            `Double-free detected: page ${page_id} is already marked free`,
          );
        }
        if (page_type === PAGE_TYPE_CATALOG_PAGE) {
          throw new Error(`Cannot free system catalog page ${page_id}`);
        }

        const old_head = read_u32(page1_view, HEADER_OFFSET_FREE_PAGE_HEAD);

        page_init_free(view, 0, old_head);

        memset(
          this.uint8,
          slot * PAGE_SIZE + PAGE_HEADER_SIZE,
          0,
          PAGE_SIZE - PAGE_HEADER_SIZE,
        );

        await this.flushSlot(slot);

        this.unassignSlot(slot);
        this.clearDirty(slot);
        this.setRefBit(slot, 0);

        write_u32(page1_view, HEADER_OFFSET_FREE_PAGE_HEAD, page_id);
        this.markDirty(0);
      } finally {
        this.unpinSlot(slot);
      }
    });
  }

  /**
   * Drives the VDBE VM step loop, handling STATUS_PAGE_FAULT until completion.
   */
  async stepVm(ctx: VmContext, bytecode: Uint8Array): Promise<VmStatus> {
    let status = vm_step(ctx, this.view, bytecode);
    while (status === VmStatus.PAGE_FAULT) {
      const faultPageId = ctx.cursor.pageId;
      await this.acquirePage(faultPageId);
      ctx.status = VmStatus.RUNNING;
      status = vm_step(ctx, this.view, bytecode);
    }
    return status;
  }
}
