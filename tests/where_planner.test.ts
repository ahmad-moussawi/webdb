import { describe, it, expect, beforeEach } from 'vitest';
import {
  WebDB,
  CostBasedPlanner,
  NoOpPlanner,
  CustomPlanner,
} from '../src/index.ts';

describe('Dedicated WherePlanner Architecture', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: 'where_planner_test',
      storage: 'memory',
    });

    await db.createTable('products', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'category', type: 'TEXT' },
      { name: 'price', type: 'FLOAT64' },
      { name: 'stock', type: 'INT32' },
    ]);

    await db.insert('products', { id: 1, name: 'MacBook Pro', category: 'Laptops', price: 2000.0, stock: 15 });
    await db.insert('products', { id: 2, name: 'iPhone 15', category: 'Phones', price: 1000.0, stock: 50 });
    await db.insert('products', { id: 3, name: 'iPad Air', category: 'Tablets', price: 600.0, stock: 0 });
    await db.insert('products', { id: 4, name: 'AirPods Pro', category: null, price: 250.0, stock: 100 });
  });

  describe('1. Contradiction Detection (Short-Circuit Halting)', () => {
    it('detects conflicting equality values on the same column (id = 1 AND id = 2)', async () => {
      const explain = await db
        .from('products')
        .where('id', '=', 1)
        .where('id', '=', 2)
        .explain();

      // Short-circuits immediately with OP_HALT bytecode (size: 1 byte)
      expect(explain.bytecodeSize).toBe(1);
      expect(explain.instructions).toHaveLength(1);
      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('products')
        .where('id', '=', 1)
        .where('id', '=', 2)
        .toArray();

      expect(rows).toEqual([]);
    });

    it('detects conflicting IS NULL and IS NOT NULL', async () => {
      const explain = await db
        .from('products')
        .whereNull('category')
        .whereNotNull('category')
        .explain();

      expect(explain.bytecodeSize).toBe(1);
      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('products')
        .whereNull('category')
        .whereNotNull('category')
        .toArray();

      expect(rows).toEqual([]);
    });

    it('detects conflicting IS NULL and value comparison', async () => {
      const rows = await db
        .from('products')
        .whereNull('category')
        .where('category', '=', 'Phones')
        .toArray();

      expect(rows).toEqual([]);
    });

    it('detects impossible range contradiction (price > 1500 AND price < 500)', async () => {
      const explain = await db
        .from('products')
        .where('price', '>', 1500)
        .where('price', '<', 500)
        .explain();

      expect(explain.bytecodeSize).toBe(1);
      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('products')
        .where('price', '>', 1500)
        .where('price', '<', 500)
        .toArray();

      expect(rows).toEqual([]);
    });

    it('detects equality value violating upper range bound (price = 2000 AND price < 1000)', async () => {
      const explain = await db
        .from('products')
        .where('price', '=', 2000)
        .where('price', '<', 1000)
        .explain();

      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('products')
        .where('price', '=', 2000)
        .where('price', '<', 1000)
        .toArray();

      expect(rows).toEqual([]);
    });

    it('detects equality value not present in IN list (id = 5 AND id IN (1, 2, 3))', async () => {
      const explain = await db
        .from('products')
        .where('id', '=', 5)
        .whereIn('id', [1, 2, 3])
        .explain();

      expect(explain.instructions[0].opcode).toBe('OP_HALT');

      const rows = await db
        .from('products')
        .where('id', '=', 5)
        .whereIn('id', [1, 2, 3])
        .toArray();

      expect(rows).toEqual([]);
    });

    it('detects mutually exclusive IN lists (id IN (1, 2) AND id IN (3, 4))', async () => {
      const explain = await db
        .from('products')
        .whereIn('id', [1, 2])
        .whereIn('id', [3, 4])
        .explain();

      expect(explain.instructions[0].opcode).toBe('OP_HALT');
    });
  });

  describe('2. Redundancy Elimination & Filter Subsumption', () => {
    it('prunes exact duplicate filters (stock > 10 AND stock > 10)', async () => {
      const explain = await db
        .from('products')
        .where('stock', '>', 10)
        .where('stock', '>', 10)
        .explain();

      // Only one OP_GT comparison instruction generated in loop
      const gtInstructions = explain.instructions.filter((i) => i.opcode === 'OP_GT');
      expect(gtInstructions).toHaveLength(1);

      const rows = await db
        .from('products')
        .where('stock', '>', 10)
        .where('stock', '>', 10)
        .toArray();

      expect(rows).toHaveLength(3);
    });

    it('subsumes redundant IS NOT NULL when equality filter is present on non-null literal', async () => {
      const explain = await db
        .from('products')
        .whereNotNull('category')
        .where('category', '=', 'Phones')
        .explain();

      // IS NOT NULL is completely pruned; only equality check is retained
      const isNullInstructions = explain.instructions.filter((i) => i.opcode === 'OP_IS_NULL');
      expect(isNullInstructions).toHaveLength(0);

      const rows = await db
        .from('products')
        .whereNotNull('category')
        .where('category', '=', 'Phones')
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('iPhone 15');
    });

    it('subsumes weaker range filters (price > 500 AND price > 1000 => price > 1000)', async () => {
      const explain = await db
        .from('products')
        .where('price', '>', 500)
        .where('price', '>', 1000)
        .explain();

      // Only one range filter should be emitted
      const filterComparisons = explain.instructions.filter((i) => i.opcode === 'OP_GT');
      expect(filterComparisons).toHaveLength(1);

      const rows = await db
        .from('products')
        .where('price', '>', 500)
        .where('price', '>', 1000)
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('MacBook Pro');
    });

    it('subsumes redundant IN list when equality value is already within the list', async () => {
      const explain = await db
        .from('products')
        .where('id', '=', 2)
        .whereIn('id', [1, 2, 3])
        .explain();

      // IN list check is pruned; only equality is checked
      const inInstructions = explain.instructions.filter((i) => i.opcode === 'OP_IN_SET');
      expect(inInstructions).toHaveLength(0);

      const rows = await db
        .from('products')
        .where('id', '=', 2)
        .whereIn('id', [1, 2, 3])
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(2);
    });
  });

  describe('3. Cost-Based Predicate Reordering', () => {
    it('orders cheaper checks (null & numeric) before expensive checks (LIKE string search)', async () => {
      // Query declared with expensive LIKE first, followed by cheap null check and integer comparison
      const explain = await db
        .from('products')
        .where('name', 'LIKE', '%Pro%')
        .whereNotNull('category')
        .where('stock', '>', 5)
        .explain();

      // Find the instruction indices inside the scan loop
      const isNullIdx = explain.instructions.findIndex((i) => i.opcode === 'OP_IS_NULL');
      const stockCmpIdx = explain.instructions.findIndex((i) => i.opcode === 'OP_GT');
      const likeCmpIdx = explain.instructions.findIndex((i) => i.opcode === 'OP_STR_LIKE');

      // Assert that cheap checks run before expensive string pattern matching
      expect(isNullIdx).toBeGreaterThan(-1);
      expect(stockCmpIdx).toBeGreaterThan(-1);
      expect(likeCmpIdx).toBeGreaterThan(-1);

      expect(isNullIdx).toBeLessThan(likeCmpIdx);
      expect(stockCmpIdx).toBeLessThan(likeCmpIdx);

      const rows = await db
        .from('products')
        .where('name', 'LIKE', '%Pro%')
        .whereNotNull('category')
        .where('stock', '>', 5)
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('MacBook Pro');
    });
  });

  describe('4. Pluggable Configuration & Overrides', () => {
    it('supports database-level default Planner', async () => {
      const customDb = await WebDB.open({
        name: 'custom_where_db',
        storage: 'memory',
        planner: new CostBasedPlanner(),
      });

      expect(customDb.getPlanner()).toBeInstanceOf(CostBasedPlanner);
    });

    it('allows changing Planner dynamically with db.setPlanner()', async () => {
      db.setPlanner(new NoOpPlanner());
      expect(db.getPlanner()).toBeInstanceOf(NoOpPlanner);

      // With NoOpPlanner, contradiction is not pruned into OP_HALT at compile time
      const explain = await db
        .from('products')
        .where('price', '>', 1500)
        .where('price', '<', 500)
        .explain();

      expect(explain.instructions[0].opcode).not.toBe('OP_HALT');
    });

    it('supports per-query override with .withPlanner()', async () => {
      db.setPlanner(new NoOpPlanner());

      // Query overrides with CostBasedPlanner
      const explain = await db
        .from('products')
        .where('price', '>', 1500)
        .where('price', '<', 500)
        .withPlanner(new CostBasedPlanner())
        .explain();

      expect(explain.instructions[0].opcode).toBe('OP_HALT');
    });

    it('supports CustomPlanner with custom rewrite function', async () => {
      let customInvoked = false;
      const customPlanner = new CustomPlanner((plan) => {
        customInvoked = true;
        return new CostBasedPlanner().optimize(plan);
      });

      await db
        .from('products')
        .where('stock', '>', 0)
        .withPlanner(customPlanner)
        .toArray();

      expect(customInvoked).toBe(true);
    });
  });
});
