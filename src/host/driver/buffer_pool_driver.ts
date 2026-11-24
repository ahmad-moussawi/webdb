import {
  PAGE_SIZE,
  DEFAULT_SLOT_COUNT,
  MAX_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
  PAGE_TO_SLOT_BUCKET_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
  PAGE_HEADER_OFFSET_TYPE,
  PAGE_HEADER_SIZE,
  computeBufferPoolOffsets,
} from "../../constants.ts";

export type BufferPoolOffsets = ReturnType<typeof computeBufferPoolOffsets>;

import { IVfsAdapter } from "../storage/vfs.ts";
import { Io } from "../storage/io.ts";
import { read_u32, write_u32, read_u8, memset } from "../../shared/index.ts";
import {
  CorruptPageError,
  QueryArenaExhaustedError,
  VmStatus,
  VmContext,
} from "../../types/index.ts";
import {
  page_init,
  page_init_free,
  page_get_type,
} from "../../core/js/page.c.ts";
import {
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
} from "../../core/js/buffer_pool.c.ts";

// ============================================================================
// Helper to create Wasm Memory
// ============================================================================

export function createWasmMemory(
  slotCount: number = DEFAULT_SLOT_COUNT,
  maxQueryMemory: number = DEFAULT_MAX_QUERY_MEMORY,
): WebAssembly.Memory {
  const offsets = computeBufferPoolOffsets(slotCount, maxQueryMemory);
  const total_bytes = offsets.transientArenaOffset + maxQueryMemory;
  const wasm_pages = Math.ceil(total_bytes / 65536);
  return new WebAssembly.Memory({
    initial: wasm_pages,
    maximum: wasm_pages,
  });
}

// ============================================================================
// Async I/O Driver Loop (Host Layer)
// ============================================================================

export interface ReadAheadOptions {
  /** Maximum contiguous pages per sequential read-ahead batch (default: 32, max: 256). */
  maxPages?: number;
}

const READ_AHEAD_STREAM_COUNT = 8;
const DEFAULT_MAX_READ_AHEAD_PAGES = 32;
const MAX_READ_AHEAD_CAP = 256;

interface ReadAheadStream {
  frontierStart: number;
  frontierEnd: number;
  expectedChainNext: number;
  direction: -1 | 0 | 1;
  streak: number;
  windowSize: number;
  lastTick: number;
}

interface StreamMatchPlan {
  stream: ReadAheadStream;
  direction: -1 | 0 | 1;
  streak: number;
  desiredWindow: number;
  matchedViaChain: boolean;
}

export interface BufferPoolDriverOptions {
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
  useDefaultLayoutOffsets?: boolean;
  readAhead?: boolean | ReadAheadOptions;
}

/**
 * Async Buffer Pool Driver Loop.
 *
 * Implemented 100% in TypeScript on the Host Layer.
 * Interacts with the C Engine purely through shared WebAssembly.Memory and layout offsets.
 * Does NOT import or invoke any C-layer classes.
 */
export class BufferPoolDriver {
  readonly io: Io;
  readonly wasmMemory: WebAssembly.Memory;
  readonly buffer: ArrayBuffer;
  readonly view: DataView;
  readonly uint8: Uint8Array;
  readonly slotCount: number;
  readonly maxQueryMemory: number;
  readonly offsets: BufferPoolOffsets;

  // Offsets shortcuts
  readonly slotsBaseOffset: number;
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
  private readonly slot_views: DataView[];
  readonly readAheadEnabled: boolean;
  readonly maxReadAheadPages: number;

  private clock_hand: number = 0;
  private arena_offset: number = 0;
  private pool_epoch: number = 0;
  private read_ahead_epoch: number = 0;
  private free_slot_hint: number = 1;
  private read_ahead_tick: number = 0;
  private readonly read_ahead_streams: ReadAheadStream[];
  private readonly reserved_streams = new Set<ReadAheadStream>();

