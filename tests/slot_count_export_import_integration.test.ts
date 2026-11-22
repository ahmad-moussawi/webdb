import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebDB, DataType, col, fn, isIndexAlignedWithOrderBy } from '../src/index.js';
import { testEngine } from "./helpers/test_engine.js";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";
import { IdbStorage } from "@ahmadmoussawi/webdb/storage/idb";

let openedDbs: WebDB[] = [];
let dbSeq = 0;

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${dbSeq++}_${Math.random().toString(36).slice(2, 7)}`;
}

afterEach(async () => {
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
});

/**
 * Seeds a rich multi-table database exceeding Page 1 catalog capacities:
 * - 22 tables (> 16 tables -> chained table descriptor overflow catalog page)
 * - 12 secondary indexes (> 8 indexes -> chained index descriptor overflow catalog page)
 * - Overflow TEXT payloads + multi-page B+Trees (> 1,100 pages total when largeMode = true)
 */
async function seedRichDatabase(
  db: WebDB,
  opts: { tableCount?: number; rowsPerExtraTable?: number; bigRows?: number } = {},
): Promise<{
  tableNames: string[];
  bigRowCount: number;
  rowsPerExtraTable: number;
  bigOverflowPrefix: string;
}> {
  const tableCount = opts.tableCount ?? 22;
  const rowsPerExtraTable = opts.rowsPerExtraTable ?? 25;
  const bigRowCount = opts.bigRows ?? 700;
  const tableNames: string[] = [];

  // Primary large table with overflow TEXT and secondary index
  await db.createTable('big_orders', [
    { name: 'id', type: DataType.INT32, primaryKey: true },
    { name: 'code', type: DataType.TEXT, notNull: true },
    { name: 'region', type: DataType.TEXT, notNull: true },
    { name: 'amount', type: DataType.INT32, notNull: true },
    { name: 'payload', type: DataType.TEXT, notNull: true },
  ]);
  await db.createIndex('big_orders', ['code'], { name: 'idx_big_orders_code' });
  await db.createIndex('big_orders', ['region'], { name: 'idx_big_orders_region' });
  tableNames.push('big_orders');

  // Additional 21 tables (> 16 tables total -> forces chained table catalog pages + 22 pinned col catalog pages)
  // Plus 10 more secondary indexes (> 8 indexes total -> forces chained index catalog pages)
  for (let t = 1; t < tableCount; t++) {
    const tName = `entity_${String(t).padStart(2, '0')}`;
    tableNames.push(tName);
    await db.createTable(tName, [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'tag', type: DataType.TEXT, notNull: true },
      { name: 'val', type: DataType.INT32, notNull: true },
    ]);
    if (t <= 10) {
      await db.createIndex(tName, ['tag'], { name: `idx_${tName}_tag` });
    }
  }

  // Populate big_orders (~2.4 KB payload -> triggers overflow pages + > 1,100 pages total)
  const bigOverflowPrefix = 'OVF_';
  const pad = 'M'.repeat(2400);
  const regions = ['north', 'south', 'east', 'west'];
  await db.transaction(async (tx) => {
    for (let i = 1; i <= bigRowCount; i++) {
      await tx.insert('big_orders', {
        id: i,
        code: `ORD-${String(i).padStart(5, '0')}`,
        region: regions[i % regions.length],
        amount: i * 5,
        payload: `${bigOverflowPrefix}${i}_${pad}_END`,
      });
    }
  });

  // Populate all extra tables
  await db.transaction(async (tx) => {
    for (let t = 1; t < tableCount; t++) {
      const tName = `entity_${String(t).padStart(2, '0')}`;
      for (let r = 1; r <= rowsPerExtraTable; r++) {
        await tx.insert(tName, {
          id: r,
          tag: `t${t}-tag-${r}`,
          val: t * 1000 + r,
        });
      }
    }
  });

  return { tableNames, bigRowCount, rowsPerExtraTable, bigOverflowPrefix };
}

/**
 * Thoroughly verifies schema, catalog integrity, row counts, indexed lookups,
 * overflow payloads, GROUP BY aggregates, and joins on a database instance.
 */
async function verifyRichDatabase(
  db: WebDB,
  expected: {
    tableNames: string[];
    bigRowCount: number;
    rowsPerExtraTable: number;
    bigOverflowPrefix: string;
  },
): Promise<void> {
  // 1. All tables present in catalog (including chained overflow catalog tables)
  const actualNames = (await db.getTableNames()).sort();
  expect(actualNames).toEqual([...expected.tableNames].sort());

  // 2. Verify big_orders row count, indexed lookup, overflow integrity, and GROUP BY
  const bigCount = await db.from('big_orders').count('id', 'cnt').toArray();
  expect(bigCount[0].cnt).toBe(expected.bigRowCount);

  const targetId = expected.bigRowCount - 7;
  const targetCode = `ORD-${String(targetId).padStart(5, '0')}`;
  const hit = await db
    .from('big_orders')
    .where(col('code').eq(targetCode))
    .toArray();
  expect(hit).toHaveLength(1);
  expect(hit[0].id).toBe(targetId);
  expect(hit[0].amount).toBe(targetId * 5);
  const payload = hit[0].payload as string;
  expect(payload.startsWith(`${expected.bigOverflowPrefix}${targetId}_`)).toBe(true);
  expect(payload.endsWith('_END')).toBe(true);
  expect(payload.length).toBeGreaterThan(2400);

  const grouped = await db
    .from('big_orders')
    .select('region', fn.count('id').as('cnt'))
    .groupBy('region')
    .orderBy('region', 'asc')
    .toArray();
  expect(grouped).toHaveLength(4);
  const sumCounts = grouped.reduce((acc, g) => acc + Number(g.cnt), 0);
  expect(sumCounts).toBe(expected.bigRowCount);

  // 3. Spot-check first, middle, and last extra tables (including indexed lookup + JOIN)
  const extraCount = expected.tableNames.filter((n) => n.startsWith('entity_')).length;
  for (const idx of [1, 10, extraCount]) {
    const tName = `entity_${String(idx).padStart(2, '0')}`;
    const cnt = await db.from(tName).count('id', 'cnt').toArray();
    expect(cnt[0].cnt).toBe(expected.rowsPerExtraTable);

    const lastRow = await db
      .from(tName)
      .where(col('tag').eq(`t${idx}-tag-${expected.rowsPerExtraTable}`))
      .toArray();
    expect(lastRow).toHaveLength(1);
    expect(lastRow[0].val).toBe(idx * 1000 + expected.rowsPerExtraTable);
  }

  // 4. JOIN between big_orders and a chained-catalog table (last entity_XX, > 16 tables)
  const joinTable = `entity_${String(extraCount).padStart(2, '0')}`;
  const joined = await db
    .from('big_orders')
    .join(joinTable, 'big_orders.id', `${joinTable}.id`)
    .select('big_orders.id', 'big_orders.code', `${joinTable}.tag`)
    .where('big_orders.id', '=', 15)
    .toArray();
  expect(joined).toEqual([{ id: 15, code: 'ORD-00015', tag: `t${extraCount}-tag-15` }]);
}

describe('Cross-slotCount Export/Import Integration Tests (Large Multi-Table DB)', () => {
  it('Small -> Large: exports 22-table DB (> 1,100 pages) from slotCount: 64 and imports into slotCount: 8192', async () => {
    const src = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('exp_small_64')),
      slotCount: 64,
      crossTabSync: false,
    });
    openedDbs.push(src);

    const expected = await seedRichDatabase(src, {
      tableCount: 22,
      rowsPerExtraTable: 25,
      bigRows: 1050,
    });

    const totalPages = src.driver.getSlotDataView(0).getUint32(12, true);
    expect(totalPages).toBeGreaterThan(1050);

    const binary = await src.exportBinary();
    expect(binary.byteLength).toBe(totalPages * 4096);

    // Import into a much larger buffer pool (slotCount: 8192)
    const dstName = uniqueName('imp_large_8192');
    const dst = await WebDB.open({
      name: dstName,
      engine: testEngine(),
      storage: new IdbStorage(dstName),
      slotCount: 8192,
      crossTabSync: false,
    });
    openedDbs.push(dst);

    await dst.importBinary(binary);
    await verifyRichDatabase(dst, expected);

    // Mutate after import, checkpoint, close, and reopen with slotCount: 4096
    await dst.insert('big_orders', {
      id: 9999,
      code: 'ORD-09999',
      region: 'north',
      amount: 49995,
      payload: 'OVF_9999_' + 'N'.repeat(2500) + '_END',
    });
    await dst.checkpoint();
    await dst.close();
    openedDbs = openedDbs.filter((d) => d !== dst);

    const reopened = await WebDB.open({
      name: dstName,
      engine: testEngine(),
      storage: new IdbStorage(dstName),
      slotCount: 4096,
      crossTabSync: false,
    });
    openedDbs.push(reopened);

    const added = await reopened
      .from('big_orders')
      .where(col('code').eq('ORD-09999'))
      .toArray();
    expect(added).toHaveLength(1);
    expect(added[0].amount).toBe(49995);
  });

  it('Large -> Small: exports 22-table DB (> 1,100 pages) from slotCount: 8192 and imports into slotCount: 64', async () => {
    const src = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('exp_large_8192')),
      slotCount: 8192,
      crossTabSync: false,
    });
    openedDbs.push(src);

    const expected = await seedRichDatabase(src, {
      tableCount: 22,
      rowsPerExtraTable: 25,
      bigRows: 1050,
    });

    const totalPages = src.driver.getSlotDataView(0).getUint32(12, true);
    expect(totalPages).toBeGreaterThan(1050);

    const binary = await src.exportBinary();

    // Import via initialData directly into a small constrained buffer pool (slotCount: 64)
    const dstName = uniqueName('imp_small_64');
    const dst = await WebDB.open({
      name: dstName,
      engine: testEngine(),
      storage: new IdbStorage(dstName),
      slotCount: 64,
      crossTabSync: false,
      initialData: binary,
    });
    openedDbs.push(dst);

    await verifyRichDatabase(dst, expected);

    // Perform post-import updates/deletes under heavy eviction pressure (slotCount: 64)
    await dst.update('big_orders', { id: 10 }, { code: 'ORD-00010-MOVED' });
    await dst.delete('entity_21', { id: 1 });
    await dst.checkpoint();

    const moved = await dst
      .from('big_orders')
      .where(col('code').eq('ORD-00010-MOVED'))
      .toArray();
    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe(10);

    const e21Count = await dst.from('entity_21').count('id', 'cnt').toArray();
    expect(e21Count[0].cnt).toBe(expected.rowsPerExtraTable - 1);
  });

  it('Multi-hop round-trip: slotCount 1024 -> 4096 -> 64 -> 2048 with mutations at each stage', async () => {
    // Stage 1: seed at default slotCount: 1024
    const db1 = await WebDB.open({
      name: uniqueName('hop_1024'),
      engine: testEngine(),
      storage: new MemoryStorage(),
      slotCount: 1024,
    });
    openedDbs.push(db1);

    const expected = await seedRichDatabase(db1, {
      tableCount: 20,
      rowsPerExtraTable: 20,
      bigRows: 400,
    });
    const snap1 = await db1.exportBinary();

    // Stage 2: import into slotCount: 4096 and add a new table + rows
    const db2 = await WebDB.open({
      name: uniqueName('hop_4096'),
      engine: testEngine(),
      storage: new MemoryStorage(),
      slotCount: 4096,
      initialData: snap1,
    });
    openedDbs.push(db2);
    await verifyRichDatabase(db2, expected);

    await db2.createTable('hop_audit', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'stage', type: DataType.TEXT, notNull: true },
    ]);
    await db2.insert('hop_audit', { id: 1, stage: 'from-4096' });
    const snap2 = await db2.exportBinary();

    // Stage 3: import into constrained slotCount: 64 and append another audit row
    const db3 = await WebDB.open({
      name: uniqueName('hop_64'),
      engine: testEngine(),
      storage: new MemoryStorage(),
      slotCount: 64,
      initialData: snap2,
    });
    openedDbs.push(db3);
    await db3.transaction(async (tx) => {
      await tx.insert('hop_audit', { id: 2, stage: 'from-64' });
    });
    const snap3 = await db3.exportBinary();

    // Stage 4: import into slotCount: 2048 and verify everything survived all 4 hops intact
    const db4 = await WebDB.open({
      name: uniqueName('hop_2048'),
      engine: testEngine(),
      storage: new MemoryStorage(),
      slotCount: 2048,
      initialData: snap3,
    });
    openedDbs.push(db4);

    await verifyRichDatabase(db4, {
      ...expected,
      tableNames: [...expected.tableNames, 'hop_audit'],
    });

    const audits = await db4.from('hop_audit').orderBy('id', 'asc').toArray();
    expect(audits).toEqual([
      { id: 1, stage: 'from-4096' },
      { id: 2, stage: 'from-64' },
    ]);
  });

  it('pins overflow-catalog table colCatalogPageId chains and truncates leftover IDB pages on importBinary()', async () => {
    // 1. Create a large source DB (20 tables -> tables 17..20 in overflow catalog, > 100 pages)
    const largeSrc = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('large_for_truncate')),
      slotCount: 128,
      crossTabSync: false,
    });
    openedDbs.push(largeSrc);

    await seedRichDatabase(largeSrc, {
      tableCount: 20,
      rowsPerExtraTable: 10,
      bigRows: 120,
    });
    const largeTotalPages = largeSrc.driver.getSlotDataView(0).getUint32(12, true);
    expect(largeTotalPages).toBeGreaterThan(100);
    const largeBinary = await largeSrc.exportBinary();

    // 2. Create a tiny DB (just 1 table, ~5 pages)
    const tinySrc = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('tiny_for_truncate')),
      slotCount: 32,
      crossTabSync: false,
    });
    openedDbs.push(tinySrc);
    await tinySrc.createTable('small_tbl', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'label', type: DataType.TEXT, notNull: true },
    ]);
    await tinySrc.insert('small_tbl', { id: 1, label: 'tiny' });
    const tinyTotalPages = tinySrc.driver.getSlotDataView(0).getUint32(12, true);
    expect(tinyTotalPages).toBeLessThan(10);
    const tinyBinary = await tinySrc.exportBinary();

    // 3. Import large 20-table DB into a target IDB instance
    const target = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('target_truncate_and_pin')),
      slotCount: 128,
      crossTabSync: false,
    });
    openedDbs.push(target);

    await target.importBinary(largeBinary);

    // Verify overflow-catalog table (entity_19, table #20) has its colCatalogPageId pinned
    const meta19 = await target.getTable('entity_19');
    const colCatSlot = target.driver.getResidentSlot(meta19.colCatalogPageId);
    expect(colCatSlot).toBeGreaterThan(0);
    expect(target.driver.isSlotPinned(colCatSlot)).toBe(true);

    // ORDER BY on an overflow-catalog table with secondary index must succeed cleanly
    const ordered19 = await target
      .from('entity_19')
      .orderBy('id', 'asc')
      .toArray();
    expect(ordered19).toHaveLength(10);

    // 4. Now import the much smaller DB into the SAME target IDB instance
    await target.importBinary(tinyBinary);

    // Leftover pages > tinyTotalPages must be truncated from IndexedDB!
    const leftover = await target.vfs.readPages([
      tinyTotalPages + 1,
      Math.floor(largeTotalPages / 2),
      largeTotalPages,
    ]);
    expect(leftover).toEqual([null, null, null]);

    const tinyRows = await target.from('small_tbl').orderBy('id', 'asc').toArray();
    expect(tinyRows).toEqual([{ id: 1, label: 'tiny' }]);
  });

  it('isIndexAlignedWithOrderBy slices columnIndices to columnCount and guards against out-of-bounds indices', () => {
    const mockTable: any = {
      name: 'orders',
      columns: [
        { name: 'id', type: DataType.INT32 },
        { name: 'code', type: DataType.TEXT },
      ],
    };

    // On-disk single-column index descriptor has 8 padded slots: [1, 0, 0, 0, 0, 0, 0, 0]
    const singleColIndex: any = {
      columnCount: 1,
      columnIndices: [1, 0, 0, 0, 0, 0, 0, 0],
    };

    // Aligned with ORDER BY code ASC
    expect(
      isIndexAlignedWithOrderBy(singleColIndex, mockTable, [
        { colName: 'code', direction: 'asc' },
      ]),
    ).toBe(true);

    // Must NOT treat padded 0 slots as a composite (code, id) index!
    expect(
      isIndexAlignedWithOrderBy(singleColIndex, mockTable, [
        { colName: 'code', direction: 'asc' },
        { colName: 'id', direction: 'asc' },
      ]),
    ).toBe(false);

    // Out-of-bounds column index must safely return false instead of throwing TypeError
    const corruptIndex: any = {
      columnCount: 1,
      columnIndices: [99, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(
      isIndexAlignedWithOrderBy(corruptIndex, mockTable, [
        { colName: 'code', direction: 'asc' },
      ]),
    ).toBe(false);
  });

  it('does not skip sorting on tie-breaker columns due to padded columnIndices after importBinary()', async () => {
    const src = await WebDB.open({
      name: uniqueName('tie_sort_src'),
      engine: testEngine(),
      storage: new MemoryStorage(),
    });
    openedDbs.push(src);

    await src.createTable('events', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'grp', type: DataType.TEXT, notNull: true },
    ]);
    // Single-column index on col 1 ("grp"); on disk columnIndices is padded to [1, 0, 0, 0, 0, 0, 0, 0]
    await src.createIndex('events', ['grp'], { name: 'idx_events_grp' });

    // Insert ties on "grp" with out-of-order "id" (col 0)
    await src.insert('events', { id: 30, grp: 'a' });
    await src.insert('events', { id: 10, grp: 'a' });
    await src.insert('events', { id: 20, grp: 'a' });
    await src.insert('events', { id: 5, grp: 'b' });
    await src.insert('events', { id: 1, grp: 'b' });

    const snap = await src.exportBinary();

    const dst = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('tie_sort_dst')),
      crossTabSync: false,
      initialData: snap,
    });
    openedDbs.push(dst);

    // ORDER BY grp ASC, id ASC must sort tie-breakers by id (not treat padded 0 slot as composite index)
    const rows = await dst
      .from('events')
      .orderBy('grp', 'asc')
      .orderBy('id', 'asc')
      .toArray();
    expect(rows).toEqual([
      { id: 10, grp: 'a' },
      { id: 20, grp: 'a' },
      { id: 30, grp: 'a' },
      { id: 1, grp: 'b' },
      { id: 5, grp: 'b' },
    ]);
  });

  it('keeps overflow-catalog table & index metadata pinned under tight eviction pressure and notifies subscribers on importBinary()', async () => {
    const src = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('evict_overflow_src')),
      slotCount: 128,
      crossTabSync: false,
    });
    openedDbs.push(src);

    // 20 tables (> 16) + secondary index on table #20 (entity_19) so both table and index live in overflow catalogs
    await seedRichDatabase(src, {
      tableCount: 20,
      rowsPerExtraTable: 15,
      bigRows: 80,
    });
    await src.createIndex('entity_19', ['tag'], { name: 'idx_entity_19_tag' });
    const binary = await src.exportBinary();

    // Open target with tight pool (48 slots: ~24 permanently pinned catalog pages + ~24 evictable slots)
    const dst = await WebDB.open({
      engine: testEngine(),
      storage: new IdbStorage(uniqueName('evict_overflow_dst')),
      slotCount: 48,
      crossTabSync: false,
    });
    openedDbs.push(dst);

    // Subscribe specifically to overflow-catalog table entity_19 before importBinary()
    const notifiedTables: string[][] = [];
    const unsubscribe = dst.subscribe(['entity_19'], (ev) => {
      notifiedTables.push(ev.tables);
    });

    await dst.importBinary(binary);
    unsubscribe();

    // Subscriber must have been notified for overflow-catalog table entity_19
    expect(notifiedTables.length).toBeGreaterThan(0);
    expect(notifiedTables[0]).toContain('entity_19');

    // Thrash the 24 evictable slots by scanning all 80 overflow-backed rows of big_orders
    const bigRows = await dst.from('big_orders').toArray();
    expect(bigRows).toHaveLength(80);

    // Now query entity_19 using ORDER BY on its overflow-catalog secondary index
    const ordered = await dst
      .from('entity_19')
      .orderBy('tag', 'asc')
      .toArray();
    expect(ordered).toHaveLength(15);
    expect(ordered[0].tag).toBe('t19-tag-1');
  });

  it('cleanly allocates and persists new pages after importBinary() shrinks a larger IDB database', async () => {
    const dbName = uniqueName('shrink_reuse_pages');

    // 1. Seed a large DB (> 100 pages) on IDB
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      slotCount: 128,
      crossTabSync: false,
    });
    openedDbs.push(db);

    await seedRichDatabase(db, {
      tableCount: 18,
      rowsPerExtraTable: 5,
      bigRows: 110,
    });
    const oldTotalPages = db.driver.getSlotDataView(0).getUint32(12, true);
    expect(oldTotalPages).toBeGreaterThan(100);

    // 2. Build a tiny 1-table DB (~4 pages) and import it over the large IDB DB
    const tinySrc = await WebDB.open({
      name: uniqueName('tiny_shrink_src'),
      engine: testEngine(),
      storage: new MemoryStorage(),
    });
    openedDbs.push(tinySrc);
    await tinySrc.createTable('fresh', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'data', type: DataType.TEXT, notNull: true },
    ]);
    await tinySrc.insert('fresh', { id: 1, data: 'seed' });
    const tinyBinary = await tinySrc.exportBinary();

    await db.importBinary(tinyBinary);

    // 3. Allocate fresh pages beyond tinyTotalPages (reusing page IDs that existed in the old large DB)
    const pad = 'R'.repeat(2500);
    await db.transaction(async (tx) => {
      for (let i = 2; i <= 30; i++) {
        await tx.insert('fresh', { id: i, data: `fresh-${i}-${pad}` });
      }
    });
    await db.checkpoint();
    await db.close();
    openedDbs = openedDbs.filter((d) => d !== db);

    // 4. Reopen and verify zero checksum errors or stale data from the old DB
    const reopened = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      slotCount: 128,
      crossTabSync: false,
    });
    openedDbs.push(reopened);

    const rows = await reopened.from('fresh').orderBy('id', 'asc').toArray();
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({ id: 1, data: 'seed' });
    expect((rows[29].data as string).startsWith('fresh-30-')).toBe(true);
  });
});
