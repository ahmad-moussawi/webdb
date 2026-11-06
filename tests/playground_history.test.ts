import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebDB } from '../src/index.ts';

const g = globalThis as any;

async function loadHistory() {
  return import('../playground/src/utils/history.ts');
}

const run = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  status: 'success' as const,
  durationMs: 1.5,
  rowCount: 3,
  ...extra,
});

describe.each([
  ['IndexedDB (WebDBStudioDB v2)', true],
  ['in-memory fallback', false],
])('Playground query history – %s', (_label, useIdb) => {
  let H: Awaited<ReturnType<typeof loadHistory>>;

  beforeEach(async () => {
    if (useIdb) g.window = g;
    else delete g.window;
    H = await loadHistory();
    H.__resetHistoryConnection();
    if (useIdb) {
      await new Promise<void>((r) => {
        const d = indexedDB.deleteDatabase('WebDBStudioDB');
        d.onsuccess = d.onerror = d.onblocked = () => r();
      });
    }
  });

  afterEach(() => {
    delete g.window;
  });

  it('increments the counter when the same query runs again', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    await H.recordRun(key, run('return db.from("a");'), 100);
    await H.recordRun(key, run('  return db.from("a");\r\n'), 100);
    const e = await H.recordRun(key, run('return db.from("a");', { status: 'error', error: 'boom' }), 100);
    expect(e?.count).toBe(3);
    const list = await H.listHistory(key);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ count: 3, status: 'error', error: 'boom', kind: 'script' });
  });

  it('merges differently written code that returns the same canonical query', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    await H.recordRun(key, run('return db.from("a").limit(5)', { canonical: '{"q":1}' }), 100);
    await H.recordRun(key, run('const n = 5; return db.from("a").limit(n)', { canonical: '{"q":1}' }), 100);
    await H.recordRun(key, run('return db.from("a").limit(6)', { canonical: '{"q":2}' }), 100);
    const list = await H.listHistory(key);
    expect(list).toHaveLength(2);
    const merged = list.find((e) => e.count === 2)!;
    expect(merged.kind).toBe('query');
    expect(merged.code).toContain('const n = 5'); // latest code wins
  });

  it('keeps history separate per storage + database name', async () => {
    await H.recordRun(H.dbKeyFor('idb', 'shop'), run('A'), 100);
    await H.recordRun(H.dbKeyFor('memory', 'shop'), run('A'), 100);
    await H.recordRun(H.dbKeyFor('idb', 'other'), run('A'), 100);
    expect(await H.listHistory(H.dbKeyFor('idb', 'shop'))).toHaveLength(1);
    expect(await H.listHistory(H.dbKeyFor('memory', 'shop'))).toHaveLength(1);
    expect(await H.listHistory(H.dbKeyFor('idb', 'none'))).toHaveLength(0);
  });

  it('skips empty code', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    expect(await H.recordRun(key, run('   \n'), 100)).toBeNull();
    expect(await H.listHistory(key)).toHaveLength(0);
  });

  it('evicts least-recently-run unpinned entries beyond the limit, never pinned ones', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    // minimum limit is 10
    for (let i = 0; i < 10; i++) {
      await H.recordRun(key, run(`q${i}`), 10);
      await new Promise((r) => setTimeout(r, 2));
    }
    const oldest = (await H.listHistory(key)).find((e) => e.code === 'q0')!;
    await H.setPinned(oldest.id, true);
    await H.recordRun(key, run('q10'), 10);
    await H.recordRun(key, run('q11'), 10);
    const codes = (await H.listHistory(key)).map((e) => e.code);
    expect(codes).toContain('q0'); // pinned survives
    expect(codes).not.toContain('q1');
    expect(codes).toContain('q2');
    // pinned q0 + 10 unpinned (q2..q11)
    expect(codes).toHaveLength(11);
  });

  it('enforces a lowered limit and reports what would be lost', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    for (let i = 0; i < 15; i++) {
      await H.recordRun(key, run(`q${i}`), 100);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(await H.countEvictable(key, 10)).toBe(5);
    expect(await H.enforceLimit(key, 10)).toBe(5);
    expect(await H.listHistory(key)).toHaveLength(10);
  });

  it('clears history, keeping pinned unless asked', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    await H.recordRun(key, run('a'), 100);
    const b = (await H.recordRun(key, run('b'), 100))!;
    await H.setPinned(b.id, true);
    expect(await H.clearHistory(key, false)).toBe(1);
    expect((await H.listHistory(key)).map((e) => e.code)).toEqual(['b']);
    expect(await H.clearHistory(key, true)).toBe(1);
    expect(await H.listHistory(key)).toHaveLength(0);
  });

  it('deletes a single entry and persists the limit setting', async () => {
    const key = H.dbKeyFor('idb', 'shop');
    const e = (await H.recordRun(key, run('a'), 100))!;
    await H.deleteEntry(e.id);
    expect(await H.listHistory(key)).toHaveLength(0);
    expect(await H.getHistoryLimit()).toBe(100);
    expect(await H.setHistoryLimit(5)).toBe(10); // clamped
    expect(await H.setHistoryLimit(250)).toBe(250);
    expect(await H.getHistoryLimit()).toBe(250);
  });
});

describe('QueryBuilder.toCanonicalString', () => {
  it('is identical for equivalent queries and differs when values differ', async () => {
    const db = await WebDB.open({ name: 'canon', storage: 'memory' });
    await db.createTable('t', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'n', type: 'INT32' },
    ]);
    const limit = 5;
    const a = db.from('t').where('n', '>', 3).orderBy('id').limit(5).toCanonicalString();
    const b = db.from('t').where('n', '>', 1 + 2).orderBy('id', 'asc').limit(limit).toCanonicalString();
    const c = db.from('t').where('n', '>', 4).orderBy('id').limit(5).toCanonicalString();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const sub = db.from('t').whereIn('id', db.from('t').select('id').where('n', '=', 1)).toCanonicalString();
    expect(sub).toMatch(/value.{1,4}1/);
    const sub2 = db.from('t').whereIn('id', db.from('t').select('id').where('n', '=', 2)).toCanonicalString();
    expect(sub2).not.toBe(sub);
    expect(db.from('t').where('id', '=', 10n).toCanonicalString()).toContain('10n');
  });
});
