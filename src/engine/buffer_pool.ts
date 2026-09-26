import {
  PAGE_SIZE,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
  PAGE_TO_SLOT_BUCKET_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_HEADER_OFFSET_CHECKSUM,
  HEADER_OFFSET_PAGE_CHECKSUM,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
  PAGE_HEADER_OFFSET_TYPE,
  PAGE_HEADER_SIZE,
  computeBufferPoolOffsets,
} from "../constants.js";
import { initPage, initFreePage, getPageType } from "./page.js";
import { pageTableGet, pageTableSet, pageTableDelete } from "./page_table.js";
import { IVfsAdapter } from "../storage/vfs.js";
import { computePageChecksum, computePage1Checksum } from "../storage/crc32.js";
import { CorruptPageError, QueryArenaExhaustedError } from "../types.js";

export interface BufferPoolOptions {
  slotCount?: number;
  maxQueryMemory?: number;
  vfs: IVfsAdapter;
}

export class BufferPool {
  readonly slotCount: number;
  readonly maxQueryMemory: number;
  readonly vfs: IVfsAdapter;

  readonly wasmMemory: WebAssembly.Memory;
  buffer: ArrayBuffer;
  view: DataView;
  uint8: Uint8Array;

  // Offsets
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

  // In-flight concurrency coordination & pinning
  private inFlightFlushes = new Map<number, Promise<void>>();
  private inFlightAcquires = new Map<number, Promise<number>>();
  private allocationLock: Promise<void> = Promise.resolve();
  private pinCounts: Uint32Array;
  private slotDirtyGenerations: Uint32Array;
  private clockHand: number = 0;
  private refBits: Uint8Array;
  private arenaOffset: number = 0;

  constructor(options: BufferPoolOptions) {
    this.slotCount = options.slotCount ?? DEFAULT_SLOT_COUNT;

    if (!Number.isInteger(this.slotCount) || this.slotCount < 2) {
      throw new Error(
        `Invalid slotCount: ${this.slotCount}. Must be an integer >= 2`,
      );
    }

    this.maxQueryMemory = options.maxQueryMemory ?? DEFAULT_MAX_QUERY_MEMORY;

    if (!Number.isInteger(this.maxQueryMemory) || this.maxQueryMemory <= 0) {
      throw new Error(
        `Invalid maxQueryMemory: ${this.maxQueryMemory}. Must be a positive integer`,
      );
    }

    this.vfs = options.vfs;
    this.refBits = new Uint8Array(this.slotCount);
    this.pinCounts = new Uint32Array(this.slotCount);
    this.slotDirtyGenerations = new Uint32Array(this.slotCount);

    const offsets = computeBufferPoolOffsets(
      this.slotCount,
      this.maxQueryMemory,
    );
    this.slotsEndOffset = offsets.slotsEndOffset;
    this.slotToPageOffset = offsets.slotToPageOffset;
    this.pageToSlotOffset = offsets.pageToSlotOffset;
    this.pageToSlotBuckets = offsets.pageToSlotBuckets;
    this.dirtyMaskOffset = offsets.dirtyMaskOffset;
    this.vmContextOffset = offsets.vmContextOffset;
    this.resultBufferOffset = offsets.resultBufferOffset;
    this.bytecodeOffset = offsets.bytecodeOffset;
    this.pageScratchpadOffset = offsets.pageScratchpadOffset;
    this.transientArenaOffset = offsets.transientArenaOffset;

    // Allocate WebAssembly.Memory (64KB per page)
    const initialBytes = this.transientArenaOffset + 256 * 1024;
    const initialWasmPages = Math.ceil(initialBytes / 65536);
    const maxWasmPages = Math.ceil(
      (this.transientArenaOffset + this.maxQueryMemory) / 65536,
    );

    this.wasmMemory = new WebAssembly.Memory({
      initial: initialWasmPages,
      maximum: Math.max(initialWasmPages, maxWasmPages),
    });

    this.buffer = this.wasmMemory.buffer;
    this.view = new DataView(this.buffer);
    this.uint8 = new Uint8Array(this.buffer);

    // Initialize slot-to-page map, page-to-slot hash table, and dirty mask to zeros
    this.fillBytes(this.slotToPageOffset, this.slotCount * 4, 0);
    this.fillBytes(
      this.pageToSlotOffset,
      this.pageToSlotBuckets * PAGE_TO_SLOT_BUCKET_SIZE,
      0,
    );
    this.fillBytes(this.dirtyMaskOffset, Math.ceil(this.slotCount / 8), 0);

    // Page 1 is permanently assigned to slot 0 and pinned
    this.setSlotToPage(0, 1);
    this.pinCounts[0] = 1;
  }

