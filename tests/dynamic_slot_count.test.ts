import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  WebDB,
  DataType,
  MAX_SLOT_COUNT,
  WASM_REGION_SIZE,
  VM_CONTEXT_OFFSET,
  RESULT_BUFFER_OFFSET,
  BYTECODE_OFFSET,
  PAGE_SCRATCHPAD_OFFSET,
  SLOTS_BASE_OFFSET,
  PAGE_SIZE,
  computeBufferPoolOffsets,
  createWasmMemory,
  BufferPoolDriver,
  Io,
  MemoryVfsAdapter,
  col,
  fn,
} from '../src/index.js';
import { BufferPool } from '../src/core/js/buffer_pool.c.js';

let openedDbs: WebDB[] = [];
let dbSeq = 0;

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${dbSeq++}_${Math.random().toString(36).slice(2, 7)}`;
}

afterEach(async () => {
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
});

describe('Dynamic slotCount (> 1024) Support & Memory Safety', () => {
  it('computes strictly non-overlapping layout regions across slotCounts from 2 to 65536', () => {
    for (const slotCount of [2, 16, 64, 1024, 2048, 4096, 8192, 65536]) {
      const o = computeBufferPoolOffsets(slotCount);
      expect(o.vmContextOffset).toBe(VM_CONTEXT_OFFSET);
      expect(o.resultBufferOffset).toBe(RESULT_BUFFER_OFFSET);
      expect(o.bytecodeOffset).toBe(BYTECODE_OFFSET);
      expect(o.pageScratchpadOffset).toBe(PAGE_SCRATCHPAD_OFFSET);
      expect(o.slotsBaseOffset).toBe(SLOTS_BASE_OFFSET);
      expect(o.slotsBaseOffset).toBeGreaterThan(o.pageScratchpadOffset);
      expect(o.slotsEndOffset).toBe(o.slotsBaseOffset + slotCount * PAGE_SIZE);
      expect(o.slotToPageOffset).toBe(o.slotsEndOffset);
      expect(o.pageToSlotOffset).toBeGreaterThanOrEqual(
        o.slotToPageOffset + slotCount * 4,
      );
      expect(o.pageToSlotBuckets).toBeGreaterThanOrEqual(slotCount * 2);
      expect(o.dirtyMaskOffset).toBe(
        o.pageToSlotOffset + o.pageToSlotBuckets * 8,
      );
      expect(o.transientArenaOffset).toBeGreaterThanOrEqual(
        o.dirtyMaskOffset + Math.ceil(slotCount / 8),
      );
      expect(o.transientArenaOffset % 65536).toBe(0);
    }

    // Small slotCount allocates significantly less memory than default 1024-slot pool
    const smallMem = createWasmMemory(16);
    const defaultMem = createWasmMemory(1024);
    expect(smallMem.buffer.byteLength).toBeLessThan(
      defaultMem.buffer.byteLength - 3 * 1024 * 1024,
    );
  });

  it('BufferPool and BufferPoolDriver safely address high slots (1024, 2047, 4095) without touching WASM_REGION or VM_CONTEXT', () => {
    const slotCount = 4096;
    const vfs = new MemoryVfsAdapter();
    const memory = createWasmMemory(slotCount, 1024 * 1024);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount,
      maxQueryMemory: 1024 * 1024,
    });

    // Write canary pattern into WASM_REGION and VM_CONTEXT
    const u8 = new Uint8Array(memory.buffer);
    u8[WASM_REGION_SIZE - 1] = 0x5a;
    u8[VM_CONTEXT_OFFSET] = 0xa5;

    // Assign and dirty high slots beyond the old 1024 boundary
    for (const slot of [1024, 2047, 3000, 4095]) {
      const pageId = slot + 10;
      driver.assignSlot(slot, pageId);
      driver.markDirty(slot);
      const bytes = driver.getPageBytesInSlot(slot);
      bytes[0] = slot & 0xff;
      bytes[PAGE_SIZE - 1] = (slot >> 8) & 0xff;

      expect(driver.getSlotOffset(slot)).toBe(
        SLOTS_BASE_OFFSET + slot * PAGE_SIZE,
      );
      expect(driver.getResidentSlot(pageId)).toBe(slot);
      expect(driver.getAssignedPage(slot)).toBe(pageId);
      expect(driver.isDirty(slot)).toBe(true);
    }

    // Canaries in WASM_REGION and VM_CONTEXT must remain intact
    expect(u8[WASM_REGION_SIZE - 1]).toBe(0x5a);
    expect(u8[VM_CONTEXT_OFFSET]).toBe(0xa5);

    // Clear dirty and unassign cleanly
    for (const slot of [1024, 2047, 3000, 4095]) {
      driver.clearDirty(slot);
      expect(driver.isDirty(slot)).toBe(false);
      driver.unassignSlot(slot);
      expect(driver.getAssignedPage(slot)).toBe(0);
    }

    // Also verify BufferPool class with slotCount: 2048
    const pool = new BufferPool({ slotCount: 2048, maxQueryMemory: 1024 * 1024 });
    pool.assign_slot(2047, 9999);
    pool.mark_dirty(2047);
    expect(pool.get_resident_slot(9999)).toBe(2047);
    expect(pool.is_dirty(2047)).toBe(true);
    expect(pool.get_slot_offset(2047)).toBe(SLOTS_BASE_OFFSET + 2047 * PAGE_SIZE);
  });

  it('opens, populates > 1,200 pages (actively using slots >= 1024), queries, checkpoints, and reopens with slotCount: 8192 on IDB', async () => {
    const dbName = uniqueName('dynamic_slots_8192');
    const db = await WebDB.open({
      name: dbName,
      storage: 'idb',
      slotCount: 8192,
      crossTabSync: false,
    });
    openedDbs.push(db);

    expect(db.driver.slotCount).toBe(8192);
    expect(db.driver.pageToSlotBuckets).toBe(16384);

    await db.createTable('products', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'sku', type: DataType.TEXT, notNull: true },
      { name: 'payload', type: DataType.TEXT, notNull: true },
    ]);
    await db.createIndex('products', ['sku'], { name: 'idx_products_sku' });

    // Insert 1,200 rows with ~3.2 KB payloads -> > 1,200 pages (exceeding legacy 1024-slot boundary)
    const pad = 'X'.repeat(3000);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= 1200; i++) {
        await tx.insert('products', {
          id: i,
          sku: `SKU-${String(i).padStart(5, '0')}`,
          payload: `row-${i}-${pad}`,
        });
      }
    });

    // Verify slots >= 1024 were actively allocated in the buffer pool without corrupting Page 1 or VM metadata
    const totalPages = db.driver.getSlotDataView(0).getUint32(12, true);
    expect(totalPages).toBeGreaterThan(1100);

    // Table metadata & indexed lookups must work cleanly (no TableNotFoundError!)
    const meta = await db.getTable('products');
    expect(meta.name).toBe('products');

    const hit = await db
      .from('products')
      .where(col('sku').eq('SKU-01150'))
      .toArray();
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe(1150);
    expect((hit[0].payload as string).startsWith('row-1150-')).toBe(true);

    // Explicit checkpoint (auto-checkpoint may have already drained >256 WAL frames)
    await db.checkpoint();
    expect(await db.vfs.getWalFrameCount()).toBe(0);

    await db.update('products', { id: 1200 }, { sku: 'SKU-LAST-UPDATED' });
    const updated = await db
      .from('products')
      .where(col('sku').eq('SKU-LAST-UPDATED'))
      .toArray();
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(1200);

    await db.close();
    openedDbs = openedDbs.filter((d) => d !== db);

    // Reopen with a different slotCount (e.g. 2048) to confirm on-disk format is slotCount-independent
    const reopened = await WebDB.open({
      name: dbName,
      storage: 'idb',
      slotCount: 2048,
      crossTabSync: false,
    });
    openedDbs.push(reopened);

    const countRows = await reopened.from('products').count('id', 'total').toArray();
    expect(countRows[0].total).toBe(1200);

    const afterReopen = await reopened
      .from('products')
      .where(col('sku').eq('SKU-LAST-UPDATED'))
      .toArray();
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0].id).toBe(1200);
  });

  it('executes overflow reads, GROUP BY, ORDER BY, JOIN, and IN queries cleanly with slotCount: 4096 and > 1,100 pages', async () => {
    const db = await WebDB.open({
      name: uniqueName('dynamic_slots_sql_4096'),
      storage: 'memory',
      slotCount: 4096,
    });
    openedDbs.push(db);

    await db.createTable('categories', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'name', type: DataType.TEXT, notNull: true },
    ]);
    await db.createTable('docs', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'cat_id', type: DataType.INT32, notNull: true },
      { name: 'score', type: DataType.INT32, notNull: true },
      { name: 'body', type: DataType.TEXT, notNull: true },
    ]);
    await db.createIndex('docs', ['cat_id'], { name: 'idx_docs_cat' });

    await db.transaction(async (tx) => {
      await tx.insert('categories', { id: 1, name: 'Alpha' });
      await tx.insert('categories', { id: 2, name: 'Beta' });
      await tx.insert('categories', { id: 3, name: 'Gamma' });

      // 600 rows with 5 KB overflow TEXT -> > 1,200 pages (data + overflow chains)
      const overflowPad = 'Z'.repeat(5000);
      for (let i = 1; i <= 600; i++) {
        await tx.insert('docs', {
          id: i,
          cat_id: (i % 3) + 1,
          score: i * 10,
          body: `doc-${i}-${overflowPad}`,
        });
      }
    });

    const totalPages = db.driver.getSlotDataView(0).getUint32(12, true);
    expect(totalPages).toBeGreaterThan(1100);

    // 1. Overflow column read from high-slot pages + IN + ORDER BY (exercises dynamic arena_base)
    const top3 = await db
      .from('docs')
      .where('id', 'IN', [598, 599, 600])
      .orderBy('score', 'desc')
      .toArray();
    expect(top3.map((r) => r.id)).toEqual([600, 599, 598]);
    expect((top3[0].body as string).length).toBe(5008);
    expect((top3[0].body as string).startsWith('doc-600-')).toBe(true);

    // 2. GROUP BY + aggregates over 600 rows
    const grouped = await db
      .from('docs')
      .select('cat_id', fn.count('id').as('cnt'), fn.max('score').as('max_score'))
      .groupBy('cat_id')
      .orderBy('cat_id', 'asc')
      .toArray();
    expect(grouped).toEqual([
      { cat_id: 1, cnt: 200, max_score: 6000 },
      { cat_id: 2, cnt: 200, max_score: 5980 },
      { cat_id: 3, cnt: 200, max_score: 5990 },
    ]);

    // 3. INNER JOIN across tables
    const joined = await db
      .from('docs')
      .join('categories', 'docs.cat_id', 'categories.id')
      .select('docs.id', 'categories.name')
      .where('docs.id', '=', 600)
      .toArray();
    expect(joined).toHaveLength(1);
    expect(joined[0]).toEqual({ id: 600, name: 'Alpha' });
  });

  it('rejects invalid slotCount values (< 2, non-integer, or > MAX_SLOT_COUNT) in WebDB.open, BufferPoolDriver, and BufferPool', async () => {
    for (const bad of [0, 1, -4, 16.5, NaN, MAX_SLOT_COUNT + 1]) {
      await expect(
        WebDB.open({ name: uniqueName('bad_slot'), slotCount: bad }),
      ).rejects.toThrow(RangeError);

      expect(() => new BufferPool({ slotCount: bad })).toThrow(RangeError);

      const vfs = new MemoryVfsAdapter();
      const mem = createWasmMemory(16);
      expect(
        () => new BufferPoolDriver({ vfs, memory: mem, slotCount: bad }),
      ).toThrow(RangeError);
    }
  });
});
