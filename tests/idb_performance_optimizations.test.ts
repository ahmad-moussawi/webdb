import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebDB, DataType, IndexedDbVfsAdapter } from '../src/index.js';

let openedDbs: WebDB[] = [];
let dbSeq = 0;

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${dbSeq++}_${Math.random().toString(36).slice(2, 7)}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
});

interface TxCall {
  stores: string[];
  mode: IDBTransactionMode | undefined;
  options: IDBTransactionOptions | undefined;
}

function spyIdbTransactions(): { calls: TxCall[]; clear: () => void } {
  const calls: TxCall[] = [];
  const orig = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ) {
    const stores =
      typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
    calls.push({ stores, mode, options });
    return orig.call(this, storeNames as any, mode, options);
  });
  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
}

describe('IndexedDB VFS & Transaction Coordinator Performance Optimizations', () => {
  it('batches multi-page autocommit writes into a single readwrite IDB transaction', async () => {
    const db = await WebDB.open({
      name: uniqueName('idb_batch_autocommit'),
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(db);

    await db.createTable('orders', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'sku', type: DataType.TEXT, notNull: true },
      { name: 'total', type: DataType.INT32, notNull: true },
    ]);
    await db.createIndex('orders', ['sku'], { name: 'idx_orders_sku' });

    const spy = spyIdbTransactions();

    // Autocommit insert dirties Page 1 + data leaf + PK index + secondary index (4 pages)
    await db.insert('orders', { id: 1, sku: 'ABC-001', total: 499 });

    const writeTxs = spy.calls.filter((c) => c.mode === 'readwrite');
    expect(writeTxs.length).toBe(1);
    expect(writeTxs[0].stores).toEqual(['pages']);
    expect(writeTxs[0].options).toEqual({ durability: 'relaxed' });

    const rows = await db.from('orders').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, sku: 'ABC-001', total: 499 });
  });

  it('executes checkpoint in a single atomic multi-store readwrite IDB transaction', async () => {
    const name = uniqueName('idb_atomic_checkpoint');
    const db = await WebDB.open({
      name,
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(db);

    await db.createTable('items', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'label', type: DataType.TEXT, notNull: true },
    ]);

    await db.transaction(async (tx) => {
      await tx.insert('items', { id: 1, label: 'Espresso' });
      await tx.insert('items', { id: 2, label: 'Croissant' });
    });

    const spy = spyIdbTransactions();
    const res = await db.checkpoint();
    expect(res.pagesWritten).toBeGreaterThan(0);

    const writeTxs = spy.calls.filter((c) => c.mode === 'readwrite');
    expect(writeTxs.length).toBe(1);
    expect(writeTxs[0].stores).toEqual(['pages', 'wal_frames', 'wal_meta']);

    // Verify data survives reopen cleanly with empty WAL
    expect(await db.vfs.getWalFrameCount()).toBe(0);
    await db.close();
    openedDbs = openedDbs.filter((d) => d !== db);

    const reopened = await WebDB.open({ name, storage: 'idb', crossTabSync: false });
    openedDbs.push(reopened);
    const rows = await reopened.from('items').orderBy('id', 'asc').toArray();
    expect(rows.map((r) => r.label)).toEqual(['Espresso', 'Croissant']);
  });

  it('defers WAL header write into commit and avoids extra getWalFrameCount transactions', async () => {
    const db = await WebDB.open({
      name: uniqueName('idb_wal_combined'),
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(db);

    await db.createTable('logs', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'msg', type: DataType.TEXT, notNull: true },
    ]);

    const spy = spyIdbTransactions();

    // First transaction after open: writes WAL header + frames in ONE readwrite tx
    await db.transaction(async (tx) => {
      await tx.insert('logs', { id: 1, msg: 'first' });
    });

    const firstWriteTxs = spy.calls.filter((c) => c.mode === 'readwrite');
    expect(firstWriteTxs.length).toBe(1);
    expect(firstWriteTxs[0].stores).toEqual(['wal_frames', 'wal_meta']);

    // Second transaction: header is already ready, so only wal_frames is opened (1 readwrite tx)
    spy.clear();
    await db.transaction(async (tx) => {
      await tx.insert('logs', { id: 2, msg: 'second' });
    });

    const secondWriteTxs = spy.calls.filter((c) => c.mode === 'readwrite');
    expect(secondWriteTxs.length).toBe(1);
    expect(secondWriteTxs[0].stores).toEqual(['wal_frames']);

    // Commit itself should not trigger a trailing getWalFrameCount readonly tx
    const trailingReadTxs = spy.calls.filter((c) => c.mode === 'readonly');
    // Only captureSavepoint's single getWalFrameCount in begin() (since Web Locks are disabled)
    expect(trailingReadTxs.length).toBeLessThanOrEqual(1);

    const rows = await db.from('logs').orderBy('id', 'asc').toArray();
    expect(rows.map((r) => r.msg)).toEqual(['first', 'second']);
  });

  it('reads cross-tab sync snapshot in a single multi-store readonly transaction', async () => {
    const vfs = new IndexedDbVfsAdapter(uniqueName('idb_sync_snapshot'));
    const page1 = new Uint8Array(4096);
    page1[0] = 0x42;
    await vfs.writePages([{ pageId: 1, data: page1 }]);

    const spy = spyIdbTransactions();
    const snap = await vfs.readSyncSnapshot();

    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0].mode).toBe('readonly');
    expect(spy.calls[0].stores).toEqual(['pages', 'wal_frames', 'wal_meta']);
    expect(snap.walFrameCount).toBe(0);
    expect(snap.walHeader).toBeNull();
    expect(snap.page1?.[0]).toBe(0x42);

    await vfs.close();
  });

  it('respects idbDurability option ("relaxed", "strict", "default") and falls back on unsupported 3rd arg', async () => {
    // 1. strict
    const strictDb = await WebDB.open({
      name: uniqueName('idb_dur_strict'),
      storage: 'idb',
      idbDurability: 'strict',
      crossTabSync: false,
    });
    openedDbs.push(strictDb);
    expect((strictDb.vfs as IndexedDbVfsAdapter).durability).toBe('strict');

    const strictSpy = spyIdbTransactions();
    await strictDb.createTable('t', [{ name: 'id', type: DataType.INT32, primaryKey: true }]);
    const strictWrites = strictSpy.calls.filter((c) => c.mode === 'readwrite');
    expect(strictWrites.length).toBeGreaterThan(0);
    expect(strictWrites.every((c) => c.options?.durability === 'strict')).toBe(true);
    vi.restoreAllMocks();

    // 2. default (omits 3rd argument)
    const defaultDb = await WebDB.open({
      name: uniqueName('idb_dur_default'),
      storage: 'idb',
      idbDurability: 'default',
      crossTabSync: false,
    });
    openedDbs.push(defaultDb);
    const defaultSpy = spyIdbTransactions();
    await defaultDb.createTable('t', [{ name: 'id', type: DataType.INT32, primaryKey: true }]);
    const defaultWrites = defaultSpy.calls.filter((c) => c.mode === 'readwrite');
    expect(defaultWrites.length).toBeGreaterThan(0);
    expect(defaultWrites.every((c) => c.options === undefined)).toBe(true);
    vi.restoreAllMocks();

    // 3. fallback when browser throws on 3-arg db.transaction
    const vfs = new IndexedDbVfsAdapter(uniqueName('idb_dur_fallback'), {
      durability: 'relaxed',
    });
    const orig = IDBDatabase.prototype.transaction;
    let threwOnce = false;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (options !== undefined) {
        threwOnce = true;
        throw new TypeError('options not supported');
      }
      return orig.call(this, storeNames as any, mode);
    });

    const page = new Uint8Array(4096);
    page[10] = 99;
    await vfs.writePages([{ pageId: 1, data: page }]);
    expect(threwOnce).toBe(true);
    const [loaded] = await vfs.readPages([1]);
    expect(loaded?.[10]).toBe(99);
    await vfs.close();
  });

  it('safely copies subarray views without cloning the entire backing buffer and waits for truncate completion', async () => {
    const vfs = new IndexedDbVfsAdapter(uniqueName('idb_subarray_truncate'));
    const largeBuffer = new ArrayBuffer(65536);
    const view1 = new Uint8Array(largeBuffer, 4096, 4096);
    view1.fill(0xab);
    const view2 = new Uint8Array(largeBuffer, 8192, 4096);
    view2.fill(0xcd);

    await vfs.writePages([
      { pageId: 1, data: view1 },
      { pageId: 2, data: view2 },
    ]);

    const [p1, p2] = await vfs.readPages([1, 2]);
    expect(p1?.byteLength).toBe(4096);
    expect(p1?.buffer.byteLength).toBe(4096);
    expect(p1?.[0]).toBe(0xab);
    expect(p2?.[0]).toBe(0xcd);

    await vfs.truncate(1);
    const [after1, after2] = await vfs.readPages([1, 2]);
    expect(after1?.[0]).toBe(0xab);
    expect(after2).toBeNull();

    await vfs.close();
  });

  it('disables cross-tab Web Locks when crossTabSync is false', async () => {
    const db = await WebDB.open({
      name: uniqueName('idb_single_tab'),
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(db);
    expect(db.coordinator.leaseQueue.hasWebLocks()).toBe(false);
  });
});
