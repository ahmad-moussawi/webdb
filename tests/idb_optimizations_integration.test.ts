import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebDB, DataType, col } from '../src/index.js';

let openedDbs: WebDB[] = [];
let dbSeq = 0;

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${dbSeq++}_${Math.random().toString(36).slice(2, 7)}`;
}

afterEach(async () => {
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
});

describe('IndexedDB Optimizations — End-to-End Regression & Integration Tests', () => {
  it('maintains cross-tab consistency with readSyncSnapshot, cachedWalFrameCount, and checkpointAtomic', async () => {
    const dbName = uniqueName('idb_crosstab_regression');

    const tabA = await WebDB.open({ name: dbName, storage: 'idb', crossTabSync: true });
    openedDbs.push(tabA);

    await tabA.createTable('tickets', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'status', type: DataType.TEXT, notNull: true },
      { name: 'amount', type: DataType.INT32, notNull: true },
    ]);
    await tabA.createIndex('tickets', ['status'], { name: 'idx_tickets_status' });
    await tabA.checkpoint();

    const tabB = await WebDB.open({ name: dbName, storage: 'idb', crossTabSync: true });
    openedDbs.push(tabB);

    // Tab A writes via explicit tx (frames live in WAL, not yet checkpointed)
    await tabA.transaction(async (tx) => {
      await tx.insert('tickets', { id: 1, status: 'open', amount: 100 });
      await tx.insert('tickets', { id: 2, status: 'open', amount: 250 });
    });
    expect(await tabA.vfs.getWalFrameCount()).toBeGreaterThan(0);

    // Tab B syncs cross-tab state -> replays Tab A's WAL via checkpointAtomic
    await tabB.coordinator.syncCrossTabState(true);
    const seenByB = await tabB.from('tickets').orderBy('id', 'asc').toArray();
    expect(seenByB.map((r) => r.id)).toEqual([1, 2]);

    // Tab B now writes its own transaction (must not collide with stale WAL keys)
    await tabB.transaction(async (tx) => {
      await tx.insert('tickets', { id: 3, status: 'paid', amount: 400 });
      await tx.update('tickets', { id: 1 }, { status: 'paid' });
    });

    // Tab A syncs cross-tab state -> sees Tab B's changes and invalidates its walHeaderReady
    await tabA.coordinator.syncCrossTabState(true);
    const seenByA = await tabA.from('tickets').orderBy('id', 'asc').toArray();
    expect(seenByA).toEqual([
      { id: 1, status: 'paid', amount: 100 },
      { id: 2, status: 'open', amount: 250 },
      { id: 3, status: 'paid', amount: 400 },
    ]);

    // Tab A writes again (explicit tx + autocommit) and both tabs converge cleanly
    await tabA.transaction(async (tx) => {
      await tx.insert('tickets', { id: 4, status: 'open', amount: 50 });
    });
    await tabA.insert('tickets', { id: 5, status: 'paid', amount: 75 });

    await tabB.coordinator.syncCrossTabState(true);
    const finalB = await tabB
      .from('tickets')
      .where(col('status').eq('paid'))
      .orderBy('id', 'asc')
      .toArray();
    expect(finalB.map((r) => r.id)).toEqual([1, 3, 5]);
  });

  it('recovers uncheckpointed explicit transactions + post-tx autocommit writes after simulated crash', async () => {
    const dbName = uniqueName('idb_crash_recovery_regression');

    const db1 = await WebDB.open({
      name: dbName,
      storage: 'idb',
      crossTabSync: false,
    });
    // Intentionally do NOT add db1 to openedDbs (we simulate a crash without db1.close() checkpoint)
    await db1.createTable('ledger', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'note', type: DataType.TEXT, notNull: true },
    ]);

    // Commit two explicit transactions (deferred WAL header written with tx #1)
    await db1.transaction(async (tx) => {
      await tx.insert('ledger', { id: 1, note: 'tx1-a' });
      await tx.insert('ledger', { id: 2, note: 'tx1-b' });
    });
    await db1.transaction(async (tx) => {
      await tx.update('ledger', { id: 1 }, { note: 'tx2-updated' });
      await tx.insert('ledger', { id: 3, note: 'tx2-c' });
    });

    // Autocommit write touching a page already in the WAL (goes through commitDirectPagesViaWal)
    await db1.insert('ledger', { id: 4, note: 'autocommit-via-wal' });

    // Confirm WAL has uncheckpointed frames before simulated crash
    const framesBeforeCrash = await db1.vfs.getWalFrameCount();
    expect(framesBeforeCrash).toBeGreaterThan(0);

    // Simulate crash: close raw IDB connection without running db1.close() / checkpoint()
    await db1.vfs.close?.();

    // Reopen fresh instance -> recoverFromWal replays via checkpointAtomic
    const db2 = await WebDB.open({
      name: dbName,
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(db2);

    expect(await db2.vfs.getWalFrameCount()).toBe(0);
    const rows = await db2.from('ledger').orderBy('id', 'asc').toArray();
    expect(rows).toEqual([
      { id: 1, note: 'tx2-updated' },
      { id: 2, note: 'tx1-b' },
      { id: 3, note: 'tx2-c' },
      { id: 4, note: 'autocommit-via-wal' },
    ]);
  });

  it('handles spilled-page rollback, nested savepoint rollback, and subsequent crash-recoverable commits', async () => {
    const dbName = uniqueName('idb_rollback_spill_regression');
    // Small buffer pool to force uncommitted WAL spills during a large transaction
    const db = await WebDB.open({
      name: dbName,
      storage: 'idb',
      slotCount: 16,
      crossTabSync: false,
    });

    await db.createTable('blobs', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'payload', type: DataType.TEXT, notNull: true },
    ]);

    // 1. Rollback after forcing uncommitted WAL spills (resets WAL to 0 and walHeaderReady = false)
    await expect(
      db.transaction(async (tx) => {
        for (let i = 1; i <= 80; i++) {
          await tx.insert('blobs', {
            id: i,
            payload: `uncommitted-row-${i}-` + 'x'.repeat(500),
          });
        }
        throw new Error('force full rollback');
      }),
    ).rejects.toThrow('force full rollback');

    expect(await db.vfs.getWalFrameCount()).toBe(0);
    expect(await db.from('blobs').toArray()).toHaveLength(0);

    // 2. Subsequent transaction with nested savepoint rollback must write a fresh WAL header & commit cleanly
    await db.transaction(async (tx) => {
      await tx.insert('blobs', { id: 100, payload: 'outer-keep-1' });
      try {
        await tx.transaction(async (nested) => {
          await nested.insert('blobs', { id: 101, payload: 'nested-discard' });
          throw new Error('rollback savepoint');
        });
      } catch {
        // expected
      }
      await tx.insert('blobs', { id: 102, payload: 'outer-keep-2' });
    });

    // Simulate crash without checkpoint to prove the WAL header was properly re-written after rollback
    await db.vfs.close?.();

    const reopened = await WebDB.open({
      name: dbName,
      storage: 'idb',
      slotCount: 16,
      crossTabSync: false,
    });
    openedDbs.push(reopened);

    const rows = await reopened.from('blobs').orderBy('id', 'asc').toArray();
    expect(rows).toEqual([
      { id: 100, payload: 'outer-keep-1' },
      { id: 102, payload: 'outer-keep-2' },
    ]);
  });

  it('persists batched autocommit inserts, indexed updates, and deletes with overflow pages across reopen', async () => {
    const dbName = uniqueName('idb_batched_dml_overflow');
    const db = await WebDB.open({
      name: dbName,
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(db);

    await db.createTable('articles', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'slug', type: DataType.TEXT, notNull: true },
      { name: 'body', type: DataType.TEXT, notNull: true },
    ]);
    await db.createIndex('articles', ['slug'], { name: 'idx_articles_slug' });

    const bigBody1 = 'A'.repeat(6000);
    const bigBody2 = 'B'.repeat(7500);
    const updatedBody1 = 'C'.repeat(8500);

    // Autocommit inserts (each touches Page 1 + data leaf + PK index + secondary index + overflow pages)
    await db.insert('articles', { id: 1, slug: 'alpha', body: bigBody1 });
    await db.insert('articles', { id: 2, slug: 'beta', body: bigBody2 });
    await db.insert('articles', { id: 3, slug: 'gamma', body: 'short' });

    // Autocommit update mutating both indexed column and overflow chain
    await db.update(
      'articles',
      { id: 1 },
      { slug: 'alpha-v2', body: updatedBody1 },
    );

    // Autocommit delete freeing overflow pages and updating indexes
    await db.delete('articles', { id: 2 });

    await db.close();
    openedDbs = openedDbs.filter((d) => d !== db);

    const reopened = await WebDB.open({
      name: dbName,
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(reopened);

    const bySlug = await reopened
      .from('articles')
      .where(col('slug').eq('alpha-v2'))
      .toArray();
    expect(bySlug).toHaveLength(1);
    expect(bySlug[0].id).toBe(1);
    expect(bySlug[0].body).toBe(updatedBody1);

    const all = await reopened.from('articles').orderBy('id', 'asc').toArray();
    expect(all.map((r) => ({ id: r.id, slug: r.slug }))).toEqual([
      { id: 1, slug: 'alpha-v2' },
      { id: 3, slug: 'gamma' },
    ]);
  });

  it('preserves WAL/checkpoint integrity across exportBinary and importBinary (resetWalAfterImport)', async () => {
    const srcName = uniqueName('idb_export_src');
    const dstName = uniqueName('idb_import_dst');

    const src = await WebDB.open({ name: srcName, storage: 'idb', crossTabSync: false });
    openedDbs.push(src);

    await src.createTable('products', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'name', type: DataType.TEXT, notNull: true },
    ]);
    await src.transaction(async (tx) => {
      await tx.insert('products', { id: 1, name: 'Latte' });
      await tx.insert('products', { id: 2, name: 'Mocha' });
    });

    const snapshot = await src.exportBinary();

    // Target DB already has uncheckpointed WAL frames before importBinary()
    const dst = await WebDB.open({ name: dstName, storage: 'idb', crossTabSync: false });
    openedDbs.push(dst);
    await dst.createTable('stale', [{ name: 'id', type: DataType.INT32, primaryKey: true }]);
    await dst.transaction(async (tx) => {
      await tx.insert('stale', { id: 999 });
    });
    expect(await dst.vfs.getWalFrameCount()).toBeGreaterThan(0);

    // importBinary triggers resetWalAfterImport() -> checkpointAtomic([], nextWalHeader)
    await dst.importBinary(snapshot);
    expect(await dst.vfs.getWalFrameCount()).toBe(0);

    // Immediately write another transaction and reopen to confirm WAL works cleanly after import
    await dst.transaction(async (tx) => {
      await tx.insert('products', { id: 3, name: 'Matcha' });
    });
    await dst.close();
    openedDbs = openedDbs.filter((d) => d !== dst);

    const reopenedDst = await WebDB.open({ name: dstName, storage: 'idb', crossTabSync: false });
    openedDbs.push(reopenedDst);

    const rows = await reopenedDst.from('products').orderBy('id', 'asc').toArray();
    expect(rows).toEqual([
      { id: 1, name: 'Latte' },
      { id: 2, name: 'Mocha' },
      { id: 3, name: 'Matcha' },
    ]);
  });

  it('serializes interleaved concurrent writes, explicit transactions, reads, and checkpoints without corruption', async () => {
    const dbName = uniqueName('idb_concurrent_interleave');
    const db = await WebDB.open({
      name: dbName,
      storage: 'idb',
      idbDurability: 'relaxed',
      crossTabSync: false,
    });
    openedDbs.push(db);

    await db.createTable('events', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'kind', type: DataType.TEXT, notNull: true },
    ]);
    await db.createIndex('events', ['kind'], { name: 'idx_events_kind' });

    const ops: Array<Promise<any>> = [];
    for (let i = 1; i <= 20; i++) {
      if (i % 5 === 0) {
        ops.push(
          db.transaction(async (tx) => {
            await tx.insert('events', { id: i, kind: 'tx' });
          }),
        );
      } else {
        ops.push(db.insert('events', { id: i, kind: 'auto' }));
      }
      if (i % 7 === 0) {
        ops.push(db.checkpoint());
      }
      if (i % 4 === 0) {
        ops.push(db.from('events').toArray());
      }
    }

    await Promise.all(ops);
    await db.close();
    openedDbs = openedDbs.filter((d) => d !== db);

    const reopened = await WebDB.open({
      name: dbName,
      storage: 'idb',
      crossTabSync: false,
    });
    openedDbs.push(reopened);

    const rows = await reopened.from('events').orderBy('id', 'asc').toArray();
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.id)).toEqual(
      Array.from({ length: 20 }, (_, idx) => idx + 1),
    );
    expect(rows.filter((r) => r.kind === 'tx')).toHaveLength(4);
    expect(rows.filter((r) => r.kind === 'auto')).toHaveLength(16);
  });
});
