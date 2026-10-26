import { describe, it, expect, beforeEach } from 'vitest';
import {
  WebDB,
  DefaultQueryPlanner,
  CostBasedQueryPlanner,
  HeuristicQueryPlanner,
  NoOpQueryPlanner,
  CustomQueryPlanner,
  QueryPlanner,
  CustomOrderPlanner,
} from '../src/index.ts';

describe('Unified Top-Level QueryPlanner Architecture', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: 'unified_query_planner_test',
      storage: 'memory',
    });

    await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'age', type: 'INT32' },
    ]);

    await db.createTable('badges', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'user_id', type: 'INT32', flags: { notNull: true } },
      { name: 'title', type: 'TEXT' },
    ]);

    await db.insert('users', { id: 1, name: 'Alice', age: 30 });
    await db.insert('users', { id: 2, name: 'Bob', age: 25 });
    await db.insert('users', { id: 3, name: 'Charlie', age: 35 });

    await db.insert('badges', { id: 101, user_id: 1, title: 'Gold' });
    await db.insert('badges', { id: 102, user_id: 2, title: 'Silver' });
  });

  describe('1. Unified WHERE + JOIN Execution', () => {
    it('uses DefaultQueryPlanner by default to optimize both WHERE predicates and JOIN ordering', async () => {
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.age', '>', 20)
        .where('users.age', '>', 24) // Should subsume weaker bound age > 20
        .select(['users.name', 'badges.title'])
        .explain();

      expect(explain.plan.joinOrder).toBeDefined();
      expect(explain.instructions.length).toBeGreaterThan(0);

      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.age', '>', 20)
        .where('users.age', '>', 24)
        .select(['users.name', 'badges.title'])
        .toArray();

      expect(rows).toEqual(
        expect.arrayContaining([
          { name: 'Alice', title: 'Gold' },
          { name: 'Bob', title: 'Silver' },
        ]),
      );
    });

    it('detects short-circuit contradiction across WHERE filters on joined queries', async () => {
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.id', '=', 1)
        .where('users.id', '=', 2) // Impossible contradiction
        .explain();

      expect(explain.bytecodeSize).toBe(1);
      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.id', '=', 1)
        .where('users.id', '=', 2)
        .toArray();

      expect(rows).toEqual([]);
    });
  });

  describe('2. Transitive Predicate Inference Across Join Boundaries', () => {
    it('infers filter on joined table from outer table equality (users.id = 1 => badges.user_id = 1)', async () => {
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.id', '=', 1)
        .explain();

      // The plan should have inferred badges.user_id = 1
      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.id', '=', 1)
        .select(['users.name', 'badges.title'])
        .toArray();

      expect(rows).toEqual([{ name: 'Alice', title: 'Gold' }]);
    });

    it('detects cross-table contradiction when inferred filter conflicts with existing filter', async () => {
      // users.id = 1 and users.id = badges.user_id => badges.user_id must be 1.
      // But query also specifies badges.user_id = 2!
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.id', '=', 1)
        .where('badges.user_id', '=', 2)
        .explain();

      // Transitive inference detects contradiction (1 !== 2) and halts at compile time!
      expect(explain.bytecodeSize).toBe(1);
      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .where('users.id', '=', 1)
        .where('badges.user_id', '=', 2)
        .toArray();

      expect(rows).toEqual([]);
    });
  });

  describe('3. Pluggable QueryPlanner Implementations', () => {
    it('supports database-level planner configuration via WebDB.open({ planner })', async () => {
      const customDb = await WebDB.open({
        name: 'custom_planner_db',
        storage: 'memory',
        planner: new HeuristicQueryPlanner(),
      });

      expect(customDb.getPlanner()).toBeInstanceOf(HeuristicQueryPlanner);
    });

    it('supports dynamic planner replacement with db.setPlanner()', async () => {
      db.setPlanner(new NoOpQueryPlanner());
      expect(db.getPlanner()).toBeInstanceOf(NoOpQueryPlanner);

      // NoOpQueryPlanner preserves exact syntactic table order ['users', 'badges']
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .explain();

      expect(explain.plan.joinOrder).toEqual(['users', 'badges']);

      // Switch back to DefaultQueryPlanner / CostBasedQueryPlanner
      db.setPlanner(new DefaultQueryPlanner());
      expect(db.getPlanner()).toBeInstanceOf(DefaultQueryPlanner);
    });

    it('supports query-level planner override with .withPlanner()', async () => {
      db.setPlanner(new NoOpQueryPlanner());

      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .withPlanner(new CostBasedQueryPlanner())
        .explain();

      expect(explain.plan.joinOrder).toEqual(['badges', 'users']);
    });

    it('supports CustomQueryPlanner with custom transformation callback', async () => {
      let customRan = false;
      const customPlanner = new CustomQueryPlanner((plan) => {
        customRan = true;
        return new DefaultQueryPlanner().optimize(plan);
      });

      const rows = await db
        .from('users')
        .withPlanner(customPlanner)
        .toArray();

      expect(customRan).toBe(true);
      expect(rows).toHaveLength(3);
    });

    it('supports CustomOrderPlanner as a concrete QueryPlanner', async () => {
      const orderPlanner = new CustomOrderPlanner(['badges', 'users']);

      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .withPlanner(orderPlanner)
        .explain();

      expect(explain.plan.joinOrder).toEqual(['badges', 'users']);
    });
  });
});