  // ==========================================================================
  // Memory Access Primitives (Little-Endian, Direct-Addressing)
  // ==========================================================================

  readUint8(address: number): number {
    return this.uint8[address];
  }

  writeUint8(address: number, value: number): void {
    this.uint8[address] = value;
  }

  readUint16(address: number): number {
    return this.view.getUint16(address, true);
  }

  writeUint16(address: number, value: number): void {
    this.view.setUint16(address, value, true);
  }

  readUint32(address: number): number {
    return this.view.getUint32(address, true);
  }

  writeUint32(address: number, value: number): void {
    this.view.setUint32(address, value, true);
  }

  readInt32(address: number): number {
    return this.view.getInt32(address, true);
  }

  writeInt32(address: number, value: number): void {
    this.view.setInt32(address, value, true);
  }

  readFloat64(address: number): number {
    return this.view.getFloat64(address, true);
  }

  writeFloat64(address: number, value: number): void {
    this.view.setFloat64(address, value, true);
  }

  /**
   * Returns a zero-copy byte slice (Uint8Array view) of the specified memory range.
   */
  getBytes(address: number, length: number): Uint8Array {
    return this.uint8.subarray(address, address + length);
  }

  /**
   * Copies bytes from a source Uint8Array into memory starting at address.
   */
  setBytes(address: number, source: Uint8Array): void {
    this.uint8.set(source, address);
  }

  /**
   * Fills a range of memory with a byte value (default 0) without heap allocation.
   */
  fillBytes(address: number, length: number, value: number = 0): void {
    this.uint8.fill(value, address, address + length);
  }

  // ==========================================================================
  // Validation Helpers
  // ==========================================================================

  private validateSlotIndex(slotIdx: number): void {
    if (
      !Number.isInteger(slotIdx) ||
      slotIdx < 0 ||
      slotIdx >= this.slotCount
    ) {
      throw new Error(
        `Invalid slot index: ${slotIdx}. Must be an integer between 0 and ${this.slotCount - 1}`,
      );
    }
  }

  private validatePageId(pageId: number): void {
    if (!Number.isInteger(pageId) || pageId <= 0) {
      throw new Error(
        `Invalid page ID: ${pageId}. Page IDs must be positive integers.`,
      );
    }
  }

  private async withAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previousLock = this.allocationLock;
    let release: () => void;
    this.allocationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousLock;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  // ==========================================================================
  // Slot Mapping & Dirty Bitmask
  // ==========================================================================

  getSlotToPage(slotIdx: number): number {
    this.validateSlotIndex(slotIdx);
    return this.readUint32(this.slotToPageOffset + slotIdx * 4);
  }

  setSlotToPage(slotIdx: number, pageId: number): void {
    this.validateSlotIndex(slotIdx);

    if (!Number.isInteger(pageId) || pageId < 0) {
      throw new Error(
        `Invalid page ID: ${pageId}. Must be a non-negative integer`,
      );
    }

    if (slotIdx === 0 && pageId !== 1) {
      throw new Error(
        `Cannot reassign slot 0: reserved permanently for page 1 (got page ${pageId})`,
      );
    }

    if (pageId > 0) {
      const existingSlot = this.getResidentSlot(pageId);
      if (existingSlot !== -1 && existingSlot !== slotIdx) {
        throw new Error(
          `Cannot map page ${pageId} to slot ${slotIdx}: already resident in slot ${existingSlot}`,
        );
      }
    }

    const old = this.getSlotToPage(slotIdx);
    if (old > 0 && old !== pageId) {
      pageTableDelete(
        this.view,
        this.pageToSlotOffset,
        this.pageToSlotBuckets,
        old,
      );
    }

    this.writeUint32(this.slotToPageOffset + slotIdx * 4, pageId);
    if (pageId > 0) {
      pageTableSet(
        this.view,
        this.pageToSlotOffset,
        this.pageToSlotBuckets,
        pageId,
        slotIdx,
      );
    }
  }

