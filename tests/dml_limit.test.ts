import { describe, it, expect } from 'vitest';
import { WebDB, DataType, Changeset } from '../src/index.ts';
import { testEngine } from "./helpers/test_engine.js";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";

describe('DELETE and UPDATE with LIMIT', () => {
  it('QueryBuilder .limit(n).delete() respects limit across repeated calls and edge cases', async () => {
    const db = await WebDB.open({ name: 'qb_delete_limit_db', engine: testEngine(), storage: new MemoryStorage() });

    await db.createTable('tasks', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'status', type: DataType.TEXT },
      { name: 'code', type: DataType.TEXT },
    ]);
    await db.createIndex('tasks', 'status');
    await db.createIndex('tasks', 'code', { unique: true });

    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      status: i < 8 ? 'pending' : 'done',
      code: `T_${i + 1}`,
    }));
    await db.insertMany('tasks', rows);

    // limit(0), negative limit, and NaN must delete 0 rows
    expect(await db.from('tasks').where('status', '=', 'pending').limit(0).delete()).toBe(0);
    expect(await db.from('tasks').where('status', '=', 'pending').limit(-3).delete()).toBe(0);
    expect(await db.from('tasks').where('status', '=', 'pending').limit(Number.NaN).delete()).toBe(0);
    expect(await db.from('tasks').where('status', '=', 'pending').toArray()).toHaveLength(8);

    // Sequential limited deletes: 8 pending -> 3, 3, 2, 0
    expect(await db.from('tasks').where('status', '=', 'pending').limit(3).delete()).toBe(3);
    expect(await db.from('tasks').where('status', '=', 'pending').toArray()).toHaveLength(5);

    // Fractional limit floors to integer
    expect(await db.from('tasks').where('status', '=', 'pending').limit(2.9).delete()).toBe(2);
    expect(await db.from('tasks').where('status', '=', 'pending').toArray()).toHaveLength(3);

    // Limit larger than remaining matches deletes only remaining matches
    expect(await db.from('tasks').where('status', '=', 'pending').limit(10).delete()).toBe(3);
    expect(await db.from('tasks').where('status', '=', 'pending').toArray()).toHaveLength(0);

    // Further delete returns 0
    expect(await db.from('tasks').where('status', '=', 'pending').limit(2).delete()).toBe(0);

    // Non-matching rows ('done') must remain intact and findable via unique index
    const doneRows = await db.from('tasks').toArray();
    expect(doneRows.map((r) => r.id).sort((a, b) => a - b)).toEqual([9, 10]);
    expect((await db.from('tasks').where('code', '=', 'T_9').first())?.id).toBe(9);
    expect((await db.from('tasks').where('code', '=', 'T_10').first())?.id).toBe(10);

    await db.close();
  });

  it('QueryBuilder .limit(n).update() respects limit including page-overflow updates', async () => {
    const db = await WebDB.open({ name: 'qb_update_limit_db', engine: testEngine(), storage: new MemoryStorage() });

    await db.createTable('items', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'category', type: DataType.TEXT },
      { name: 'tag', type: DataType.TEXT },
      { name: 'payload', type: DataType.TEXT },
    ]);
    await db.createIndex('items', 'category');
    await db.createIndex('items', 'tag');

    // Pack 15 ~250B rows onto page 2 so expanding payloads triggers page overflow
    await db.insertMany(
      'items',
      Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        category: i < 12 ? 'alpha' : 'beta',
        tag: 'old',
        payload: 'x'.repeat(220),
      })),
    );

    // limit(0) and negative limit must update 0 rows
    expect(
      await db.from('items').where('category', '=', 'alpha').limit(0).update({ tag: 'new' }),
    ).toBe(0);
    expect(
      await db.from('items').where('category', '=', 'alpha').limit(-1).update({ tag: 'new' }),
    ).toBe(0);
    expect(await db.from('items').where('tag', '=', 'new').toArray()).toHaveLength(0);

    // In-place update with limit(4)
    const updated1 = await db
      .from('items')
      .where('category', '=', 'alpha')
      .where('tag', '=', 'old')
      .limit(4)
      .update({ tag: 'batch1' });
    expect(updated1).toBe(4);
    expect(await db.from('items').where('tag', '=', 'batch1').toArray()).toHaveLength(4);
    expect(await db.from('items').where('tag', '=', 'old').toArray()).toHaveLength(11);

    // Page-overflow update with limit(3) (expands payload to 1600B)
    const bigPayload = 'BIG_'.repeat(400);
    const updatedOverflow = await db
      .from('items')
      .where('category', '=', 'alpha')
      .where('tag', '=', 'old')
      .limit(3)
      .update({ tag: 'overflowed', payload: bigPayload });
    expect(updatedOverflow).toBe(3);

    const overflowedRows = await db.from('items').where('tag', '=', 'overflowed').toArray();
    expect(overflowedRows).toHaveLength(3);
    for (const r of overflowedRows) {
      expect(r.payload).toBe(bigPayload);
    }

    // Remaining 'alpha' + 'old' rows must be 12 - 4 - 3 = 5, and 'beta' rows untouched (3)
    expect(
      await db.from('items').where('category', '=', 'alpha').where('tag', '=', 'old').toArray(),
    ).toHaveLength(5);
    expect(await db.from('items').where('category', '=', 'beta').toArray()).toHaveLength(3);

    // Infinity limit updates all remaining matching rows
    const updatedRest = await db
      .from('items')
      .where('category', '=', 'alpha')
      .where('tag', '=', 'old')
      .limit(Infinity)
      .update({ tag: 'final' });
    expect(updatedRest).toBe(5);

    await db.close();
  });

  it('Direct db.delete() and db.update() options.limit respect limit', async () => {
    const db = await WebDB.open({ name: 'direct_dml_limit_db', engine: testEngine(), storage: new MemoryStorage() });

    await db.createTable('logs', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'level', type: DataType.TEXT },
      { name: 'processed', type: DataType.INT32 },
    ]);
    await db.createIndex('logs', 'level');

    await db.insertMany(
      'logs',
      Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        level: i % 2 === 0 ? 'warn' : 'info',
        processed: 0,
      })),
    );

    // Direct db.update with options.limit
    expect(
      await db.update('logs', { level: 'warn' }, { processed: 1 }, { limit: 0 }),
    ).toBe(0);
    expect(
      await db.update('logs', { level: 'warn' }, { processed: 1 }, { limit: 2 }),
    ).toBe(2);

    const processedWarns = await db
      .from('logs')
      .where('level', '=', 'warn')
      .where('processed', '=', 1)
      .toArray();
    expect(processedWarns).toHaveLength(2);

    // Direct db.delete with options.limit
    expect(await db.delete('logs', { level: 'info' }, { limit: 0 })).toBe(0);
    expect(await db.delete('logs', { level: 'info' }, { limit: 4 })).toBe(4);

    const remainingInfo = await db.from('logs').where('level', '=', 'info').toArray();
    expect(remainingInfo).toHaveLength(2);

    // Total rows: 6 warn + 2 info = 8
    expect(await db.from('logs').toArray()).toHaveLength(8);

    await db.close();
  });

  it('respects limit accurately when spanning multiple leaf data pages', async () => {
    const db = await WebDB.open({ name: 'multipage_dml_limit_db', engine: testEngine(), storage: new MemoryStorage() });

    await db.createTable('docs', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'group_name', type: DataType.TEXT },
      { name: 'state', type: DataType.INT32 },
      { name: 'body', type: DataType.TEXT },
    ]);
    await db.createIndex('docs', 'group_name');
    await db.createIndex('docs', 'state');

    // 60 rows * ~220 bytes each -> spans ~4 data leaf pages
    await db.insertMany(
      'docs',
      Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        group_name: i < 50 ? 'target' : 'keep',
        state: 0,
        body: 'b'.repeat(190),
      })),
    );

    // Update 25 rows across page boundaries
    const updated = await db
      .from('docs')
      .where('group_name', '=', 'target')
      .limit(25)
      .update({ state: 1 });
    expect(updated).toBe(25);
    expect(await db.from('docs').where('state', '=', 1).toArray()).toHaveLength(25);
    expect(
      await db.from('docs').where('group_name', '=', 'target').where('state', '=', 0).toArray(),
    ).toHaveLength(25);

    // Delete 30 rows across page boundaries
    const deleted = await db
      .from('docs')
      .where('group_name', '=', 'target')
      .limit(30)
      .delete();
    expect(deleted).toBe(30);
    expect(await db.from('docs').where('group_name', '=', 'target').toArray()).toHaveLength(20);
    expect(await db.from('docs').where('group_name', '=', 'keep').toArray()).toHaveLength(10);
    expect(await db.from('docs').toArray()).toHaveLength(30);

    await db.close();
  });

  it('records at most limit mutations in changesets, hooks, and transactions with rollback', async () => {
    const db = await WebDB.open({ name: 'tx_hooks_dml_limit_db', engine: testEngine(), storage: new MemoryStorage() });

    await db.createTable('accounts', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'tier', type: DataType.TEXT },
      { name: 'active', type: DataType.INT32 },
    ]);
    await db.createIndex('accounts', 'tier');

    await db.insertMany(
      'accounts',
      Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        tier: 'free',
        active: 1,
      })),
    );

    const commits: Changeset[] = [];
    db.onCommit((cs) => {
      commits.push(cs);
    });
    // Register a beforeCommit hook to exercise the auto-wrapped transaction path
    const unsubBefore = db.onBeforeCommit(() => {});

    expect(
      await db.from('accounts').where('tier', '=', 'free').limit(3).update({ active: 0 }),
    ).toBe(3);
    expect(commits).toHaveLength(1);
    expect(commits[0].changes).toHaveLength(3);
    expect(commits[0].changes.every((c) => c.op === 'update')).toBe(true);

    expect(await db.delete('accounts', { tier: 'free' }, { limit: 2 })).toBe(2);
    expect(commits).toHaveLength(2);
    expect(commits[1].changes).toHaveLength(2);
    expect(commits[1].changes.every((c) => c.op === 'delete')).toBe(true);

    unsubBefore();

    // Explicit transaction rollback restores limited updates/deletes
    await expect(
      db.transaction(async (tx) => {
        expect(await tx.from('accounts').limit(2).update({ tier: 'pro' })).toBe(2);
        expect(await tx.delete('accounts', { tier: 'free' }, { limit: 2 })).toBe(2);
        throw new Error('abort tx');
      }),
    ).rejects.toThrow('abort tx');

    expect(await db.from('accounts').where('tier', '=', 'free').toArray()).toHaveLength(6);
    expect(await db.from('accounts').where('tier', '=', 'pro').toArray()).toHaveLength(0);

    await db.close();
  });
});
