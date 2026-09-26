import { describe, it, expect } from 'vitest';
import {
  initPage,
  insertRowIntoPage,
  deleteRowFromPage,
  updateRowInPage,
  getCellCount,
  getCellOffset,
  getCellContentOffset,
  getFreeBytes,
  getContiguousFreeSpace,
  getTotalFreeSpace,
  serializeRow,
  deserializeRow,
} from '../src/engine/page.js';
import {
  initPage1,
  readPage1Header,
} from '../src/engine/catalog.js';
import {
  PAGE_SIZE,
  PAGE_HEADER_SIZE,
  PAGE_TYPE_LEAF_DATA,
} from '../src/constants.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
  RowSizeLimitExceededError,
} from '../src/types.js';
import { WebDB } from '../src/webdb.js';

describe('Test Suite 1: Slotted Page & Memory Geometry (tests/page_geometry.test.ts)', () => {
  const table: TableMeta = {
    tableId: 1,
    columnCount: 3,
    rootPageId: 2,
    colCatalogPageId: 3,
    name: 'items',
    flags: 1,
    rowCountEstimate: 0,
    autoIncNext: 1n,
    columns: [
      { type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY, colOffset: 0, name: 'id' },
      { type: DataType.TEXT, flags: ColumnFlag.NOT_NULL, colOffset: 0, name: 'payload' },
      { type: DataType.INT32, flags: ColumnFlag.NONE, colOffset: 4, name: 'extra' },
    ],
  };

  it('1. Empty Page Initialization', () => {
    // Test Page 1 initialization
    const p1Buf = new ArrayBuffer(PAGE_SIZE);
    const p1View = new DataView(p1Buf);
    initPage1(p1View);

    const hdr = readPage1Header(p1View, true);
    expect(hdr.pageSize).toBe(4096);
    expect(hdr.fileFormatVersion).toBe(1);
    expect(hdr.minReadVersion).toBe(1);
    expect(hdr.totalPages).toBe(1);
    expect(hdr.freePageHead).toBe(0);

    // Test Data Page initialization
    const dataBuf = new ArrayBuffer(PAGE_SIZE);
    const dataView = new DataView(dataBuf);
    initPage(dataView, 0, PAGE_TYPE_LEAF_DATA);

    expect(dataView.getUint8(0)).toBe(PAGE_TYPE_LEAF_DATA);
    expect(getCellCount(dataView, 0)).toBe(0);
    expect(getCellContentOffset(dataView, 0)).toBe(PAGE_SIZE);
    expect(getFreeBytes(dataView, 0)).toBe(0);
    expect(getContiguousFreeSpace(dataView, 0)).toBe(PAGE_SIZE - PAGE_HEADER_SIZE);
  });

  it('2. Sequential Fill & Split Trigger (returns -1 when full)', () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    initPage(view, 0);

    // Each row ~500 bytes -> 8 rows would need 4000 bytes + 16 bytes slots + 16 bytes header = 4032 bytes
    const row = serializeRow(table, { id: 1, payload: 'A'.repeat(500), extra: 10 });
    let count = 0;
    while (true) {
      const slot = insertRowIntoPage(view, 0, row);
      if (slot === -1) break;
      count++;
    }

    expect(count).toBeGreaterThanOrEqual(7);
    expect(count).toBeLessThanOrEqual(9);
    // Further insert must return -1
    expect(insertRowIntoPage(view, 0, row)).toBe(-1);
  });

  it('3. Defragmentation & In-Place Compaction', () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    initPage(view, 0);

    // Insert 5 rows of ~400 bytes each (~2000 bytes)
    const rows = [
      serializeRow(table, { id: 0, payload: '0'.repeat(380), extra: 0 }),
      serializeRow(table, { id: 1, payload: '1'.repeat(380), extra: 1 }),
      serializeRow(table, { id: 2, payload: '2'.repeat(380), extra: 2 }),
      serializeRow(table, { id: 3, payload: '3'.repeat(380), extra: 3 }),
      serializeRow(table, { id: 4, payload: '4'.repeat(380), extra: 4 }),
    ];

    for (const r of rows) {
      insertRowIntoPage(view, 0, r);
    }
    expect(getCellCount(view, 0)).toBe(5);

    // Delete row 1 and row 3 (creating ~800 bytes of non-contiguous holes)
    // Note: deleting index 1 shifts entries left, so former row 3 is now index 2
    deleteRowFromPage(view, 0, 1);
    deleteRowFromPage(view, 0, 2);
    expect(getCellCount(view, 0)).toBe(3);
    expect(getFreeBytes(view, 0)).toBeGreaterThan(700);

    // Insert a new row of 600 bytes
    const bigRow = serializeRow(table, { id: 99, payload: 'B'.repeat(580), extra: 99 });
    const slot = insertRowIntoPage(view, 0, bigRow);

    expect(slot).toBe(3); // Successfully inserted
    expect(getCellCount(view, 0)).toBe(4);

    // Verify all remaining rows intact
    const off0 = getCellOffset(view, 0, 0);
    const off1 = getCellOffset(view, 0, 1);
    const off2 = getCellOffset(view, 0, 2);
    const offBig = getCellOffset(view, 0, 3);

    expect(deserializeRow(table, view, off0).id).toBe(0);
    expect(deserializeRow(table, view, off1).id).toBe(2);
    expect(deserializeRow(table, view, off2).id).toBe(4);
    expect(deserializeRow(table, view, offBig).id).toBe(99);
  });

  it('4. Row Deletion & memmove Verification', () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    initPage(view, 0);

    const r0 = serializeRow(table, { id: 10, payload: 'row10', extra: 1 });
    const r1 = serializeRow(table, { id: 20, payload: 'row20', extra: 2 });
    const r2 = serializeRow(table, { id: 30, payload: 'row30', extra: 3 });
    const r3 = serializeRow(table, { id: 40, payload: 'row40', extra: 4 });

    insertRowIntoPage(view, 0, r0);
    insertRowIntoPage(view, 0, r1);
    insertRowIntoPage(view, 0, r2);
    insertRowIntoPage(view, 0, r3);

    expect(getCellCount(view, 0)).toBe(4);

    // Delete row 1 (id: 20)
    deleteRowFromPage(view, 0, 1);
    expect(getCellCount(view, 0)).toBe(3);

    // Remaining slots 0, 1, 2 must correspond to id: 10, 30, 40
    const d0 = deserializeRow(table, view, getCellOffset(view, 0, 0));
    const d1 = deserializeRow(table, view, getCellOffset(view, 0, 1));
    const d2 = deserializeRow(table, view, getCellOffset(view, 0, 2));

    expect(d0.id).toBe(10);
    expect(d1.id).toBe(30);
    expect(d2.id).toBe(40);
  });

  it('5. Empty Page Free List Cycle', async () => {
    const db = await WebDB.open({ name: 'test_freelist_cycle', storage: 'memory' });
    await db.createTable('t1', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'val', type: 'TEXT' },
    ]);

    // Insert enough rows to fill multiple pages
    for (let i = 1; i <= 30; i++) {
      await db.insert('t1', { id: i, val: 'X'.repeat(500) });
    }

    const initialTotal = db.pool.getSlotDataView(0).getUint32(12, true);
    expect(initialTotal).toBeGreaterThan(2);

    // Free a page via pool.freePage
    await db.pool.freePage(initialTotal);
    const freeHead = db.pool.getSlotDataView(0).getUint32(16, true);
    expect(freeHead).toBe(initialTotal);

    // Allocate next page -> must recycle the freed page without incrementing total_pages
    const recycledPageId = await db.pool.allocatePage();
    expect(recycledPageId).toBe(initialTotal);
    expect(db.pool.getSlotDataView(0).getUint32(12, true)).toBe(initialTotal);
  });

  it('6. Expanding Update with Compaction', () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    initPage(view, 0);

    const r0 = serializeRow(table, { id: 1, payload: 'short', extra: 1 });
    const r1 = serializeRow(table, { id: 2, payload: 'another_short', extra: 2 });
    insertRowIntoPage(view, 0, r0);
    insertRowIntoPage(view, 0, r1);

    // Update row 0 to larger payload
    const updatedR0 = serializeRow(table, { id: 1, payload: 'much_longer_payload_expanding_row', extra: 1 });
    const success = updateRowInPage(view, 0, 0, updatedR0);

    expect(success).toBe(true);
    const d0 = deserializeRow(table, view, getCellOffset(view, 0, 0));
    expect(d0.payload).toBe('much_longer_payload_expanding_row');
  });

  it('7. Boundary Limit (2048 Bytes)', () => {
    // Exactly 2048 bytes must pass
    // Row header: 1B flag + 2B len + 1B nullmap + 4B fixed (id) + 4B fixed (extra) + 4B varTable = 16B
    // 2048 - 16 = 2032 payload bytes
    const exact2048 = serializeRow(table, { id: 1, payload: 'A'.repeat(2032), extra: 5 });
    expect(exact2048.byteLength).toBe(2048);

    // 2049 bytes must throw RowSizeLimitExceededError
    expect(() => {
      serializeRow(table, { id: 1, payload: 'A'.repeat(2033), extra: 5 });
    }).toThrow(RowSizeLimitExceededError);
  });

  it('8. Repeated Expanding In-Place Updates: free_bytes and totalFree accounting integrity', () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    initPage(view, 0);

    const r0 = serializeRow(table, { id: 1, payload: 'A'.repeat(50), extra: 1 });
    const r1 = serializeRow(table, { id: 2, payload: 'B'.repeat(50), extra: 2 });
    insertRowIntoPage(view, 0, r0);
    insertRowIntoPage(view, 0, r1);

    let prevTotalFree = getTotalFreeSpace(view, 0);
    let currentPayloadLen = 50;

    // Perform multiple sequential expanding updates on row 0
    for (let step = 1; step <= 5; step++) {
      const nextLen = currentPayloadLen + 30;
      const updatedRow = serializeRow(table, { id: 1, payload: 'A'.repeat(nextLen), extra: 1 });
      const expansion = updatedRow.byteLength - serializeRow(table, { id: 1, payload: 'A'.repeat(currentPayloadLen), extra: 1 }).byteLength;

      const ok = updateRowInPage(view, 0, 0, updatedRow);
      expect(ok).toBe(true);

      const newTotalFree = getTotalFreeSpace(view, 0);
      // Invariant: Total free space MUST decrease by exactly the expansion amount
      expect(newTotalFree).toBe(prevTotalFree - expansion);
      // Invariant: free_bytes must be non-negative and <= PAGE_SIZE
      expect(getFreeBytes(view, 0)).toBeGreaterThan(0);
      expect(getFreeBytes(view, 0)).toBeLessThan(PAGE_SIZE);

      prevTotalFree = newTotalFree;
      currentPayloadLen = nextLen;
    }

    // Fill contiguous space with two rows <= 2048 bytes so contiguousFree becomes smaller than largeRow (450 bytes),
    // forcing compaction to reclaim the accumulated fragmented holes (free_bytes)
    insertRowIntoPage(view, 0, serializeRow(table, { id: 98, payload: 'X'.repeat(1200), extra: 98 }));
    insertRowIntoPage(view, 0, serializeRow(table, { id: 99, payload: 'Y'.repeat(1200), extra: 99 }));

    // Now contiguousFree is 728 bytes, but free_bytes has accumulated > 500 bytes.
    // An expanding update needing 866 bytes (> 728 contiguous) forces compaction!
    expect(getContiguousFreeSpace(view, 0)).toBeLessThan(800);
    expect(getFreeBytes(view, 0)).toBeGreaterThan(500);

    const largeRow = serializeRow(table, { id: 1, payload: 'A'.repeat(850), extra: 1 });
    const ok = updateRowInPage(view, 0, 0, largeRow);
    expect(ok).toBe(true);

    // After compaction: all holes are reclaimed, free_bytes MUST be 0
    expect(getFreeBytes(view, 0)).toBe(0);
    expect(getTotalFreeSpace(view, 0)).toBe(getContiguousFreeSpace(view, 0));

    // Verify both row 0 and row 1 are uncorrupted
    const d0 = deserializeRow(table, view, getCellOffset(view, 0, 0));
    expect(d0.payload).toBe('A'.repeat(850));
    const d1 = deserializeRow(table, view, getCellOffset(view, 0, 1));
    expect(d1.payload).toBe('B'.repeat(50));

    // Page must remain healthy: inserting a new row succeeds without corruption
    const r2 = serializeRow(table, { id: 3, payload: 'C'.repeat(50), extra: 3 });
    const slot2 = insertRowIntoPage(view, 0, r2);
    expect(slot2).toBe(4);
    const d2 = deserializeRow(table, view, getCellOffset(view, 0, slot2));
    expect(d2.payload).toBe('C'.repeat(50));
  });
});
