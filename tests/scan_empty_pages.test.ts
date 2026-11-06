import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/index.ts';

/**
 * Regression: after every row of a multi-page table was deleted, the first data page is empty but
 * still linked to later pages. Rows inserted afterwards land on a later page, and the scan used to
 * stop at the empty first page and return nothing.
 */
const cols = [
  { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
  { name: 'v', type: 'TEXT', notNull: true },
] as const;
const rows = (n: number, tag = '') => Array.from({ length: n }, (_, i) => ({ v: `${tag}${'x'.repeat(300)}${i}` }));

describe('table scans skip empty pages in the chain', () => {
  const open = async () => {
    const db = await WebDB.open({ name: `scan_${Math.random()}`, storage: 'memory' });
    await db.createTable('t', [...cols]);
    return db;
  };

  it('returns rows inserted after deleting everything from a multi-page table', async () => {
    const db = await open();
    await db.insertMany('t', rows(40));
    expect(await db.from('t').toArray()).toHaveLength(40);
    await db.from('t').delete();
    expect(await db.from('t').toArray()).toHaveLength(0);
    await db.insertMany('t', rows(25, 'again-'));
    expect(await db.from('t').toArray()).toHaveLength(25);
    expect(await db.from('t').count('id', 'n').toArray()).toEqual([{ n: 25 }]);
  });

  it('works inside a single transaction (delete all + re-insert)', async () => {
    const db = await open();
    await db.insertMany('t', rows(40));
    await db.transaction(async (tx) => {
      await tx.from('t').delete();
      await tx.insertMany('t', rows(40, 'new-'));
    });
    const out = await db.from('t').toArray();
    expect(out).toHaveLength(40);
    expect(String(out[0].v).startsWith('new-')).toBe(true);
  });

  it('skips empty pages in the middle of the chain', async () => {
    const db = await open();
    await db.insertMany('t', rows(60));
    // delete the middle: ids 15..45 empties at least one whole page
    await db.from('t').where('id', '>=', 15).where('id', '<=', 45).delete();
    const ids = (await db.from('t').orderBy('id').toArray()).map((r) => r.id as number);
    expect(ids).toHaveLength(29);
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(60);
    // and filtered scans keep working
    expect(await db.from('t').where('id', '>', 50).toArray()).toHaveLength(10);
  });
});
