import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebDB, DataType, col, fn } from '../src/index.js';

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
      name: uniqueName('exp_small_64'),
      storage: 'idb',
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
      storage: 'idb',
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
      storage: 'idb',
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
      name: uniqueName('exp_large_8192'),
      storage: 'idb',
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
      storage: 'idb',
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
      storage: 'memory',
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
      storage: 'memory',
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
      storage: 'memory',
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
      storage: 'memory',
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
});