  markDirty(slotIdx: number): void {
    this.validateSlotIndex(slotIdx);
    const byteIdx = this.dirtyMaskOffset + (slotIdx >> 3);
    const bitMask = 1 << (slotIdx & 7);
    this.uint8[byteIdx] |= bitMask;
    this.slotDirtyGenerations[slotIdx]++;
  }

  clearDirty(slotIdx: number): void {
    this.validateSlotIndex(slotIdx);
    const byteIdx = this.dirtyMaskOffset + (slotIdx >> 3);
    const bitMask = 1 << (slotIdx & 7);
    this.uint8[byteIdx] &= ~bitMask;
  }

  isDirty(slotIdx: number): boolean {
    this.validateSlotIndex(slotIdx);
    const byteIdx = this.dirtyMaskOffset + (slotIdx >> 3);
    const bitMask = 1 << (slotIdx & 7);
    return (this.uint8[byteIdx] & bitMask) !== 0;
  }

  // ==========================================================================
  // Pinning Invariant (Reference Counted)
  // ==========================================================================

  pinSlot(slotIdx: number): void {
    this.validateSlotIndex(slotIdx);
    if (this.pinCounts[slotIdx] >= 0xffffffff) {
      throw new Error(`Pin count overflow on slot ${slotIdx}`);
    }
    this.pinCounts[slotIdx]++;
  }

  unpinSlot(slotIdx: number): void {
    this.validateSlotIndex(slotIdx);
    // Slot 0 (Page 1) is permanently pinned
    if (slotIdx === 0) return;
    if (this.pinCounts[slotIdx] > 0) {
      this.pinCounts[slotIdx]--;
    }
  }

  pinPage(pageId: number): void {
    this.validatePageId(pageId);
    const slot = this.getResidentSlot(pageId);
    if (slot === -1) {
      throw new Error(
        `Cannot pin page ${pageId}: page is not resident in buffer pool`,
      );
    }
    this.pinSlot(slot);
  }

  unpinPage(pageId: number): void {
    this.validatePageId(pageId);
    if (pageId === 1) return;
    const slot = this.getResidentSlot(pageId);
    if (slot !== -1) {
      this.unpinSlot(slot);
    }
  }

  isSlotPinned(slotIdx: number): boolean {
    this.validateSlotIndex(slotIdx);
    return slotIdx === 0 || this.pinCounts[slotIdx] > 0;
  }

  getPinCount(slotIdx: number): number {
    this.validateSlotIndex(slotIdx);
    return this.pinCounts[slotIdx];
  }

  getRefBit(slotIdx: number): number {
    this.validateSlotIndex(slotIdx);
    return this.refBits[slotIdx];
  }

  setRefBit(slotIdx: number, val: number): void {
    this.validateSlotIndex(slotIdx);
    this.refBits[slotIdx] = val ? 1 : 0;
  }

  // ==========================================================================
  // Page Access, Fetching & Eviction
  // ==========================================================================

  getSlotOffset(slotIdx: number): number {
    this.validateSlotIndex(slotIdx);
    return slotIdx * PAGE_SIZE;
  }

  getPageBytesInSlot(slotIdx: number): Uint8Array {
    this.validateSlotIndex(slotIdx);
    return this.getBytes(slotIdx * PAGE_SIZE, PAGE_SIZE);
  }

  getSlotDataView(slotIdx: number): DataView {
    this.validateSlotIndex(slotIdx);
    return new DataView(this.buffer, slotIdx * PAGE_SIZE, PAGE_SIZE);
  }

