import { describe, it, expect } from 'vitest';
import { BufferPool } from '../src/engine/buffer_pool.js';
import { MemoryVfsAdapter } from '../src/storage/memory.js';
import { initPage } from '../src/engine/page.js';
import { PAGE_TYPE_CATALOG_PAGE } from '../src/constants.js';

describe('Test Suite 3: Buffer Pinning & LRU Eviction Simulation (tests/cache_pinning.test.ts)', () => {
  it('1. Pinning Immunity: Pinned slots are never evicted under heavy eviction load', async () => {
    const vfs = new MemoryVfsAdapter();
    // Create a small cache of 32 slots for quick saturation and eviction testing
    const pool = new BufferPool({ vfs, slotCount: 32 });

    // Fill all 32 slots with pages 1..32
    for (let p = 1; p <= 32; p++) {
      await pool.acquirePage(p);
    }

    // Pin slots 0 (Page 1), 5, and 12
    pool.pinSlot(0);
    pool.pinSlot(5);
    pool.pinSlot(12);

    const pinnedPageAt5 = pool.getSlotToPage(5);
    const pinnedPageAt12 = pool.getSlotToPage(12);

    // Simulate 500 page-fault evictions with new pages 33..532
    for (let p = 33; p <= 532; p++) {
      await pool.acquirePage(p);
    }

    // Assert that pinned slots were NEVER evicted
    expect(pool.getSlotToPage(0)).toBe(1);
    expect(pool.getSlotToPage(5)).toBe(pinnedPageAt5);
    expect(pool.getSlotToPage(12)).toBe(pinnedPageAt12);

    expect(pool.isSlotPinned(0)).toBe(true);
    expect(pool.isSlotPinned(5)).toBe(true);
    expect(pool.isSlotPinned(12)).toBe(true);
  });

  it('2. Dirty Mask Synchronization: Sets bit on modification and clears bit on flush', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 64 });

    const slot = 19;
    expect(pool.isDirty(slot)).toBe(false);

    // Mutate slot -> mark dirty
    pool.markDirty(slot);
    expect(pool.isDirty(slot)).toBe(true);

    // Verify raw bitmask byte
    const byteIdx = pool.dirtyMaskOffset + (slot >> 3);
    const bitMask = 1 << (slot & 7);
    expect((pool.uint8[byteIdx] & bitMask) !== 0).toBe(true);

    // Clear dirty
    pool.clearDirty(slot);
    expect(pool.isDirty(slot)).toBe(false);
    expect((pool.uint8[byteIdx] & bitMask) !== 0).toBe(false);

    // Test flush clearing
    pool.setSlotToPage(slot, 100);
    pool.markDirty(slot);
    expect(pool.isDirty(slot)).toBe(true);

    await pool.flushSlot(slot);
    expect(pool.isDirty(slot)).toBe(false);
  });

  it('3. Clock (Second-Chance) Eviction: Recently accessed pages survive sweep via ref_bit second chance', async () => {
    const vfs = new MemoryVfsAdapter();
    // Cache with 4 slots: slot 0 (Page 1), slots 1..3 for pages 2, 3, 4
    const pool = new BufferPool({ vfs, slotCount: 4 });

    // Acquire pages 1..4 (filling all 4 slots)
    for (let p = 1; p <= 4; p++) {
      await pool.acquirePage(p);
    }

    // Page 1 is in slot 0
    // Pages 2, 3, 4 are in slots 1, 2, 3
    const slot2 = pool.getResidentSlot(2);
    const slot3 = pool.getResidentSlot(3);
    const slot4 = pool.getResidentSlot(4);

    expect(slot2).toBe(1);
    expect(slot3).toBe(2);
    expect(slot4).toBe(3);

    // Re-access Page 2 (sets refBit = 1)
    await pool.acquirePage(2);
    // Explicitly simulate slot 3 (Page 4) being cold (refBit = 0)
    // while slot 1 (Page 2) is hot (refBit = 1)
    pool.setRefBit(slot2, 1);
    pool.setRefBit(slot3, 0); // Cold page (Page 3)
    pool.setRefBit(slot4, 1);

    // Now acquire Page 5 (causes eviction)
    const slot5 = await pool.acquirePage(5);

    // The cold slot (slot 3 holding Page 3) must be the one evicted!
    expect(slot5).toBe(slot3);
    expect(pool.getResidentSlot(3)).toBe(-1); // Page 3 was evicted
    expect(pool.getResidentSlot(2)).toBe(slot2); // Page 2 was preserved by second-chance!
  });

  it('4. Boundary & Security Guards: Validates slot indices and page IDs against corruption', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    // Invalid slot index
    expect(() => pool.getSlotToPage(-1)).toThrow(/Invalid slot index/);
    expect(() => pool.getSlotToPage(8)).toThrow(/Invalid slot index/);
    expect(() => pool.markDirty(10)).toThrow(/Invalid slot index/);
    expect(() => pool.pinSlot(-1)).toThrow(/Invalid slot index/);
    expect(() => pool.getSlotDataView(8)).toThrow(/Invalid slot index/);

    // Invalid page IDs
    expect(() => pool.getResidentSlot(0)).toThrow(/Invalid page ID/);
    expect(() => pool.getResidentSlot(-5)).toThrow(/Invalid page ID/);
    await expect(pool.acquirePage(0)).rejects.toThrow(/Invalid page ID/);
    await expect(pool.acquirePage(-1)).rejects.toThrow(/Invalid page ID/);

    // Slot 0 reassign protection
    expect(() => pool.setSlotToPage(0, 2)).toThrow(/Cannot reassign slot 0/);

    // Pinning non-resident page throws
    expect(() => pool.pinPage(99)).toThrow(/not resident/);
  });

  it('5. Reference-Counted Pinning: Multiple pins require matching unpins', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    await pool.acquirePage(2);
    const slot = pool.getResidentSlot(2);

    expect(pool.isSlotPinned(slot)).toBe(false);
    expect(pool.getPinCount(slot)).toBe(0);

    // Double pin
    pool.pinSlot(slot);
    pool.pinSlot(slot);
    expect(pool.getPinCount(slot)).toBe(2);
    expect(pool.isSlotPinned(slot)).toBe(true);

    // Single unpin -> still pinned!
    pool.unpinSlot(slot);
    expect(pool.getPinCount(slot)).toBe(1);
    expect(pool.isSlotPinned(slot)).toBe(true);

    // Second unpin -> unpinned
    pool.unpinSlot(slot);
    expect(pool.getPinCount(slot)).toBe(0);
    expect(pool.isSlotPinned(slot)).toBe(false);

    // Extra unpin does not underflow
    pool.unpinSlot(slot);
    expect(pool.getPinCount(slot)).toBe(0);
  });

  it('6. FreePage Safety: Prevents reserved page freeing, double-freeing, and pinned page corruption', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    // Initialize Page 1 total_pages = 5
    const p1View = pool.getSlotDataView(0);
    p1View.setUint32(12, 5, true); // total_pages = 5

    // Acquire page 3 and initialize as an active data page
    const slot3 = await pool.acquirePage(3);
    initPage(pool.getSlotDataView(slot3), 0);

    // 1. Cannot free Page 1 or 0
    await expect(pool.freePage(1)).rejects.toThrow(/Cannot free reserved database page/);

    // 2. Cannot free page beyond totalPages (e.g. 10 > 5)
    await expect(pool.freePage(10)).rejects.toThrow(/beyond total pages/);

    // 3. Cannot free pinned page
    pool.pinPage(3);
    await expect(pool.freePage(3)).rejects.toThrow(/Cannot free pinned\/active/);

    // Unpin and free successfully
    pool.unpinPage(3);
    await pool.freePage(3);

    // Assert the freed page is not left pinned in the buffer pool
    expect(pool.isSlotPinned(slot3)).toBe(false);
    expect(pool.getPinCount(slot3)).toBe(0);

    // 4. Double-free guard
    await expect(pool.freePage(3)).rejects.toThrow(/Double-free detected/);
  });

  it('7. Query Arena Safety: 8-byte alignment, expansion, and zero-wiping on reset', () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8, maxQueryMemory: 1024 * 1024 });

    expect(pool.getArenaOffset()).toBe(0);

    // Allocate 13 bytes -> aligned to 16 bytes
    const ptr1 = pool.allocateInArena(13);
    expect(ptr1 % 8).toBe(0);
    expect(pool.getArenaOffset()).toBe(16);

    // Write data to arena
    const view = new DataView(pool.buffer);
    view.setUint32(ptr1, 0x12345678, true);
    expect(view.getUint32(ptr1, true)).toBe(0x12345678);

    // Reset arena zeroes used memory to prevent cross-query leakage
    pool.resetArena();
    expect(pool.getArenaOffset()).toBe(0);
    expect(view.getUint32(ptr1, true)).toBe(0);

    // Invalid allocation sizes
    expect(() => pool.allocateInArena(0)).toThrow(/Invalid arena allocation size/);
    expect(() => pool.allocateInArena(-10)).toThrow(/Invalid arena allocation size/);
  });

  it('8. System Catalog Immunity: Unpinned PAGE_TYPE_CATALOG_PAGE (0x0C) is never evicted', async () => {
    const vfs = new MemoryVfsAdapter();
    // Cache with 4 slots: slot 0 (Page 1), slots 1..3 for pages 2, 3, 4
    const pool = new BufferPool({ vfs, slotCount: 4 });

    await pool.acquirePage(1);
    await pool.acquirePage(2);
    await pool.acquirePage(3);
    await pool.acquirePage(4);

    const slot2 = pool.getResidentSlot(2);
    const slot3 = pool.getResidentSlot(3);
    const slot4 = pool.getResidentSlot(4);

    // Format page 2 as a dedicated column catalog page (0x0C)
    const view2 = pool.getSlotDataView(slot2);
    view2.setUint8(0, PAGE_TYPE_CATALOG_PAGE);

    // Both slot2 (catalog page 2) and slot3 (data page 3) have refBit = 0 and are NOT pinned
    pool.setRefBit(slot2, 0);
    pool.setRefBit(slot3, 0);
    pool.setRefBit(slot4, 1);

    // Acquiring page 5 triggers eviction
    // Despite being unpinned and having refBit = 0, catalog page 2 MUST NOT be evicted!
    const slot5 = await pool.acquirePage(5);

    // slot3 (holding data page 3) should be evicted instead
    expect(slot5).toBe(slot3);
    expect(pool.getResidentSlot(2)).toBe(slot2); // Catalog page was preserved!
    expect(pool.getResidentSlot(3)).toBe(-1);     // Data page was evicted
  });

  it('9. Pin Count Overflow Guard: Throws on 32-bit pin counter overflow', () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 4 });

    // Simulate pin count at 0xFFFFFFFF
    (pool as any).pinCounts[1] = 0xFFFFFFFF;
    expect(() => pool.pinSlot(1)).toThrow(/Pin count overflow on slot 1/);
  });

  it('10. Atomic Pin on Acquire: acquireAndPinPage prevents use-after-evict race conditions', async () => {
    const vfs = new MemoryVfsAdapter();
    // Cache with only 2 slots: slot 0 (Page 1) and slot 1 for data
    const pool = new BufferPool({ vfs, slotCount: 2 });

    // Acquire and atomically pin Page 2 in slot 1
    const slotA = await pool.acquireAndPinPage(2);
    expect(slotA).toBe(1);
    expect(pool.getPinCount(slotA)).toBe(1);
    expect(pool.isSlotPinned(slotA)).toBe(true);

    // Attempting to acquire Page 3 when all slots are pinned must deadlock safely
    // rather than silently evicting Page 2 from under slotA!
    await expect(pool.acquirePage(3)).rejects.toThrow(/all slots are pinned/);

    // Once unpinned, Page 3 can be acquired
    pool.unpinSlot(slotA);
    const slotB = await pool.acquirePage(3);
    expect(slotB).toBe(1);
  });

  it('11. Atomic Pin on Allocate: allocateAndPinPage protects newly allocated slots from eviction', async () => {
    const vfs = new MemoryVfsAdapter();
    // Cache with only 2 slots: slot 0 (Page 1) and slot 1 for data
    const pool = new BufferPool({ vfs, slotCount: 2 });
    pool.getSlotDataView(0).setUint32(12, 1, true); // total_pages = 1

    // Allocate and atomically pin page 2 in slot 1
    const newPageId = await pool.allocateAndPinPage();
    expect(newPageId).toBe(2);
    const slot = pool.getResidentSlot(newPageId);
    expect(slot).toBe(1);
    expect(pool.isSlotPinned(slot)).toBe(true);
    expect(pool.getPinCount(slot)).toBe(1);

    // With 2 slots, both slot 0 (Page 1) and slot 1 (Page 2) are pinned:
    // Any subsequent acquire must deadlock rather than evict the newly allocated page!
    await expect(pool.acquirePage(99)).rejects.toThrow(/all slots are pinned/);

    // Unpinning allows eviction/acquisition
    pool.unpinSlot(slot);
    expect(pool.isSlotPinned(slot)).toBe(false);
  });

  it('12. Clean FreePage Eviction: Freed page is immediately flushed clean, preventing stale writes on eviction', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 4 });
    pool.getSlotDataView(0).setUint32(12, 3, true); // total_pages = 3

    // Acquire and initialize page 2
    const slot2 = await pool.acquirePage(2);
    initPage(pool.getSlotDataView(slot2), 0);

    // Free page 2: must be flushed immediately so the slot becomes clean (isDirty = false)
    await pool.freePage(2);
    expect(pool.isDirty(slot2)).toBe(false);

    // Spy on vfs.writePage to verify that evicting slot 2 does NOT trigger a second writePage for page 2!
    let writeCountForPage2 = 0;
    const originalWritePage = vfs.writePage.bind(vfs);
    vfs.writePage = async (pageId: number, data: Uint8Array) => {
      if (pageId === 2) writeCountForPage2++;
      return originalWritePage(pageId, data);
    };

    // Fill the cache to evict slot 2 with page 4 and page 5
    await pool.acquirePage(3);
    await pool.acquirePage(4);
    await pool.acquirePage(5);

    // Page 2 was clean, so evicting it caused 0 additional writes to page 2!
    expect(writeCountForPage2).toBe(0);
  });

  it('13. Stale FreePage Eviction Guard: Eviction never flushes free-page header over recycled page', async () => {
    const vfs = new MemoryVfsAdapter();
    // Cache with 3 slots: slot 0 (Page 1), slots 1..2
    const pool = new BufferPool({ vfs, slotCount: 3 });
    pool.getSlotDataView(0).setUint32(12, 2, true); // total_pages = 2

    // 1. Acquire page 2 and write active table data
    const slot2 = await pool.acquirePage(2);
    initPage(pool.getSlotDataView(slot2), 0);

    // 2. Free page 2 -> flushed to VFS and unmapped from pool immediately
    await pool.freePage(2);
    expect(pool.getResidentSlot(2)).toBe(-1);

    // 3. Re-acquire page 2 into slot 1, format as PAGE_TYPE_FREE, and simulate dirty state
    const slotA = await pool.acquirePage(2);
    pool.markDirty(slotA);
    pool.setRefBit(slotA, 0);

    // Track any VFS writes to page 2
    let writeCountForPage2 = 0;
    const originalWritePage = vfs.writePage.bind(vfs);
    vfs.writePage = async (pageId: number, data: Uint8Array) => {
      if (pageId === 2) writeCountForPage2++;
      return originalWritePage(pageId, data);
    };

    // 4. Force eviction by acquiring new pages (e.g. 3 and 4)
    // Eviction will select slotA containing page 2.
    // Invariant: Eviction MUST NOT flush PAGE_TYPE_FREE even if dirty!
    await pool.acquirePage(3);
    await pool.acquirePage(4);

    expect(writeCountForPage2).toBe(0);

    // 5. Allocate recycled page 2 -> initializes as active data page (0x0D)
    const recycledId = await pool.allocatePage();
    expect(recycledId).toBe(2);

    // Verify page 2 is resident and initialized as 0x0D, not free
    const recycledSlot = pool.getResidentSlot(2);
    expect(recycledSlot).toBeGreaterThan(0);
    const recycledView = pool.getSlotDataView(recycledSlot);
    expect(recycledView.getUint8(0)).toBe(0x0D);
  });

  it('14. Concurrent Acquire Coalescing: Concurrent acquirePage calls for same pageId coalesce without duplicate reads', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    let readCount = 0;
    const origReadPage = vfs.readPage.bind(vfs);
    vfs.readPage = async (pageId: number) => {
      if (pageId === 5) {
        readCount++;
        // Introduce small async delay to test concurrency window
        await new Promise((r) => setTimeout(r, 10));
      }
      return origReadPage(pageId);
    };

    // Trigger 5 concurrent acquires for page 5
    const [s1, s2, s3, s4, s5] = await Promise.all([
      pool.acquirePage(5),
      pool.acquirePage(5),
      pool.acquirePage(5),
      pool.acquirePage(5),
      pool.acquirePage(5),
    ]);

    expect(readCount).toBe(1);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    expect(s3).toBe(s4);
    expect(s4).toBe(s5);
  });

  it('15. Concurrent Eviction Safety: In-flight candidate slot is pinned during VFS read so concurrent eviction cannot steal it', async () => {
    const vfs = new MemoryVfsAdapter();
    // Cache with only 2 slots: slot 0 (Page 1) and slot 1 for data
    const pool = new BufferPool({ vfs, slotCount: 2 });

    // Page 2 in slot 1
    await pool.acquirePage(2);
    expect(pool.getResidentSlot(2)).toBe(1);

    // Slow down reading page 3
    let releaseRead3: () => void;
    const read3Promise = new Promise<void>((r) => {
      releaseRead3 = r;
    });

    const origReadPage = vfs.readPage.bind(vfs);
    vfs.readPage = async (pageId: number) => {
      if (pageId === 3) {
        await read3Promise;
      }
      return origReadPage(pageId);
    };

    // Task A starts acquiring page 3 (evicts page 2, selects slot 1, begins read)
    const taskA = pool.acquirePage(3);

    // Yield to event loop to let Task A reach the async vfs.readPage pause
    await new Promise((r) => setTimeout(r, 5));

    // While Task A is awaiting page 3, Task B attempts to acquire page 4.
    // Because slot 1 is pinned by Task A during in-flight read, Task B must fail with deadlock
    // rather than stealing slot 1 from Task A!
    await expect(pool.acquirePage(4)).rejects.toThrow(/all slots are pinned/);

    // Release Task A's read
    releaseRead3!();
    const slotA = await taskA;
    expect(slotA).toBe(1);
    expect(pool.getSlotToPage(1)).toBe(3);
  });

  it('16. Concurrent Allocate Serialization: Concurrent allocatePage calls never return duplicate page IDs', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 16 });
    pool.getSlotDataView(0).setUint32(12, 1, true); // total_pages = 1

    // Concurrent allocations by incrementing total_pages
    const pageIds = await Promise.all([
      pool.allocatePage(),
      pool.allocatePage(),
      pool.allocatePage(),
      pool.allocatePage(),
    ]);

    const uniqueIds = new Set(pageIds);
    expect(uniqueIds.size).toBe(4);
    expect(pageIds).toEqual([2, 3, 4, 5]);

    // Now free pages 2, 3, 4
    await pool.freePage(2);
    await pool.freePage(3);
    await pool.freePage(4);

    // Concurrent allocations popping from free list
    const recycledIds = await Promise.all([
      pool.allocatePage(),
      pool.allocatePage(),
      pool.allocatePage(),
    ]);

    const uniqueRecycled = new Set(recycledIds);
    expect(uniqueRecycled.size).toBe(3);
    // All recycled pages must be from the freed set {2, 3, 4}
    for (const id of recycledIds) {
      expect([2, 3, 4]).toContain(id);
    }
  });

  it('17. Concurrent Free Serialization: Concurrent freePage calls properly maintain free list integrity', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 16 });
    pool.getSlotDataView(0).setUint32(12, 10, true); // total_pages = 10

    // Initialize pages 2, 3, 4 as active data pages
    for (let p = 2; p <= 4; p++) {
      const s = await pool.acquirePage(p);
      initPage(pool.getSlotDataView(s), 0);
    }

    // Concurrently free pages 2, 3, 4
    await Promise.all([
      pool.freePage(2),
      pool.freePage(3),
      pool.freePage(4),
    ]);

    // Sequentially allocate 3 pages to verify the entire chain was preserved
    const p1 = await pool.allocatePage();
    const p2 = await pool.allocatePage();
    const p3 = await pool.allocatePage();

    const freedSet = new Set([p1, p2, p3]);
    expect(freedSet.size).toBe(3);
    expect(freedSet.has(2)).toBe(true);
    expect(freedSet.has(3)).toBe(true);
    expect(freedSet.has(4)).toBe(true);
  });

  it('18. System Catalog Page Protection: freePage rejects catalog pages and Page 1', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });
    pool.getSlotDataView(0).setUint32(12, 5, true); // total_pages = 5

    // 1. Cannot free Page 1
    await expect(pool.freePage(1)).rejects.toThrow(/Cannot free reserved database page/);

    // 2. Format Page 3 as a catalog page (0x0C)
    const slot3 = await pool.acquirePage(3);
    const view3 = pool.getSlotDataView(slot3);
    view3.setUint8(0, PAGE_TYPE_CATALOG_PAGE);
    pool.markDirty(slot3);

    // Attempting to free catalog page must throw
    await expect(pool.freePage(3)).rejects.toThrow(/Cannot free system catalog page/);
  });

  it('19. Concurrent Mutation During Flush: Preserves dirty bit if page is modified during async write', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    const slot2 = await pool.acquirePage(2);
    pool.markDirty(slot2);
    expect(pool.isDirty(slot2)).toBe(true);

    let releaseWrite: () => void;
    const writeGate = new Promise<void>((r) => {
      releaseWrite = r;
    });

    const origWritePage = vfs.writePage.bind(vfs);
    vfs.writePage = async (pageId: number, data: Uint8Array) => {
      if (pageId === 2) {
        await writeGate;
      }
      return origWritePage(pageId, data);
    };

    // Start flushSlot(slot2)
    const flushPromise = pool.flushSlot(slot2);

    // Yield to ensure writePage is paused at writeGate
    await new Promise((r) => setTimeout(r, 5));

    // Mutate slot2 while the write is in flight!
    pool.markDirty(slot2);

    // Release write
    releaseWrite!();
    await flushPromise;

    // Invariant: Because a mutation occurred during the flush, the dirty bit must NOT be cleared!
    expect(pool.isDirty(slot2)).toBe(true);
  });

  it('20. Snapshot Isolation on Flush: In-flight buffer mutations do not mutate data sent to storage', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    const slot2 = await pool.acquirePage(2);
    const bytes = pool.getPageBytesInSlot(slot2);
    bytes.fill(0xAA);
    pool.markDirty(slot2);

    let capturedData: Uint8Array | null = null;
    let releaseWrite: () => void;
    const writeGate = new Promise<void>((r) => {
      releaseWrite = r;
    });

    const origWritePage = vfs.writePage.bind(vfs);
    vfs.writePage = async (pageId: number, data: Uint8Array) => {
      if (pageId === 2) {
        capturedData = data;
        await writeGate;
      }
      return origWritePage(pageId, data);
    };

    const flushPromise = pool.flushSlot(slot2);
    await new Promise((r) => setTimeout(r, 5));

    // Mutate the live buffer to 0xFF while storage is writing
    bytes.fill(0xFF);

    releaseWrite!();
    await flushPromise;

    // The data received by vfs.writePage must remain 0xAA snapshot (except checksum header)
    expect(capturedData![100]).toBe(0xAA);
  });

  it('21. Duplicate Slot Mapping Protection: setSlotToPage rejects duplicate resident mappings', () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    // Map slot 2 to page 5
    pool.setSlotToPage(2, 5);
    expect(pool.getResidentSlot(5)).toBe(2);

    // Attempting to map slot 3 to the same page 5 must throw
    expect(() => pool.setSlotToPage(3, 5)).toThrow(/already resident in slot 2/);
  });

  it('22. Page-to-Slot Binary Hash Table: verifies direct shared memory binary format and lookups', () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    // Page 1 is resident in slot 0 by default
    expect(pool.getResidentSlot(1)).toBe(0);

    // Map pages to slots
    pool.setSlotToPage(1, 10);
    pool.setSlotToPage(2, 20);
    pool.setSlotToPage(3, 30);

    expect(pool.getResidentSlot(10)).toBe(1);
    expect(pool.getResidentSlot(20)).toBe(2);
    expect(pool.getResidentSlot(30)).toBe(3);
    expect(pool.getResidentSlot(99)).toBe(-1);

    // Verify binary hash table in shared memory: find where page 10 is stored
    let foundEntry = false;
    for (let b = 0; b < pool.pageToSlotBuckets; b++) {
      const offset = pool.pageToSlotOffset + b * 8;
      const pageId = pool.view.getUint32(offset, true);
      const slotIdx = pool.view.getUint32(offset + 4, true);
      if (pageId === 10) {
        expect(slotIdx).toBe(1);
        foundEntry = true;
        break;
      }
    }
    expect(foundEntry).toBe(true);

    // Reassign slot 1 to page 40 -> page 10 deleted, page 40 inserted
    pool.setSlotToPage(1, 40);
    expect(pool.getResidentSlot(10)).toBe(-1);
    expect(pool.getResidentSlot(40)).toBe(1);
  });

  it('23. Hash Table Backward Shift Deletion: maintains probe chain integrity when deleting collided entries', () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 32 });

    // Insert 10 pages and record them
    for (let s = 1; s <= 10; s++) {
      pool.setSlotToPage(s, 100 + s);
      expect(pool.getResidentSlot(100 + s)).toBe(s);
    }

    // Delete every other slot (unmap to page 0)
    for (let s = 1; s <= 10; s += 2) {
      pool.setSlotToPage(s, 0);
      expect(pool.getResidentSlot(100 + s)).toBe(-1);
    }

    // Remaining slots must STILL be findable despite linear probing backward shifts
    for (let s = 2; s <= 10; s += 2) {
      expect(pool.getResidentSlot(100 + s)).toBe(s);
    }
  });

  it('24. Direct-Addressing Memory Primitives: verifies scalar and bulk memory accessors', () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 8 });

    const addr = pool.pageScratchpadOffset;

    // Scalar reads & writes (little-endian)
    pool.writeUint8(addr + 0, 0x42);
    expect(pool.readUint8(addr + 0)).toBe(0x42);

    pool.writeUint16(addr + 2, 0x1234);
    expect(pool.readUint16(addr + 2)).toBe(0x1234);

    pool.writeUint32(addr + 4, 0x89abcdef);
    expect(pool.readUint32(addr + 4)).toBe(0x89abcdef);

    pool.writeInt32(addr + 8, -424242);
    expect(pool.readInt32(addr + 8)).toBe(-424242);

    pool.writeFloat64(addr + 16, 3.141592653589793);
    expect(pool.readFloat64(addr + 16)).toBe(3.141592653589793);

    // Bulk byte operations (fill, set, get)
    pool.fillBytes(addr, 32, 0xaa);
    expect(pool.readUint8(addr)).toBe(0xaa);
    expect(pool.readUint8(addr + 31)).toBe(0xaa);

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    pool.setBytes(addr, payload);
    const slice = pool.getBytes(addr, 5);
    expect(Array.from(slice)).toEqual([1, 2, 3, 4, 5]);
  });
});



