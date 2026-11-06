import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { WebDB, MemoryVfsAdapter, type IVfsAdapter } from '../src/index.ts';

/**
 * Regression: after an explicit transaction, a later AUTOCOMMIT write of the same page used to go
 * straight to main storage while the older page image stayed in the WAL. On an unclean shutdown
 * (tab closed/reloaded, no `close()`), WAL replay then overwrote the newer data with the stale image.
 */
const cols = [
  { name: 'id', type: 'INT32', primaryKey: true },
  { name: 'v', type: 'TEXT' },
] as const;

type Reopen = (name: string) => { make: () => Promise<WebDB> };

const backends: Array<[string, () => Reopen]> = [
  [
    'MemoryVfsAdapter',
    () => {
      const vfs: IVfsAdapter = new MemoryVfsAdapter();
      return () => ({ make: () => WebDB.open({ name: 'w', vfs }) });
    },
  ],
  ['IndexedDB', () => (name) => ({ make: () => WebDB.open({ name, storage: 'idb' }) })],
];

describe.each(backends)('autocommit after a transaction survives an unclean shutdown – %s', (label, factory) => {
  let n = 0;
  const open = () => {
    const reopen = factory();
    const name = `wal_dur_${label}_${n++}`;
    return reopen(name);
  };
  const ids = async (db: WebDB) => (await db.from('t').orderBy('id').toArray()).map((r) => `${r.id}:${r.v}`);

  it('keeps an autocommit insert made after a transaction', async () => {
    const h = open();
    const a = await h.make();
    await a.createTable('t', [...cols]);
    await a.transaction(async (tx) => {
      await tx.insert('t', { id: 1, v: 'tx' });
    });
    await a.insert('t', { id: 2, v: 'auto' });
    // no close(): simulate a page reload / crash
    const b = await h.make();
    expect(await ids(b)).toEqual(['1:tx', '2:auto']);
  });

  it('keeps autocommit update and delete made after a transaction', async () => {
    const h = open();
    const a = await h.make();
    await a.createTable('t', [...cols]);
    await a.transaction(async (tx) => {
      await tx.insertMany('t', [
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
        { id: 3, v: 'c' },
      ]);
    });
    await a.update('t', 1, { v: 'A' });
    await a.delete('t', 2);
    const b = await h.make();
    expect(await ids(b)).toEqual(['1:A', '3:c']);
  });

  it('keeps several autocommits across many pages after a transaction, atomically per write', async () => {
    const h = open();
    const a = await h.make();
    await a.createTable('t', [...cols]);
    await a.transaction(async (tx) => {
      await tx.insert('t', { id: 0, v: 'seed' });
    });
    const big = 'x'.repeat(900); // forces several data pages
    for (let i = 1; i <= 30; i++) await a.insert('t', { id: i, v: big });
    await a.insertMany('t', Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, v: big })));
    const b = await h.make();
    const rows = await b.from('t').toArray();
    expect(rows).toHaveLength(41);
    expect((await b.listTables())[0].rowCountEstimate).toBe(41);
  });

  it('still works after a checkpoint and after interleaving more transactions', async () => {
    const h = open();
    const a = await h.make();
    await a.createTable('t', [...cols]);
    await a.transaction(async (tx) => {
      await tx.insert('t', { id: 1, v: 'one' });
    });
    await a.insert('t', { id: 2, v: 'two' });
    await a.checkpoint();
    await a.insert('t', { id: 3, v: 'three' });
    await a.transaction(async (tx) => {
      await tx.insert('t', { id: 4, v: 'four' });
    });
    await a.insert('t', { id: 5, v: 'five' });
    const b = await h.make();
    expect(await ids(b)).toEqual(['1:one', '2:two', '3:three', '4:four', '5:five']);
  });
});