  /**
   * Returns resident slot index for a page, or -1 if not currently in cache.
   * Probes the in-memory binary open-addressing hash table at pageToSlotOffset.
   */
  getResidentSlot(pageId: number): number {
    this.validatePageId(pageId);
    return pageTableGet(
      this.view,
      this.pageToSlotOffset,
      this.pageToSlotBuckets,
      pageId,
    );
  }

  /**
   * Retrieves a page into cache, evicting an unpinned slot if necessary.
   * Verifies CRC32 checksum when read from storage.
   *
   * @param pageId Positive 1-based page identifier
   * @param pin Optional boolean (default false). When true, atomically increments
   *            the pin count on the acquired slot before returning to prevent
   *            use-after-evict race conditions.
   * @returns Cache slot index hosting the page
   */
  async acquirePage(pageId: number, pin: boolean = false): Promise<number> {
    this.validatePageId(pageId);

    // If an in-flight flush is occurring for this page, await it so we never read
    // a stale or partially written state from VFS
    const inFlight = this.inFlightFlushes.get(pageId);

    if (inFlight) {
      await inFlight;
    }

    // Cache Hit (Fast Path):
    // 1. If the page is already resident in cache, avoid costly disk/VFS I/O and slot eviction.
    // 2. Enforces single-instance residency: a given pageId can only ever reside in exactly ONE slot,
    //    preventing split-brain cache states and lost updates.
    // 3. Updates the Clock (Second-Chance) refBit to 1, protecting hot/recently accessed pages from eviction.
    // 4. If requested, atomically increments the slot's pin count before returning to guard against concurrent eviction.
    const existingSlot = this.getResidentSlot(pageId);
    if (existingSlot !== -1) {
      this.refBits[existingSlot] = 1;
      if (pin) {
        this.pinSlot(existingSlot);
      }
      return existingSlot;
    }

    // Coalesce concurrent in-flight acquires for the same pageId
    const existingAcquire = this.inFlightAcquires.get(pageId);
    if (existingAcquire) {
      const slot = await existingAcquire;
      if (pin) {
        this.pinSlot(slot);
      }
      return slot;
    }

    const acquirePromise = (async () => {
      // Prefer slot = pageId - 1 if within cache bounds and free/unpinned
      let candidateSlot = -1;
      if (
        pageId > 1 &&
        pageId <= this.slotCount &&
        this.getSlotToPage(pageId - 1) === 0 &&
        !this.isSlotPinned(pageId - 1)
      ) {
        candidateSlot = pageId - 1;
      } else {
        candidateSlot = await this.findEvictionCandidateSlot();
      }

      // Pin candidateSlot immediately so no concurrent acquire/eviction can steal it
      // while vfs.readPage(pageId) is in flight!
      this.pinSlot(candidateSlot);

      try {
        // Read page from VFS
        const diskPage = await this.vfs.readPage(pageId);
        const slotOffset = candidateSlot * PAGE_SIZE;

        if (diskPage) {
          if (diskPage.byteLength !== PAGE_SIZE) {
            throw new CorruptPageError(
              pageId,
              `Unexpected page byte length: ${diskPage.byteLength}, expected ${PAGE_SIZE}`,
            );
          }

          // Verify CRC32 checksum on read
          const checksumOffset =
            pageId === 1
              ? HEADER_OFFSET_PAGE_CHECKSUM
              : PAGE_HEADER_OFFSET_CHECKSUM;
          const storedChecksum = new DataView(
            diskPage.buffer,
            diskPage.byteOffset,
          ).getUint32(checksumOffset, true);

          if (storedChecksum !== 0) {
            const computed =
              pageId === 1
                ? computePage1Checksum(diskPage)
                : computePageChecksum(diskPage);

            if (computed !== storedChecksum) {
              throw new CorruptPageError(pageId, storedChecksum, computed);
            }
          }

          this.setBytes(slotOffset, diskPage);
        } else {
          // Empty/new unwritten page
          this.fillBytes(slotOffset, PAGE_SIZE, 0);
        }

        // Update mappings
        this.setSlotToPage(candidateSlot, pageId);
        this.refBits[candidateSlot] = 1;
        this.clearDirty(candidateSlot);

        return candidateSlot;
      } catch (err) {
        if (candidateSlot !== -1) {
          this.unpinSlot(candidateSlot);
        }
        throw err;
      }
    })();

    this.inFlightAcquires.set(pageId, acquirePromise);

    try {
      const slot = await acquirePromise;
      // If the caller did not request pinning, decrement the acquisition pin
      if (!pin) {
        this.unpinSlot(slot);
      }
      return slot;
    } finally {
      this.inFlightAcquires.delete(pageId);
    }
  }

