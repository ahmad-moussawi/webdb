import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { CostBasedPlanner } from '../src/host/compiler/planner/cost.js';
import { NoOpPlanner } from '../src/host/compiler/planner/noop.js';

describe('Interesting Orders & Sort Order Optimization', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'test_interesting_orders', storage: 'memory' });

    await db.createTable('scores', [
      { name: 'id', type: 'INT32', primaryKey: true, flags: { autoInc: true } },
      { name: 'player', type: 'TEXT' },
      { name: 'score', type: 'INT32' },
      { name: 'extra', type: 'TEXT' },
    ]);

    await db.createIndex('scores', 'score', { name: 'idx_player_score' });

    await db.insert('scores', { player: 'Alice', score: 90, extra: 'A' });
    await db.insert('scores', { player: 'Bob', score: 50, extra: 'B' });
    await db.insert('scores', { player: 'Charlie', score: 100, extra: 'C' });
    await db.insert('scores', { player: 'Dave', score: 75, extra: 'D' });
    await db.insert('scores', { player: 'Eve', score: 85, extra: 'E' });
  });

  it('bypasses in-arena sorter when index matches ORDER BY ASC', async () => {
    const explain = await db.from('scores').orderBy('score', 'asc').explain();
    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.indexName).toBe('idx_player_score');
    expect(explain.plan.isOrderSatisfied).toBe(true);

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).not.toContain('OP_SORTER_OPEN');
    expect(opcodes).not.toContain('OP_SORTER_SORT');
    expect(opcodes).not.toContain('OP_SORTER_INSERT');
    expect(opcodes).toContain('OP_OPEN_INDEX');
    expect(opcodes).toContain('OP_INDEX_SEEK_GE');
    expect(opcodes).toContain('OP_INDEX_NEXT');

    const rows = await db.from('scores').orderBy('score', 'asc').toArray();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.score)).toEqual([50, 75, 85, 90, 100]);
  });

  it('achieves Top-K early termination without sorting all rows', async () => {
    const explain = await db.from('scores').orderBy('score', 'asc').limit(2).explain();
    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.isOrderSatisfied).toBe(true);

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).not.toContain('OP_SORTER_OPEN');
    expect(opcodes).toContain('OP_LIMIT');

    const rows = await db.from('scores').orderBy('score', 'asc').limit(2).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.score)).toEqual([50, 75]);
    expect(rows.map((r) => r.player)).toEqual(['Bob', 'Dave']);
  });

  it('combines indexed range filter with ORDER BY without explicit sorter', async () => {
    const explain = await db
      .from('scores')
      .where('score', '>=', 85)
      .orderBy('score', 'asc')
      .explain();

    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.isOrderSatisfied).toBe(true);

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).not.toContain('OP_SORTER_OPEN');
    expect(opcodes).not.toContain('OP_SORTER_SORT');

    const rows = await db
      .from('scores')
      .where('score', '>=', 85)
      .orderBy('score', 'asc')
      .toArray();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.score)).toEqual([85, 90, 100]);
    expect(rows.map((r) => r.player)).toEqual(['Eve', 'Alice', 'Charlie']);
  });

  it('falls back to in-arena sorter for DESC order on forward index', async () => {
    const explain = await db.from('scores').orderBy('score', 'desc').limit(3).explain();
    expect(explain.plan.isOrderSatisfied).toBe(false);

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_SORTER_OPEN');
    expect(opcodes).toContain('OP_SORTER_INSERT');
    expect(opcodes).toContain('OP_SORTER_SORT');
    expect(opcodes).toContain('OP_SORTER_NEXT');

    const rows = await db.from('scores').orderBy('score', 'desc').limit(3).toArray();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.score)).toEqual([100, 90, 85]);
  });

  it('falls back to in-arena sorter when ordering by an unindexed column', async () => {
    const explain = await db.from('scores').orderBy('extra', 'asc').explain();
    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_SORTER_OPEN');
    expect(opcodes).toContain('OP_SORTER_SORT');

    const rows = await db.from('scores').orderBy('extra', 'asc').toArray();
    expect(rows.map((r) => r.extra)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('reports avoided sort cost and order satisfaction in CostBasedPlanner', async () => {
    const planner = new CostBasedPlanner();
    const explain = await db
      .from('scores')
      .orderBy('score', 'asc')
      .withPlanner(planner)
      .explain();

    expect(explain.plan.isOrderSatisfied).toBe(true);
    expect(explain.plan.sortCostAvoided).toBeGreaterThan(0);
  });

  it('satisfies ORDER BY on composite index when leading column is pinned by equality', async () => {
    await db.createTable('tenants', [
      { name: 'id', type: 'INT32', primaryKey: true, flags: { autoInc: true } },
      { name: 'tenant_id', type: 'INT32' },
      { name: 'val', type: 'INT32' },
      { name: 'note', type: 'TEXT' },
    ]);

    await db.createIndex('tenants', ['tenant_id', 'val'], { name: 'idx_tenant_val' });

    await db.insert('tenants', { tenant_id: 1, val: 30, note: 'T1-30' });
    await db.insert('tenants', { tenant_id: 2, val: 10, note: 'T2-10' });
    await db.insert('tenants', { tenant_id: 1, val: 10, note: 'T1-10' });
    await db.insert('tenants', { tenant_id: 1, val: 20, note: 'T1-20' });
    await db.insert('tenants', { tenant_id: 2, val: 50, note: 'T2-50' });

    const explain = await db
      .from('tenants')
      .where('tenant_id', '=', 1)
      .orderBy('val', 'asc')
      .explain();

    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.isOrderSatisfied).toBe(true);

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).not.toContain('OP_SORTER_OPEN');
    expect(opcodes).not.toContain('OP_SORTER_SORT');

    const rows = await db
      .from('tenants')
      .where('tenant_id', '=', 1)
      .orderBy('val', 'asc')
      .toArray();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.val)).toEqual([10, 20, 30]);
    expect(rows.map((r) => r.note)).toEqual(['T1-10', 'T1-20', 'T1-30']);
  });

  describe('Phase 2: Joins with Order Preservation', () => {
    let joinDb: WebDB;

    beforeEach(async () => {
      joinDb = await WebDB.open({ name: 'test_join_order_preservation', storage: 'memory' });

      await joinDb.createTable('users', [
        { name: 'id', type: 'INT32', primaryKey: true },
        { name: 'name', type: 'TEXT' },
        { name: 'score', type: 'INT32' },
      ]);
      await joinDb.createIndex('users', 'score', { name: 'idx_user_score' });

      await joinDb.createTable('orders', [
        { name: 'id', type: 'INT32', primaryKey: true },
        { name: 'user_id', type: 'INT32' },
        { name: 'amount', type: 'FLOAT64' },
      ]);
      await joinDb.createIndex('orders', 'user_id', { name: 'idx_order_user_id' });

      await joinDb.insert('users', { id: 1, name: 'Alice', score: 90 });
      await joinDb.insert('users', { id: 2, name: 'Bob', score: 50 });
      await joinDb.insert('users', { id: 3, name: 'Charlie', score: 100 });
      await joinDb.insert('users', { id: 4, name: 'Dave', score: 75 });
      await joinDb.insert('users', { id: 5, name: 'Eve', score: 60 });

      await joinDb.insert('orders', { id: 101, user_id: 1, amount: 99.9 });
      await joinDb.insert('orders', { id: 102, user_id: 2, amount: 49.9 });
      await joinDb.insert('orders', { id: 103, user_id: 3, amount: 199.9 });
      await joinDb.insert('orders', { id: 104, user_id: 4, amount: 79.9 });
    });

    it('preserves order in nested loop join when driving table has matching index', async () => {
      const explain = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'asc')
        .explain();

      expect(explain.plan.scanType).toBe('IndexScan');
      expect(explain.plan.indexName).toBe('idx_user_score');
      expect(explain.plan.isOrderSatisfied).toBe(true);
      expect(explain.plan.joins?.[0].scanType).toBe('IndexScan');
      expect(explain.plan.joins?.[0].indexName).toBe('idx_order_user_id');

      const opcodes = explain.instructions.map((i) => i.opcode);
      expect(opcodes).not.toContain('OP_SORTER_OPEN');
      expect(opcodes).not.toContain('OP_SORTER_SORT');
      expect(opcodes).toContain('OP_INDEX_SEEK_GE');
      expect(opcodes).toContain('OP_INDEX_NEXT');

      const rows = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'asc')
        .toArray();

      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.score)).toEqual([50, 75, 90, 100]);
      expect(rows.map((r) => r.name)).toEqual(['Bob', 'Dave', 'Alice', 'Charlie']);
    });

    it('supports Top-K early termination in joins without scanning all outer rows', async () => {
      const explain = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'asc')
        .limit(2)
        .explain();

      expect(explain.plan.isOrderSatisfied).toBe(true);
      const opcodes = explain.instructions.map((i) => i.opcode);
      expect(opcodes).toContain('OP_LIMIT');
      expect(opcodes).not.toContain('OP_SORTER_OPEN');

      const rows = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'asc')
        .limit(2)
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.score)).toEqual([50, 75]);
      expect(rows.map((r) => r.name)).toEqual(['Bob', 'Dave']);
    });

    it('automatically inverts driving table in CostBasedPlanner to preserve requested order', async () => {
      const explain = await joinDb
        .from('orders')
        .join('users', 'orders.user_id', '=', 'users.id')
        .orderBy('users.score', 'asc')
        .limit(2)
        .explain();

      expect(explain.plan.joinOrder).toEqual(['users', 'orders']);
      expect(explain.plan.scanType).toBe('IndexScan');
      expect(explain.plan.indexName).toBe('idx_user_score');
      expect(explain.plan.isOrderSatisfied).toBe(true);

      const rows = await joinDb
        .from('orders')
        .join('users', 'orders.user_id', '=', 'users.id')
        .orderBy('users.score', 'asc')
        .limit(2)
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.score)).toEqual([50, 75]);
    });

    it('falls back to JS sorting when ORDER BY references the inner table', async () => {
      const explain = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('orders.amount', 'asc')
        .limit(2)
        .explain();

      expect(explain.plan.isOrderSatisfied).toBe(false);

      const rows = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('orders.amount', 'asc')
        .limit(2)
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.amount)).toEqual([49.9, 79.9]);
      expect(rows.map((r) => r.name)).toEqual(['Bob', 'Dave']);
    });

    it('falls back to JS sorting when ORDER BY direction is DESC', async () => {
      const explain = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'desc')
        .limit(2)
        .explain();

      expect(explain.plan.isOrderSatisfied).toBe(false);

      const rows = await joinDb
        .from('users')
        .join('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'desc')
        .limit(2)
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.score)).toEqual([100, 90]);
      expect(rows.map((r) => r.name)).toEqual(['Charlie', 'Alice']);
    });

    it('preserves order in LEFT JOIN when driving table has matching index', async () => {
      // Eve has score 60 and no orders
      const explain = await joinDb
        .from('users')
        .leftJoin('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'asc')
        .explain();

      expect(explain.plan.isOrderSatisfied).toBe(true);

      const rows = await joinDb
        .from('users')
        .leftJoin('orders', 'users.id', '=', 'orders.user_id')
        .orderBy('users.score', 'asc')
        .toArray();

      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.score)).toEqual([50, 60, 75, 90, 100]);
      expect(rows.map((r) => r.name)).toEqual(['Bob', 'Eve', 'Dave', 'Alice', 'Charlie']);
      const eveRow = rows.find((r) => r.name === 'Eve');
      expect(eveRow?.amount).toBeNull();
    });
  });
});