  private in_flight_acquires = new Map<
    number,
    { promise: Promise<number>; pinnedJoiners: number }
  >();
  private allocation_lock: Promise<void> = Promise.resolve();

  constructor(options: BufferPoolDriverOptions) {
    this.slotCount =
      options.slotCount ?? options.pool?.slotCount ?? DEFAULT_SLOT_COUNT;

    if (
      !Number.isInteger(this.slotCount) ||
      this.slotCount < 2 ||
      this.slotCount > MAX_SLOT_COUNT
    ) {
      throw new RangeError(
        `Invalid slotCount: ${this.slotCount}. Must be an integer between 2 and ${MAX_SLOT_COUNT}`,
      );
    }

    this.maxQueryMemory =
      options.maxQueryMemory ??
      options.pool?.maxQueryMemory ??
      DEFAULT_MAX_QUERY_MEMORY;

    const memory = options.memory ?? options.pool?.wasmMemory;

    if (!memory) {
      throw new Error(
        "BufferPoolDriver requires a valid WebAssembly.Memory (or pool with wasmMemory)",
      );
    }

    this.wasmMemory = memory;
    this.buffer = this.wasmMemory.buffer;
    (this.buffer as any).__webdbPool = this;
    this.view = new DataView(this.buffer);
    this.uint8 = new Uint8Array(this.buffer);

    this.offsets = computeBufferPoolOffsets(
      this.slotCount,
      this.maxQueryMemory,
    );

    this.slotsBaseOffset = this.offsets.slotsBaseOffset;
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
    this.slot_views = new Array<DataView>(this.slotCount);
    for (let i = 0; i < this.slotCount; i++) {
      this.slot_views[i] = new DataView(
        this.buffer,
        this.slotsBaseOffset + i * PAGE_SIZE,
        PAGE_SIZE,
      );
    }

    if (options.io) {
      this.io = options.io;
    } else if (options.vfs) {
      this.io = new Io({
        vfs: options.vfs,
        memory: this.wasmMemory,
        slotsBaseOffset: this.slotsBaseOffset,
      });
    } else {
      throw new Error(
        "BufferPoolDriver requires either an Io instance or IVfsAdapter",
      );
    }

    const defaultReadAhead =
      this.io.vfs.name !== "memory" && this.io.vfs.name !== "memory-ro";
    if (
      options.readAhead !== undefined &&
      typeof options.readAhead !== "boolean" &&
      (typeof options.readAhead !== "object" ||
        options.readAhead === null ||
        Array.isArray(options.readAhead))
    ) {
      throw new TypeError(
        "Invalid readAhead option: expected boolean or { maxPages?: number }",
      );
    }
    if (options.readAhead === false) {
      this.readAheadEnabled = false;
      this.maxReadAheadPages = 1;
    } else if (options.readAhead === true) {
      this.readAheadEnabled = true;
      this.maxReadAheadPages = DEFAULT_MAX_READ_AHEAD_PAGES;
    } else if (
      typeof options.readAhead === "object" &&
      options.readAhead !== null
    ) {
      const maxPages = options.readAhead.maxPages;
      if (maxPages !== undefined) {
        if (!Number.isInteger(maxPages) || maxPages < 0) {
          throw new RangeError(
            `Invalid readAhead.maxPages: ${maxPages}. Must be a non-negative integer`,
          );
        }
        if (maxPages <= 1) {
          this.readAheadEnabled = false;
          this.maxReadAheadPages = 1;
        } else {
          this.readAheadEnabled = true;
          this.maxReadAheadPages = Math.min(MAX_READ_AHEAD_CAP, maxPages);
        }
      } else {
        this.readAheadEnabled = true;
        this.maxReadAheadPages = DEFAULT_MAX_READ_AHEAD_PAGES;
      }
    } else {
      this.readAheadEnabled = defaultReadAhead;
      this.maxReadAheadPages = defaultReadAhead
        ? DEFAULT_MAX_READ_AHEAD_PAGES
        : 1;
    }

    this.read_ahead_streams = Array.from(
      { length: READ_AHEAD_STREAM_COUNT },
      (): ReadAheadStream => ({
        frontierStart: 0,
        frontierEnd: 0,
        expectedChainNext: 0,
        direction: 0,
        streak: 0,
        windowSize: 0,
        lastTick: 0,
      }),
    );

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

  setTransactionCoordinator(coordinator: any): void {
    this.io.setTransactionCoordinator(coordinator);
  }

  // ==========================================================================
  // In-Memory Slot Mapping & Hash Table Primitives
  // ==========================================================================

  getSlotOffset(slotIdx: number): number {
    this.validate_slot_idx(slotIdx);
    return this.slotsBaseOffset + slotIdx * PAGE_SIZE;
  }

  getPageBytesInSlot(slotIdx: number): Uint8Array {
    this.validate_slot_idx(slotIdx);
    const start = this.slotsBaseOffset + slotIdx * PAGE_SIZE;
    return this.uint8.subarray(start, start + PAGE_SIZE);
  }

  getSlotDataView(slotIdx: number): DataView {
    this.validate_slot_idx(slotIdx);
    const cached = this.slot_views[slotIdx];
    if (cached && cached.buffer === this.wasmMemory.buffer) {
      return cached;
    }
    const fresh = new DataView(
      this.wasmMemory.buffer,
      this.slotsBaseOffset + slotIdx * PAGE_SIZE,
      PAGE_SIZE,
    );
    this.slot_views[slotIdx] = fresh;
    return fresh;
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

    const prev_page = this.getAssignedPage(slotIdx);
    buf_pool_assign_slot(
      this.view,
      this.slotToPageOffset,
      this.pageToSlotOffset,
      this.pageToSlotBuckets,
      slotIdx,
      pageId,
    );
    this.ref_bits[slotIdx] = 1;
    if (prev_page > 0 && prev_page !== pageId) {
      this.pool_epoch++;
    }
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
    this.pool_epoch++;
    if (slotIdx < this.free_slot_hint) {
      this.free_slot_hint = slotIdx;
    }
  }

  resetReadAhead(): void {
    this.pool_epoch++;
    this.read_ahead_epoch++;
    this.free_slot_hint = 1;
    for (let i = 0; i < this.read_ahead_streams.length; i++) {
      const st = this.read_ahead_streams[i];
      st.frontierStart = 0;
      st.frontierEnd = 0;
      st.expectedChainNext = 0;
      st.direction = 0;
      st.streak = 0;
      st.windowSize = 0;
      st.lastTick = 0;
    }
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

  forceUnpinSlot(slotIdx: number): void {
    this.validate_slot_idx(slotIdx);
    if (slotIdx === 0) return;
    this.pin_counts[slotIdx] = 0;
  }

  forceUnpinPage(pageId: number): void {
    this.validate_page_id(pageId);
    if (pageId <= 1) return;
    const slot = this.getResidentSlot(pageId);
    if (slot !== -1) {
      this.forceUnpinSlot(slot);
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

  private countCleanEvictableSlots(): number {
    let count = 0;
    for (let s = 1; s < this.slotCount; s++) {
      if (this.isSlotPinned(s) || this.isDirty(s)) continue;
      const assigned = this.getAssignedPage(s);
      if (
        assigned === 0 ||
        this.uint8[this.slotsBaseOffset + s * PAGE_SIZE] !==
          PAGE_TYPE_CATALOG_PAGE
      ) {
        count++;
      }
    }
    return count;
  }

  private findCleanEvictionSlot(page_id: number): number {
    if (
      page_id > 1 &&
      page_id <= this.slotCount &&
      this.getAssignedPage(page_id - 1) === 0 &&
      !this.isSlotPinned(page_id - 1) &&
      !this.isDirty(page_id - 1)
    ) {
      return page_id - 1;
    }

    while (this.free_slot_hint < this.slotCount) {
      const s = this.free_slot_hint++;
      if (
        this.getAssignedPage(s) === 0 &&
        !this.isSlotPinned(s) &&
        !this.isDirty(s)
      ) {
        return s;
      }
    }

    let hand = this.clock_hand;
    for (let step = 0; step < this.slotCount * 2; step++) {
      hand = (hand + 1) % this.slotCount;
      if (hand === 0) continue;
      if (this.isSlotPinned(hand) || this.isDirty(hand)) continue;
      const assigned = this.getAssignedPage(hand);
      if (
        assigned > 0 &&
        this.uint8[this.slotsBaseOffset + hand * PAGE_SIZE] ===
          PAGE_TYPE_CATALOG_PAGE
      ) {
        continue;
      }
      if (this.ref_bits[hand] === 1) {
        this.ref_bits[hand] = 0;
      } else {
        this.clock_hand = hand;
        return hand;
      }
    }

    return -1;
  }

  private readChainedNextPageId(
    slotIdx: number,
    pageId: number,
    totalPages: number,
  ): number {
    const pageOff = this.slotsBaseOffset + slotIdx * PAGE_SIZE;
    const pageType = this.uint8[pageOff];
    if (
      pageType === PAGE_TYPE_LEAF_DATA ||
      pageType === PAGE_TYPE_INDEX_LEAF ||
      pageType === PAGE_TYPE_OVERFLOW
    ) {
      const nextId = read_u32(
        this.view,
        pageOff + PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
      );
      if (nextId > 1 && nextId !== pageId && nextId <= totalPages) {
        return nextId;
      }
    }
    return 0;
  }

  private planStreamMatch(page_id: number): StreamMatchPlan {
    // 1. Exact chain pointer match (triggers on the 2nd page of leaf/index/overflow chains)
    for (let i = 0; i < this.read_ahead_streams.length; i++) {
      const st = this.read_ahead_streams[i];
      if (st.frontierStart > 0 && st.expectedChainNext === page_id) {
        const desiredWindow =
          st.windowSize >= 4 ? st.windowSize : st.windowSize === 0 ? 4 : 1;
        return {
          stream: st,
          direction: 1,
          streak: st.streak,
          desiredWindow,
          matchedViaChain: true,
        };
      }
    }

    // 2. Unchained contiguous ascending or descending stride match (requires streak >= 3)
    for (let i = 0; i < this.read_ahead_streams.length; i++) {
      const st = this.read_ahead_streams[i];
      if (st.frontierStart <= 0) continue;

      if (page_id === st.frontierEnd + 1 && st.direction >= 0) {
        const nextStreak = st.streak + 1;
        const desiredWindow =
          st.windowSize >= 4
            ? Math.min(this.maxReadAheadPages, st.windowSize * 2)
            : nextStreak >= 3
              ? 4
              : 1;
        return {
          stream: st,
          direction: 1,
          streak: nextStreak,
          desiredWindow,
          matchedViaChain: false,
        };
      }

      if (page_id === st.frontierStart - 1 && st.direction <= 0) {
        const nextStreak = st.streak + 1;
        const desiredWindow =
          st.windowSize >= 4
            ? Math.min(this.maxReadAheadPages, st.windowSize * 2)
            : nextStreak >= 3
              ? 4
              : 1;
        return {
          stream: st,
          direction: -1,
          streak: nextStreak,
          desiredWindow,
          matchedViaChain: false,
        };
      }
    }

    // 3. Select a stream slot: unreserved unused > unreserved oldest inactive > global LRU
    let target: ReadAheadStream | null = null;
    for (let i = 0; i < this.read_ahead_streams.length; i++) {
      const st = this.read_ahead_streams[i];
      if (st.frontierStart === 0 && !this.reserved_streams.has(st)) {
        target = st;
        break;
      }
    }

    if (!target) {
      let oldestInactive: ReadAheadStream | null = null;
      let oldestUnreserved: ReadAheadStream | null = null;
      let oldestAny = this.read_ahead_streams[0];
      for (let i = 0; i < this.read_ahead_streams.length; i++) {
        const st = this.read_ahead_streams[i];
        if (st.lastTick < oldestAny.lastTick) {
          oldestAny = st;
        }
        if (this.reserved_streams.has(st)) {
          continue;
        }
        if (!oldestUnreserved || st.lastTick < oldestUnreserved.lastTick) {
          oldestUnreserved = st;
        }
        if (
          st.windowSize <= 1 &&
          st.expectedChainNext === 0 &&
          (!oldestInactive || st.lastTick < oldestInactive.lastTick)
        ) {
          oldestInactive = st;
        }
      }
      target = oldestInactive ?? oldestUnreserved ?? oldestAny;
    }

    return {
      stream: target,
      direction: 0,
      streak: 1,
      desiredWindow: 1,
      matchedViaChain: false,
    };
  }

  private commitStreamAfterRead(
    plan: StreamMatchPlan,
    page_id: number,
    candidate_slot: number,
    batchPageIds: number[],
    curTotal: number,
  ): void {
    const st = plan.stream;
    let fStart = batchPageIds.length > 0 ? batchPageIds[0] : page_id;
    let fEnd =
      batchPageIds.length > 0 ? batchPageIds[batchPageIds.length - 1] : page_id;

    // Advance frontier past contiguous already-resident pages so warm cache islands
    // do not reset an active sequential stream on the next cache miss.
    if (plan.direction >= 0) {
      const limit = Math.min(curTotal, fEnd + this.maxReadAheadPages);
      while (fEnd < limit && this.getResidentSlot(fEnd + 1) !== -1) {
        fEnd++;
      }
    } else if (plan.direction === -1) {
      const limit = Math.max(2, fStart - this.maxReadAheadPages);
      while (fStart > limit && this.getResidentSlot(fStart - 1) !== -1) {
        fStart--;
      }
    }

    st.frontierStart = fStart;
    st.frontierEnd = fEnd;
    st.direction = plan.direction;
    st.streak = plan.streak;
    st.lastTick = ++this.read_ahead_tick;

    if (plan.direction < 0) {
      st.expectedChainNext = 0;
      st.windowSize = plan.desiredWindow;
      return;
    }

    let chainHits = 1;
    let curPid = page_id;
    let curSlot = candidate_slot;
    let nextExpected = 0;
    const maxHops = Math.min(
      this.slotCount,
      Math.max(batchPageIds.length, plan.desiredWindow) + 16,
    );
    const visited = new Set<number>([curPid]);
    for (let h = 0; h < maxHops; h++) {
      const nextId = this.readChainedNextPageId(curSlot, curPid, curTotal);
      if (nextId === 0 || visited.has(nextId)) {
        nextExpected = 0;
        break;
      }
      visited.add(nextId);
      const nextSlot = this.getResidentSlot(nextId);
      if (nextSlot === -1) {
        nextExpected = nextId;
        break;
      }
      chainHits++;
      curPid = nextId;
      curSlot = nextSlot;
    }
    st.expectedChainNext = nextExpected;

    if (batchPageIds.length <= 1 && chainHits === 1) {
      if (plan.direction === 0 && plan.streak === 1) {
        st.windowSize = 0;
      } else if (plan.matchedViaChain) {
        st.windowSize =
          nextExpected !== 0 && Math.abs(nextExpected - page_id) <= 4 ? 4 : 1;
      } else {
        st.windowSize = plan.desiredWindow;
      }
    } else if (chainHits >= 2 && nextExpected !== 0) {
      st.windowSize = Math.min(
        this.maxReadAheadPages,
        Math.max(batchPageIds.length, plan.desiredWindow) * 2,
      );
    } else if (nextExpected === 0) {
      st.windowSize = plan.matchedViaChain
        ? 1
        : Math.max(4, batchPageIds.length, plan.desiredWindow);
    } else if (Math.abs(nextExpected - page_id) <= 4) {
      st.windowSize = 4;
    } else {
      st.windowSize = 1;
    }
  }

  private async acquirePageInternal(
    page_id: number,
    pin: boolean,
    allowReadAhead: boolean,
  ): Promise<number> {
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

    // Coalesce concurrent in-flight acquires for the same page_id.
    // Record pin intent synchronously so unpinning an unpinned initiator never creates a pin=0 gap.
    const existing_acquire = this.in_flight_acquires.get(page_id);
    if (existing_acquire) {
      if (pin) {
        existing_acquire.pinnedJoiners++;
      }
      return existing_acquire.promise;
    }

    const totalPages = read_u32(
      this.getSlotDataView(0),
      HEADER_OFFSET_TOTAL_PAGES,
    );
    const canPrefetch =
      allowReadAhead &&
      this.readAheadEnabled &&
      page_id > 1 &&
      totalPages > 2 &&
      page_id <= totalPages &&
      this.slotCount >= 8 &&
      !this.io.hasSpilledOrCommittedPage(page_id);

    const streamEpochBefore = this.read_ahead_epoch;
    let matchPlan: StreamMatchPlan | null = null;
    let batchPageIds: number[] = [page_id];

    if (canPrefetch) {
      matchPlan = this.planStreamMatch(page_id);
      this.reserved_streams.add(matchPlan.stream);

      if (matchPlan.desiredWindow >= 2) {
        const cleanSlots = this.countCleanEvictableSlots();
        const maxBatchCap = Math.min(
          this.maxReadAheadPages,
          Math.floor(this.slotCount / 4),
          Math.max(1, cleanSlots - 2),
        );
        const actualWindow = Math.min(matchPlan.desiredWindow, maxBatchCap);
        if (actualWindow >= 2) {
          if (matchPlan.direction >= 0) {
            const maxPage = Math.min(totalPages, page_id + actualWindow - 1);
            batchPageIds = [page_id];
            for (let p = page_id + 1; p <= maxPage; p++) {
              if (
                this.in_flight_acquires.has(p) ||
                this.io.hasInFlightRead(p) ||
                this.io.hasInFlightFlush(p)
              ) {
                break;
              }
              batchPageIds.push(p);
            }
          } else {
            const minPage = Math.max(2, page_id - actualWindow + 1);
            const desc: number[] = [page_id];
            for (let p = page_id - 1; p >= minPage; p--) {
              if (
                this.in_flight_acquires.has(p) ||
                this.io.hasInFlightRead(p) ||
                this.io.hasInFlightFlush(p)
              ) {
                break;
              }
              desc.push(p);
            }
            desc.reverse();
            batchPageIds = desc;
          }

          let hasNonResidentSpeculative = false;
          for (let i = 0; i < batchPageIds.length; i++) {
            const p = batchPageIds[i];
            if (
              p !== page_id &&
              this.getResidentSlot(p) === -1 &&
              !this.io.hasSpilledOrCommittedPage(p)
            ) {
              hasNonResidentSpeculative = true;
              break;
            }
          }
          if (!hasNonResidentSpeculative) {
            batchPageIds = [page_id];
          }
        }
      }
    }

    const entry = {
      promise: null as unknown as Promise<number>,
      pinnedJoiners: 0,
    };

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
        if (flush_page_id > 0) {
          await this.io.spillOrWriteSlot(candidate_slot, flush_page_id);
        }

        // Unmap the evicted page immediately before async read I/O so concurrent acquires
        // for the evicted page cannot hit and get clobbered in candidate_slot.
        if (this.getAssignedPage(candidate_slot) > 0) {
          this.unassignSlot(candidate_slot);
          this.clearDirty(candidate_slot);
        }

        const poolEpochBefore = this.pool_epoch;
        let loadedMap: Map<number, Uint8Array | null> | null = null;

        if (batchPageIds.length <= 1) {
          await this.io.readSlot(candidate_slot, page_id);
        } else {
          loadedMap = await this.io.readPagesBatch(batchPageIds, page_id);
          const demandBytes = loadedMap.get(page_id) ?? null;
          const slotOff = this.slotsBaseOffset + candidate_slot * PAGE_SIZE;
          if (demandBytes) {
            this.uint8.set(demandBytes, slotOff);
          } else {
            this.uint8.fill(0, slotOff, slotOff + PAGE_SIZE);
          }
        }

        this.assignSlot(candidate_slot, page_id);
        this.setRefBit(candidate_slot, 1);
        this.clearDirty(candidate_slot);

        const curTotal = read_u32(
          this.getSlotDataView(0),
          HEADER_OFFSET_TOTAL_PAGES,
        );

        if (loadedMap && this.pool_epoch === poolEpochBefore) {
          for (let i = 0; i < batchPageIds.length; i++) {
            const p = batchPageIds[i];
            if (p === page_id || p <= 1 || p > curTotal) continue;
            const specBytes = loadedMap.get(p);
            if (
              !specBytes ||
              specBytes[0] === PAGE_TYPE_FREE ||
              specBytes[0] === PAGE_TYPE_CATALOG_PAGE
            ) {
              continue;
            }
            if (
              this.getResidentSlot(p) !== -1 ||
              this.in_flight_acquires.has(p) ||
              this.io.hasSpilledOrCommittedPage(p) ||
              this.io.hasInFlightFlush(p)
            ) {
              continue;
            }
            const specSlot = this.findCleanEvictionSlot(p);
            if (specSlot === -1) break;
            this.uint8.set(
              specBytes,
              this.slotsBaseOffset + specSlot * PAGE_SIZE,
            );
            this.assignSlot(specSlot, p);
            this.setRefBit(specSlot, 0);
            this.clearDirty(specSlot);
          }
        }

        if (matchPlan && this.read_ahead_epoch === streamEpochBefore) {
          this.commitStreamAfterRead(
            matchPlan,
            page_id,
            candidate_slot,
            batchPageIds,
            curTotal,
          );
        }

        // Grant pins for all coalesced pinned joiners atomically before resolving
        for (let k = 0; k < entry.pinnedJoiners; k++) {
          this.pinSlot(candidate_slot);
        }

        return candidate_slot;
      } catch (err) {
        if (candidate_slot !== -1) {
          this.unpinSlot(candidate_slot);
        }
        throw err;
      }
    })();

    entry.promise = acquire_promise;
    this.in_flight_acquires.set(page_id, entry);

    try {
      const slot = await acquire_promise;
      if (!pin) {
        this.unpinSlot(slot);
      }
      return slot;
    } finally {
      this.in_flight_acquires.delete(page_id);
      if (matchPlan) {
        this.reserved_streams.delete(matchPlan.stream);
      }
    }
  }

  acquirePage(page_id: number, pin: boolean = false): Promise<number> {
    return this.acquirePageInternal(page_id, pin, true);
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
    const dirty: Array<{ slotIdx: number; pageId: number; generation: number }> = [];
    // Collect slots 1..N-1 before slot 0 (Page 1) so data/index/overflow page links
    // are written ahead of Page 1's updated tailPageId/totalPages pointers on non-atomic storage.
    for (let i = 1; i < this.slotCount; i++) {
      if (this.isDirty(i)) {
        const pageId = this.getAssignedPage(i);
        if (pageId > 0) {
          dirty.push({ slotIdx: i, pageId, generation: this.slot_dirty_generations[i] });
        }
      }
    }
    if (this.isDirty(0)) {
      const pageId = this.getAssignedPage(0);
      if (pageId > 0) {
        if (pageId !== 1) {
          throw new Error(
            `Corruption detected: slot 0 is assigned to page ${pageId} instead of page 1`,
          );
        }
        dirty.push({ slotIdx: 0, pageId, generation: this.slot_dirty_generations[0] });
      }
    }

    if (dirty.length === 0) {
      return;
    }

    // If any dirty page still has an older image in the WAL, commit the whole batch through the
    // WAL atomically (a direct write to main storage would be overwritten by WAL replay).
    if (this.io.shouldWriteThroughWal(dirty.map((d) => d.pageId))) {
      await this.io.writeSlotsViaWal(dirty);
      for (const d of dirty) {
        if (this.slot_dirty_generations[d.slotIdx] === d.generation) {
          this.clearDirty(d.slotIdx);
        }
      }
      await this.io.flush();
      return;
    }

    await this.io.writeSlots(dirty);
    for (const d of dirty) {
      if (this.slot_dirty_generations[d.slotIdx] === d.generation) {
        this.clearDirty(d.slotIdx);
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

        const slot = await this.acquirePageInternal(free_head, pin, false);
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

      const slot = await this.acquirePageInternal(new_page_id, pin, false);
      const new_page_view = this.getSlotDataView(slot);
      page_init(new_page_view, 0);
      this.markDirty(slot);

      return new_page_id;
    });
  }

  allocateAndPinPage(): Promise<number> {
    return this.allocatePage(true);
  }

  async freePage(page_id: number, force: boolean = false): Promise<void> {
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
      if (existing_slot !== -1) {
        if (force) {
          this.forceUnpinSlot(existing_slot);
        } else if (this.isSlotPinned(existing_slot)) {
          throw new Error(`Cannot free pinned/active database page ${page_id}`);
        }
      }

      const slot = await this.acquirePageInternal(page_id, true, false);
      try {
        const view = this.getSlotDataView(slot);
        const page_type = page_get_type(view, 0);
        if (page_type === PAGE_TYPE_FREE) {
          this.unassignSlot(slot);
          if (force) {
            return;
          }
          throw new Error(
            `Double-free detected: page ${page_id} is already marked free`,
          );
        }
        if (!force && page_type === PAGE_TYPE_CATALOG_PAGE) {
          throw new Error(`Cannot free system catalog page ${page_id}`);
        }

        const old_head = read_u32(page1_view, HEADER_OFFSET_FREE_PAGE_HEAD);

        page_init_free(view, 0, old_head);

        memset(
          this.uint8,
          this.slotsBaseOffset + slot * PAGE_SIZE + PAGE_HEADER_SIZE,
          0,
          PAGE_SIZE - PAGE_HEADER_SIZE,
        );

        if (this.io.isInTransaction()) {
          await this.io.spillOrWriteSlot(slot, page_id);
        } else {
          await this.flushSlot(slot);
        }

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
   * Drives the VDBE VM step loop with an explicit `stepFn` runner, handling
   * `VmStatus.PAGE_FAULT` until completion.
   */
  async stepVm(
    ctx: VmContext,
    bytecode: Uint8Array,
    stepFn: (ctx: VmContext, view: DataView, bytecode: Uint8Array) => VmStatus,
  ): Promise<VmStatus> {
    if (typeof stepFn !== "function") {
      throw new TypeError("BufferPoolDriver.stepVm requires a stepFn runner");
    }
    let status = stepFn(ctx, this.view, bytecode);
    while (status === VmStatus.PAGE_FAULT) {
      const faultPageId =
        ctx.fault_page_id > 0 ? ctx.fault_page_id : ctx.cursor.pageId;
      const pinnedSlots: number[] = [];
      const cursors = ctx.cursors ?? [ctx.cursor];
      for (const c of cursors) {
        if (c && c.pageId > 1) {
          const s = this.getResidentSlot(c.pageId);
          if (s > 0 && !pinnedSlots.includes(s)) {
            this.pinSlot(s);
            pinnedSlots.push(s);
          }
        }
      }
      try {
        await this.acquirePage(faultPageId);
      } finally {
        for (const s of pinnedSlots) {
          this.unpinSlot(s);
        }
      }
      ctx.fault_page_id = 0;
      ctx.status = VmStatus.RUNNING;
      status = stepFn(ctx, this.view, bytecode);
    }
    return status;
  }
}