  /**
   * Helper that atomically acquires a page into cache and pins its slot.
   * Caller is responsible for calling `unpinSlot(slot)` or `unpinPage(pageId)`
   * when finished with the page.
   */
  async acquireAndPinPage(pageId: number): Promise<number> {
    return this.acquirePage(pageId, true);
  }

  /**
   * Finds an unpinned candidate slot via Clock (Second-Chance) algorithm, flushing if dirty.
   */
  private async findEvictionCandidateSlot(): Promise<number> {
    const totalSlots = this.slotCount;
    let candidate = -1;

    // First scan for unallocated, unpinned slots (page_id == 0)
    for (let i = 1; i < totalSlots; i++) {
      if (this.getSlotToPage(i) === 0 && !this.isSlotPinned(i)) {
        return i;
      }
    }

    // Clock (Second-Chance) eviction loop
    for (let step = 0; step < totalSlots * 2; step++) {
      this.clockHand = (this.clockHand + 1) % totalSlots;

      if (this.clockHand === 0) continue; // Skip Page 1

      if (this.isSlotPinned(this.clockHand)) {
        continue;
      }

      // Defense-in-depth: Never evict system/catalog pages (0x0C)
      const slotView = this.getSlotDataView(this.clockHand);

      if (getPageType(slotView, 0) === PAGE_TYPE_CATALOG_PAGE) {
        continue;
      }

      if (this.refBits[this.clockHand] === 1) {
        // Second chance: clear reference bit and keep rotating
        this.refBits[this.clockHand] = 0;
      } else {
        // Reference bit is 0: evict this slot
        candidate = this.clockHand;
        break;
      }
    }

    if (candidate === -1) {
      throw new Error("Cache deadlock: all slots are pinned");
    }

    // Pin candidate slot during eviction & flush to lock out concurrent access/eviction
    this.pinSlot(candidate);

    try {
      const oldPageId = this.getSlotToPage(candidate);
      const slotView = this.getSlotDataView(candidate);
      const isFreePage =
        oldPageId > 0 && getPageType(slotView, 0) === PAGE_TYPE_FREE;

      // Unmap from pageToSlot immediately so concurrent acquirePage(oldPageId)
      // will not obtain this slot while it is being flushed and cleared
      if (oldPageId > 0) {
        pageTableDelete(
          this.view,
          this.pageToSlotOffset,
          this.pageToSlotBuckets,
          oldPageId,
        );
      }

      // Never flush a free page during eviction:
      // If the page was already freed (added to free list), flushing it writes a stale free-page
      // image to VFS, which can overwrite newly recycled content from a concurrent allocatePage!
      if (this.isDirty(candidate) && !isFreePage) {
        await this.flushSlot(candidate);
      }

      this.clearDirty(candidate);

      if (oldPageId > 0) {
        this.setSlotToPage(candidate, 0);
      }
    } finally {
      this.unpinSlot(candidate);
    }

    return candidate;
  }

  /**
   * Computes CRC32 checksum and durably writes a slot to VFS.
   */
  async flushSlot(slotIdx: number): Promise<void> {
    this.validateSlotIndex(slotIdx);
    const pageId = this.getSlotToPage(slotIdx);
    if (pageId === 0) return;

    // Await any existing in-flight flush for this page to prevent concurrent write collisions
    const existingFlush = this.inFlightFlushes.get(pageId);
    if (existingFlush) {
      await existingFlush;
      if (!this.isDirty(slotIdx)) return;
    }

    if (slotIdx === 0 && pageId !== 1) {
      throw new Error(
        `Corruption detected: slot 0 is assigned to page ${pageId} instead of page 1`,
      );
    }

    const slotOffset = slotIdx * PAGE_SIZE;
    const pageBytes = this.getBytes(slotOffset, PAGE_SIZE);

    if (pageId === 1) {
      const chk = computePage1Checksum(pageBytes);
      this.writeUint32(slotOffset + HEADER_OFFSET_PAGE_CHECKSUM, chk);
    } else {
      const chk = computePageChecksum(pageBytes);
      this.writeUint32(slotOffset + PAGE_HEADER_OFFSET_CHECKSUM, chk);
    }

    const generationAtFlush = this.slotDirtyGenerations[slotIdx];
    // Copy snapshot to guarantee zero torn writes during async storage I/O
    const writeSnapshot = pageBytes.slice();
    const writePromise = this.vfs.writePage(pageId, writeSnapshot);
    this.inFlightFlushes.set(pageId, writePromise);
    try {
      await writePromise;
      // Only clear dirty bit if no new mutations occurred during the flush
      if (this.slotDirtyGenerations[slotIdx] === generationAtFlush) {
        this.clearDirty(slotIdx);
      }
    } finally {
      this.inFlightFlushes.delete(pageId);
    }
  }

  /**
   * Flushes all dirty slots to VFS.
   */
  async flushAllDirty(): Promise<void> {
    for (let i = 0; i < this.slotCount; i++) {
      if (this.isDirty(i)) {
        await this.flushSlot(i);
      }
    }
    await this.vfs.flush();
  }

  // ==========================================================================
  // Free Page Recycling (LIFO Free List)
  // ==========================================================================

  /**
   * Allocates a page: pops from Page1.free_page_head if available,
   * or increments total_pages.
   *
   * @param pin Optional boolean (default false). When true, atomically pins the
   *            allocated page's slot to prevent eviction before the caller can populate it.
   * @returns The allocated 1-based pageId
   */
  async allocatePage(pin: boolean = false): Promise<number> {
    return this.withAllocationLock(async () => {
      const page1View = this.getSlotDataView(0);
      const freeHead = page1View.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
      const currentTotal = page1View.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);

      if (freeHead > 0) {
        if (freeHead <= 1 || (currentTotal > 0 && freeHead > currentTotal)) {
          throw new CorruptPageError(
            freeHead,
            `Corrupted free_page_head pointer ${freeHead} (totalPages: ${currentTotal})`,
          );
        }

        // Await any in-flight flush on freeHead before acquiring and recycling
        const inFlight = this.inFlightFlushes.get(freeHead);
        if (inFlight) {
          await inFlight;
        }

        // Pop free page from head
        const slot = await this.acquirePage(freeHead, pin);
        const freePageView = this.getSlotDataView(slot);

        // Verify it's a free page
        const pageType = freePageView.getUint8(PAGE_HEADER_OFFSET_TYPE);
        if (pageType !== PAGE_TYPE_FREE) {
          throw new CorruptPageError(
            freeHead,
            `Expected free page type 0x00, got 0x${pageType.toString(16)}`,
          );
        }

        const nextFreeId = freePageView.getUint32(
          PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
          true,
        );
        if (
          nextFreeId === freeHead ||
          (currentTotal > 0 && nextFreeId > currentTotal)
        ) {
          throw new CorruptPageError(
            freeHead,
            `Corrupted next_free_page_id pointer ${nextFreeId} in free page ${freeHead}`,
          );
        }

        page1View.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, nextFreeId, true);
        this.markDirty(0);

        // Reset allocated page to leaf data page (0x0D)
        initPage(freePageView, 0);
        this.markDirty(slot);

        return freeHead;
      }

      // Allocate by incrementing total_pages
      const newPageId = currentTotal + 1;
      page1View.setUint32(HEADER_OFFSET_TOTAL_PAGES, newPageId, true);
      this.markDirty(0);

      const slot = await this.acquirePage(newPageId, pin);
      const newPageView = this.getSlotDataView(slot);
      initPage(newPageView, 0);
      this.markDirty(slot);

      return newPageId;
    });
  }

  /**
   * Helper that atomically allocates a page and pins its backing slot.
   * Caller is responsible for unpinning when done with the allocated page.
   */
  async allocateAndPinPage(): Promise<number> {
    return this.allocatePage(true);
  }

  /**
   * Frees a page: formats as FreePage (0x00) and pushes to Page1.free_page_head.
   */
  async freePage(pageId: number): Promise<void> {
    this.validatePageId(pageId);

    if (pageId <= 1) {
      throw new Error(`Cannot free reserved database page ${pageId}`);
    }

    return this.withAllocationLock(async () => {
      const page1View = this.getSlotDataView(0);
      const currentTotal = page1View.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
      if (currentTotal > 0 && pageId > currentTotal) {
        throw new Error(
          `Cannot free page ${pageId} beyond total pages ${currentTotal}`,
        );
      }

      // 1. Check if the page is currently active/pinned in cache before acquiring
      const existingSlot = this.getResidentSlot(pageId);
      if (existingSlot !== -1 && this.isSlotPinned(existingSlot)) {
        throw new Error(`Cannot free pinned/active database page ${pageId}`);
      }

      // 2. Acquire and pin the slot during formatting to prevent concurrent eviction
      const slot = await this.acquirePage(pageId, true);
      try {
        const view = this.getSlotDataView(slot);
        const pageType = getPageType(view, 0);
        if (pageType === PAGE_TYPE_FREE) {
          this.setSlotToPage(slot, 0);
          throw new Error(
            `Double-free detected: page ${pageId} is already marked free`,
          );
        }
        if (pageType === PAGE_TYPE_CATALOG_PAGE) {
          throw new Error(`Cannot free system catalog page ${pageId}`);
        }

        const oldHead = page1View.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);

        // Format as FreePage (§4.7.5) with next_free_page_id = oldHead
        initFreePage(view, 0, oldHead);

        // Discard payload to prevent sensitive data leakage
        this.fillBytes(
          slot * PAGE_SIZE + PAGE_HEADER_SIZE,
          PAGE_SIZE - PAGE_HEADER_SIZE,
          0,
        );

        // Durably flush free page immediately so on-disk representation is updated
        // and the slot becomes clean (isDirty = false)
        await this.flushSlot(slot);

        // Immediately unmap the freed page from the buffer pool so it is no longer resident
        // in cache and cannot be evicted as a stale dirty page
        this.setSlotToPage(slot, 0);
        this.clearDirty(slot);
        this.refBits[slot] = 0;

        // Update Page 1 head pointer ONLY AFTER the free page is durably flushed and unmapped
        page1View.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, pageId, true);
        this.markDirty(0);
      } finally {
        // 3. Always unpin the freed page: a free page must not remain pinned in the buffer pool
        this.unpinSlot(slot);
      }
    });
  }

  // ==========================================================================
  // Transient Query Arena
  // ==========================================================================

  getArenaOffset(): number {
    return this.arenaOffset;
  }

  allocateInArena(size: number): number {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(
        `Invalid arena allocation size: ${size}. Size must be a positive integer.`,
      );
    }

    // 8-byte alignment for 64-bit alignment invariant
    const alignedSize = (size + 7) & ~7;
    if (this.arenaOffset + alignedSize > this.maxQueryMemory) {
      throw new QueryArenaExhaustedError();
    }

    const requiredBytes =
      this.transientArenaOffset + this.arenaOffset + alignedSize;
    if (requiredBytes > this.buffer.byteLength) {
      const neededBytes = requiredBytes - this.buffer.byteLength;
      const pagesToGrow = Math.ceil(neededBytes / 65536);
      this.wasmMemory.grow(pagesToGrow);
      this.buffer = this.wasmMemory.buffer;
      this.view = new DataView(this.buffer);
      this.uint8 = new Uint8Array(this.buffer);
    }

    const current = this.transientArenaOffset + this.arenaOffset;
    this.arenaOffset += alignedSize;
    return current;
  }

  resetArena(): void {
    if (this.arenaOffset > 0) {
      // Zero out the used portion of the arena to prevent data leakage between queries
      this.fillBytes(this.transientArenaOffset, this.arenaOffset, 0);
      this.arenaOffset = 0;
    }
  }
}
