import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB, DataType, col, fn } from '../src/index.js';

describe('Vectorized UDF Batching & ORDER BY Workflows', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      storage: 'memory',
      name: `test_udf_batch_${Math.random().toString(36).slice(2)}`,
    });
  });

  describe('1. Basic ORDER BY with Batched UDFs', () => {
    beforeEach(async () => {
      await db.createTable('products', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'name', type: DataType.TEXT },
        { name: 'price', type: DataType.FLOAT64 },
        { name: 'category', type: DataType.TEXT },
      ]);

      await db.insertMany('products', [
        { id: 1, name: 'Wireless Headphones', price: 99.99, category: 'Audio' },
        { id: 2, name: 'USB-C Cable', price: 12.50, category: 'Accessories' },
        { id: 3, name: 'Mechanical Keyboard', price: 149.00, category: 'Accessories' },
        { id: 4, name: 'Studio Monitor', price: 299.99, category: 'Audio' },
        { id: 5, name: 'Gaming Mouse', price: 59.99, category: 'Accessories' },
        { id: 6, name: 'Webcam 4K', price: 129.99, category: 'Video' },
        { id: 7, name: 'Budget Earbuds', price: 19.99, category: 'Audio' },
        { id: 8, name: 'Desk Mat', price: 25.00, category: 'Accessories' },
      ]);
    });

    it('sorts ASC and DESC by a batched numeric UDF alias', async () => {
      let batchCalls = 0;
      let totalItems = 0;

      // Custom tax computation UDF
      db.registerBatchedFunction('calc_tax', (argsBatch) => {
        batchCalls++;
        totalItems += argsBatch.length;
        return argsBatch.map(([price]) => Math.round(Number(price) * 0.2 * 100) / 100);
      }, { returnType: DataType.FLOAT64 });

      batchCalls = 0;
      totalItems = 0;

      // 1. ORDER BY tax DESC
      const descRows = await db
        .from('products')
        .select(['id', 'name', 'price', 'calc_tax(price) as tax'])
        .orderBy('tax', 'desc')
        .toArray();

      expect(descRows.length).toBe(8);
      expect(descRows[0].name).toBe('Studio Monitor'); // price 299.99 -> tax 60
      expect(descRows[0].tax).toBe(60);
      expect(descRows[7].name).toBe('USB-C Cable'); // price 12.50 -> tax 2.5
      expect(descRows[7].tax).toBe(2.5);
      expect(batchCalls).toBeGreaterThan(0);
      expect(totalItems).toBe(8);

      // Verify strict descending monotonicity
      for (let i = 0; i < descRows.length - 1; i++) {
        expect(descRows[i].tax).toBeGreaterThanOrEqual(descRows[i + 1].tax);
      }

      // 2. ORDER BY tax ASC
      const ascRows = await db
        .from('products')
        .select(['id', 'name', 'price', 'calc_tax(price) as tax'])
        .orderBy('tax', 'asc')
        .toArray();

      expect(ascRows.length).toBe(8);
      expect(ascRows[0].name).toBe('USB-C Cable');
      expect(ascRows[7].name).toBe('Studio Monitor');
      for (let i = 0; i < ascRows.length - 1; i++) {
        expect(ascRows[i].tax).toBeLessThanOrEqual(ascRows[i + 1].tax);
      }
    });

    it('sorts by a batched string formatting UDF', async () => {
      db.registerBatchedFunction('slugify', (argsBatch) => {
        return argsBatch.map(([name]) =>
          String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')
        );
      });

      const rows = await db
        .from('products')
        .select(['id', 'name', 'slugify(name) as slug'])
        .orderBy('slug', 'asc')
        .toArray();

      expect(rows.length).toBe(8);
      expect(rows[0].slug).toBe('budget-earbuds');
      expect(rows[rows.length - 1].slug).toBe('wireless-headphones');

      for (let i = 0; i < rows.length - 1; i++) {
        expect(rows[i].slug.localeCompare(rows[i + 1].slug)).toBeLessThanOrEqual(0);
      }
    });

    it('supports multi-key ORDER BY combining batched UDF and physical columns', async () => {
      // Products with duplicate rounded prices to test secondary sort
      await db.insertMany('products', [
        { id: 9, name: 'Bluetooth Dongle', price: 25.00, category: 'Accessories' },
        { id: 10, name: 'Cable Organizer', price: 25.00, category: 'Accessories' },
      ]);

      db.registerBatchedFunction('round_price', (argsBatch) => {
        return argsBatch.map(([p]) => Math.round(Number(p)));
      });

      // Sort by rounded price DESC, then by name ASC
      const rows = await db
        .from('products')
        .select(['id', 'name', 'price', 'round_price(price) as r_price'])
        .orderBy('r_price', 'desc')
        .orderBy('name', 'asc')
        .toArray();

      expect(rows.length).toBe(10);

      // Find the 3 items with price ~25
      const price25Items = rows.filter((r) => r.r_price === 25);
      expect(price25Items.length).toBe(3);
      // Secondary sort check: Bluetooth Dongle, Cable Organizer, Desk Mat
      expect(price25Items.map((r) => r.name)).toEqual([
        'Bluetooth Dongle',
        'Cable Organizer',
        'Desk Mat',
      ]);
    });

    it('correctly handles NULL values with nulls_first and nulls_last in batched UDF sorting', async () => {
      await db.insertMany('products', [
        { id: 11, name: 'Unknown Item 1', price: 0, category: 'Misc' },
        { id: 12, name: 'Unknown Item 2', price: 0, category: 'Misc' },
      ]);

      // Returns null for price <= 0
      db.registerBatchedFunction('safe_log_price', (argsBatch) => {
        return argsBatch.map(([p]) => {
          const num = Number(p);
          return num > 0 ? Math.round(Math.log10(num) * 100) / 100 : null;
        });
      });

      // 1. nulls_first
      const nullsFirst = await db
        .from('products')
        .select(['id', 'name', 'safe_log_price(price) as log_p'])
        .orderBy('log_p', 'desc', 'nulls_first')
        .toArray();

      expect(nullsFirst[0].log_p).toBeNull();
      expect(nullsFirst[1].log_p).toBeNull();
      expect(nullsFirst[2].log_p).not.toBeNull();

      // 2. nulls_last
      const nullsLast = await db
        .from('products')
        .select(['id', 'name', 'safe_log_price(price) as log_p'])
        .orderBy('log_p', 'desc', 'nulls_last')
        .toArray();

      expect(nullsLast[nullsLast.length - 1].log_p).toBeNull();
      expect(nullsLast[nullsLast.length - 2].log_p).toBeNull();
      expect(nullsLast[0].log_p).not.toBeNull();
    });

    it('applies LIMIT and OFFSET after batched UDF sorting', async () => {
      db.registerBatchedFunction('calc_tax', (argsBatch) => {
        return argsBatch.map(([price]) => Math.round(Number(price) * 0.2 * 100) / 100);
      });

      // Get page 2: top items 3 and 4 by tax
      const paged = await db
        .from('products')
        .select(['id', 'name', 'calc_tax(price) as tax'])
        .orderBy('tax', 'desc')
        .offset(2)
        .limit(2)
        .toArray();

      expect(paged.length).toBe(2);
      // Top 1: Studio Monitor (60)
      // Top 2: Mechanical Keyboard (29.8)
      // Top 3: Webcam 4K (26)
      // Top 4: Wireless Headphones (20)
      expect(paged[0].name).toBe('Webcam 4K');
      expect(paged[0].tax).toBe(26);
      expect(paged[1].name).toBe('Wireless Headphones');
      expect(paged[1].tax).toBe(20);
    });
  });

  describe('2. Nested FROM Subqueries with Batched UDFs & ORDER BY', () => {
    beforeEach(async () => {
      await db.createTable('metrics', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'sensor', type: DataType.TEXT },
        { name: 'value', type: DataType.FLOAT64 },
        { name: 'active', type: DataType.INT32 },
      ]);

      await db.insertMany('metrics', [
        { id: 1, sensor: 'temp_1', value: 24.5, active: 1 },
        { id: 2, sensor: 'temp_2', value: 31.2, active: 1 },
        { id: 3, sensor: 'temp_3', value: 18.0, active: 0 },
        { id: 4, sensor: 'temp_4', value: 28.9, active: 1 },
        { id: 5, sensor: 'temp_5', value: 35.6, active: 1 },
        { id: 6, sensor: 'temp_6', value: 22.1, active: 0 },
      ]);
    });

    it('executes batched UDF in inner subquery and orders by it in outer query', async () => {
      let batchCalls = 0;
      db.registerBatchedFunction('celsius_to_fahr', (argsBatch) => {
        batchCalls++;
        return argsBatch.map(([c]) => Math.round((Number(c) * 9 / 5 + 32) * 10) / 10);
      });

      const inner = db
        .from('metrics')
        .select(['id', 'sensor', 'value', 'celsius_to_fahr(value) as fahr'])
        .where('active', '=', 1);

      const outer = await db
        .from(inner)
        .select(['id', 'sensor', 'fahr'])
        .orderBy('fahr', 'desc')
        .toArray();

      expect(outer.length).toBe(4);
      expect(outer[0].sensor).toBe('temp_5'); // 35.6 C -> 96.1 F
      expect(outer[0].fahr).toBe(96.1);
      expect(outer[3].sensor).toBe('temp_1'); // 24.5 C -> 76.1 F
      expect(outer[3].fahr).toBe(76.1);
      expect(batchCalls).toBeGreaterThan(0);
    });

    it('executes batched UDF in outer query over materialized inner subquery with LIMIT/OFFSET', async () => {
      db.registerBatchedFunction('score_sensor', (argsBatch) => {
        return argsBatch.map(([v]) => Math.round(Number(v) * 2));
      });

      // Materialized subquery with inner limit/offset (cannot be flattened)
      const inner = db
        .from('metrics')
        .where('active', '=', 1)
        .orderBy('value', 'desc')
        .limit(3);

      const outer = await db
        .from(inner)
        .select(['id', 'sensor', 'score_sensor(value) as score'])
        .orderBy('score', 'asc')
        .toArray();

      expect(outer.length).toBe(3);
      // Inner top 3 values desc: temp_5 (35.6), temp_2 (31.2), temp_4 (28.9)
      // Outer ordered asc by score: temp_4 (58), temp_2 (62), temp_5 (71)
      expect(outer[0].sensor).toBe('temp_4');
      expect(outer[0].score).toBe(58);
      expect(outer[1].sensor).toBe('temp_2');
      expect(outer[1].score).toBe(62);
      expect(outer[2].sensor).toBe('temp_5');
      expect(outer[2].score).toBe(71);
    });

    it('supports 3 levels of nested subqueries with batched UDFs and outer ORDER BY', async () => {
      db.registerBatchedFunction('add_ten', (argsBatch) => {
        return argsBatch.map(([x]) => Number(x) + 10);
      });
      db.registerBatchedFunction('mult_two', (argsBatch) => {
        return argsBatch.map(([x]) => Number(x) * 2);
      });

      // Level 1: active filters
      const l1 = db.from('metrics').where('active', '=', 1);
      // Level 2: add_ten
      const l2 = db.from(l1).select(['id', 'sensor', 'add_ten(value) as v1']);
      // Level 3: mult_two
      const l3 = db.from(l2).select(['id', 'sensor', 'mult_two(v1) as v2']);

      const finalRows = await db
        .from(l3)
        .select(['id', 'sensor', 'v2'])
        .orderBy('v2', 'desc')
        .limit(2)
        .toArray();

      expect(finalRows.length).toBe(2);
      // temp_5: (35.6 + 10) * 2 = 91.2
      // temp_2: (31.2 + 10) * 2 = 82.4
      expect(finalRows[0].sensor).toBe('temp_5');
      expect(finalRows[0].v2).toBeCloseTo(91.2, 1);
      expect(finalRows[1].sensor).toBe('temp_2');
      expect(finalRows[1].v2).toBeCloseTo(82.4, 1);
    });
  });

  describe('3. ORDER BY with JOINs & Batched UDFs', () => {
    beforeEach(async () => {
      await db.createTable('users', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'name', type: DataType.TEXT },
        { name: 'country', type: DataType.TEXT },
      ]);

      await db.createTable('purchases', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'user_id', type: DataType.INT32 },
        { name: 'amount', type: DataType.FLOAT64 },
        { name: 'currency', type: DataType.TEXT },
      ]);

      await db.insertMany('users', [
        { id: 1, name: 'Alice Smith', country: 'US' },
        { id: 2, name: 'Bob Jones', country: 'UK' },
        { id: 3, name: 'Charlie Brown', country: 'DE' },
        { id: 4, name: 'Diana Prince', country: 'FR' },
      ]);

      await db.insertMany('purchases', [
        { id: 101, user_id: 1, amount: 250.0, currency: 'USD' },
        { id: 102, user_id: 2, amount: 150.0, currency: 'GBP' },
        { id: 103, user_id: 1, amount: 450.0, currency: 'USD' },
        { id: 104, user_id: 3, amount: 80.0, currency: 'EUR' },
        { id: 105, user_id: 2, amount: 300.0, currency: 'GBP' },
      ]);
    });

    it('joins tables and sorts by a batched UDF combining columns from both tables', async () => {
      let batchCalls = 0;
      db.registerBatchedFunction('user_purchase_label', (argsBatch) => {
        batchCalls++;
        return argsBatch.map(([userName, amount]) => `${userName}: $${amount}`);
      });

      const rows = await db
        .from('purchases')
        .join('users', 'purchases.user_id', '=', 'users.id')
        .select([
          'purchases.id as purchase_id',
          'users.name as user_name',
          'purchases.amount as amount',
          'user_purchase_label(users.name, purchases.amount) as label',
        ])
        .orderBy('purchases.amount', 'desc')
        .toArray();

      expect(rows.length).toBe(5);
      expect(rows[0].purchase_id).toBe(103);
      expect(rows[0].label).toBe('Alice Smith: $450');
      expect(rows[1].purchase_id).toBe(105);
      expect(rows[1].label).toBe('Bob Jones: $300');
      expect(batchCalls).toBeGreaterThan(0);
    });

    it('sorts joined rows directly by a batched UDF alias with LIMIT and OFFSET', async () => {
      // Computes currency-converted USD estimated value
      db.registerBatchedFunction('to_usd', (argsBatch) => {
        return argsBatch.map(([amount, curr]) => {
          const a = Number(amount);
          if (curr === 'GBP') return Math.round(a * 1.3);
          if (curr === 'EUR') return Math.round(a * 1.1);
          return Math.round(a);
        });
      });

      // GBP 300 -> 390
      // USD 450 -> 450
      // USD 250 -> 250
      // GBP 150 -> 195
      // EUR 80  -> 88
      const topPurchases = await db
        .from('purchases')
        .join('users', 'purchases.user_id', '=', 'users.id')
        .select([
          'purchases.id as id',
          'users.name as name',
          'to_usd(purchases.amount, purchases.currency) as usd_val',
        ])
        .orderBy('usd_val', 'desc')
        .limit(3)
        .toArray();

      expect(topPurchases.length).toBe(3);
      expect(topPurchases[0].id).toBe(103); // 450 USD
      expect(topPurchases[0].usd_val).toBe(450);
      expect(topPurchases[1].id).toBe(105); // 300 GBP -> 390 USD
      expect(topPurchases[1].usd_val).toBe(390);
      expect(topPurchases[2].id).toBe(101); // 250 USD
      expect(topPurchases[2].usd_val).toBe(250);
    });

    it('supports LEFT JOIN with batched UDF handling null values from unmatched rows', async () => {
      // Diana Prince (id: 4) has 0 purchases
      db.registerBatchedFunction('purchase_status', (argsBatch) => {
        return argsBatch.map(([amount]) => (amount !== null && amount !== undefined ? 'BUYER' : 'LEAD'));
      });

      const rows = await db
        .from('users')
        .leftJoin('purchases', 'users.id', '=', 'purchases.user_id')
        .select([
          'users.id as user_id',
          'users.name as user_name',
          'purchase_status(purchases.amount) as status',
        ])
        .orderBy('status', 'asc') // 'BUYER' before 'LEAD'
        .orderBy('users.id', 'asc')
        .toArray();

      expect(rows.length).toBe(6); // 5 purchases + 1 unmatched Diana
      const leadRow = rows.find((r) => r.user_name === 'Diana Prince');
      expect(leadRow).toBeDefined();
      expect(leadRow?.status).toBe('LEAD');
    });
  });

  describe('4. Large Dataset Vector Execution & Chunking (2,000+ Rows)', () => {
    const TOTAL_ROWS = 2500;

    beforeEach(async () => {
      await db.createTable('benchmark_items', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'val', type: DataType.FLOAT64 },
        { name: 'tag', type: DataType.TEXT },
      ]);

      const items = [];
      for (let i = 1; i <= TOTAL_ROWS; i++) {
        // Deterministic pseudo-random distribution
        const val = ((i * 137 + 43) % 10000) / 10;
        items.push({
          id: i,
          val,
          tag: i % 2 === 0 ? 'even' : 'odd',
        });
      }
      await db.insertMany('benchmark_items', items);
    });

    it('processes rows strictly in chunks of at most 128 elements and matches array sort reference', async () => {
      let batchCalls = 0;
      const chunkSizes: number[] = [];
      let totalProcessed = 0;

      // Nonlinear polynomial score: 3*val^2 - 5*val + 17
      db.registerBatchedFunction('poly_score', (argsBatch) => {
        batchCalls++;
        chunkSizes.push(argsBatch.length);
        totalProcessed += argsBatch.length;
        return argsBatch.map(([v]) => {
          const x = Number(v);
          return Math.round((3 * x * x - 5 * x + 17) * 100) / 100;
        });
      }, { returnType: DataType.FLOAT64 });

      batchCalls = 0;
      chunkSizes.length = 0;
      totalProcessed = 0;

      const rows = await db
        .from('benchmark_items')
        .select(['id', 'val', 'poly_score(val) as score'])
        .orderBy('score', 'desc')
        .toArray();

      expect(rows.length).toBe(TOTAL_ROWS);
      expect(totalProcessed).toBe(TOTAL_ROWS);

      // Verify chunking invariants:
      // Expected batches = Math.ceil(2500 / 128) = 20 batches
      const expectedBatches = Math.ceil(TOTAL_ROWS / 128);
      expect(batchCalls).toBe(expectedBatches);

      // Every batch except possibly the last must be exactly 128
      for (let b = 0; b < chunkSizes.length - 1; b++) {
        expect(chunkSizes[b]).toBe(128);
      }
      expect(chunkSizes[chunkSizes.length - 1]).toBe(TOTAL_ROWS % 128 || 128);

      // Verify sorting correctness on all 2500 rows against reference
      for (let i = 0; i < rows.length - 1; i++) {
        expect(rows[i].score).toBeGreaterThanOrEqual(rows[i + 1].score);
      }
    });

    it('supports fast pagination with LIMIT and OFFSET on a large dataset with batched UDF', async () => {
      db.registerBatchedFunction('invert_score', (argsBatch) => {
        return argsBatch.map(([v]) => Math.round(10000 - Number(v)));
      });

      // Page 1: top 50
      const page1 = await db
        .from('benchmark_items')
        .select(['id', 'invert_score(val) as inv'])
        .orderBy('inv', 'desc')
        .limit(50)
        .toArray();

      expect(page1.length).toBe(50);

      // Page 2: next 50
      const page2 = await db
        .from('benchmark_items')
        .select(['id', 'invert_score(val) as inv'])
        .orderBy('inv', 'desc')
        .offset(50)
        .limit(50)
        .toArray();

      expect(page2.length).toBe(50);
      // All page 1 items must be >= all page 2 items
      expect(page1[49].inv).toBeGreaterThanOrEqual(page2[0].inv);

      // No ID overlap between page 1 and page 2
      const page1Ids = new Set(page1.map((r) => r.id));
      for (const r of page2) {
        expect(page1Ids.has(r.id)).toBe(false);
      }
    });
  });

  describe('5. WHERE Filters with Batched UDFs + ORDER BY with Batched UDFs', () => {
    beforeEach(async () => {
      await db.createTable('inventory', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'sku', type: DataType.TEXT },
        { name: 'stock', type: DataType.INT32 },
        { name: 'unit_cost', type: DataType.FLOAT64 },
      ]);

      await db.insertMany('inventory', [
        { id: 1, sku: 'WIDGET-A', stock: 120, unit_cost: 15.0 },
        { id: 2, sku: 'WIDGET-B', stock: 5, unit_cost: 45.0 },
        { id: 3, sku: 'WIDGET-C', stock: 80, unit_cost: 25.0 },
        { id: 4, sku: 'WIDGET-D', stock: 0, unit_cost: 100.0 },
        { id: 5, sku: 'WIDGET-E', stock: 250, unit_cost: 8.0 },
        { id: 6, sku: 'WIDGET-F', stock: 15, unit_cost: 50.0 },
      ]);
    });

    it('filters rows with a batched UDF in WHERE, then projects and sorts by another batched UDF', async () => {
      let filterCalls = 0;
      let projectCalls = 0;

      // WHERE predicate: stock > 10
      db.registerBatchedFunction('is_in_stock', (argsBatch) => {
        filterCalls++;
        return argsBatch.map(([stock]) => (Number(stock) > 10 ? 1 : 0));
      });

      // SELECT projection: total inventory value = stock * unit_cost
      db.registerBatchedFunction('inv_value', (argsBatch) => {
        projectCalls++;
        return argsBatch.map(([stock, cost]) => Number(stock) * Number(cost));
      });

      const matching = await db
        .from('inventory')
        .select(['id', 'sku', 'stock', 'inv_value(stock, unit_cost) as total_val'])
        .where('is_in_stock(stock)')
        .orderBy('total_val', 'desc')
        .toArray();

      // Only items with stock > 10: WIDGET-A (120), WIDGET-C (80), WIDGET-E (250), WIDGET-F (15) = 4 items
      expect(matching.length).toBe(4);
      // WIDGET-C: 80 * 25 = 2000
      // WIDGET-E: 250 * 8 = 2000
      // WIDGET-A: 120 * 15 = 1800
      // WIDGET-F: 15 * 50 = 750
      expect(matching[0].total_val).toBe(2000);
      expect(matching[1].total_val).toBe(2000);
      expect(matching[2].sku).toBe('WIDGET-A');
      expect(matching[2].total_val).toBe(1800);
      expect(matching[3].sku).toBe('WIDGET-F');
      expect(matching[3].total_val).toBe(750);

      expect(filterCalls).toBeGreaterThan(0);
      expect(projectCalls).toBeGreaterThan(0);
    });

    it('preserves all columns when querying with SELECT * and batched WHERE filter', async () => {
      db.registerBatchedFunction('has_low_stock', (argsBatch) => {
        return argsBatch.map(([stock]) => (Number(stock) <= 15 ? 1 : 0));
      });

      const rows = await db
        .from('inventory')
        .where('has_low_stock(stock)')
        .orderBy('id', 'asc')
        .toArray();

      expect(rows.length).toBe(3); // WIDGET-B (5), WIDGET-D (0), WIDGET-F (15)
      expect(rows[0].id).toBe(2);
      expect(rows[0].sku).toBe('WIDGET-B');
      expect(rows[0].stock).toBe(5);
      expect(rows[0].unit_cost).toBe(45.0);

      expect(rows[1].id).toBe(4);
      expect(rows[2].id).toBe(6);
    });
  });

  describe('6. Mixed Scalar Functions & Batched UDFs with ORDER BY', () => {
    it('correctly executes scalar UDF, batched UDF, and built-in SQL functions side-by-side', async () => {
      await db.createTable('users_scores', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'first_name', type: DataType.TEXT },
        { name: 'raw_score', type: DataType.FLOAT64 },
      ]);

      await db.insertMany('users_scores', [
        { id: 1, first_name: 'alice', raw_score: 85.5 },
        { id: 2, first_name: 'bob', raw_score: 92.0 },
        { id: 3, first_name: 'charlie', raw_score: 78.2 },
      ]);

      // Scalar UDF (call only)
      db.registerFunction('scalar_grade', {
        call: (score: number) => (score >= 90 ? 'A' : score >= 80 ? 'B' : 'C'),
      });

      // Batched UDF (batchCall only)
      let batchUdfInvoked = false;
      db.registerBatchedFunction('batch_percentile', (argsBatch) => {
        batchUdfInvoked = true;
        return argsBatch.map(([score]) => Math.round(Number(score) * 1.1 * 10) / 10);
      });

      const results = await db
        .from('users_scores')
        .select([
          'id',
          'upper(first_name) as upper_name',
          'scalar_grade(raw_score) as grade',
          'batch_percentile(raw_score) as boosted',
        ])
        .orderBy('boosted', 'desc')
        .toArray();

      expect(results.length).toBe(3);
      expect(batchUdfInvoked).toBe(true);

      expect(results[0].upper_name).toBe('BOB');
      expect(results[0].grade).toBe('A');
      expect(results[0].boosted).toBe(101.2);

      expect(results[1].upper_name).toBe('ALICE');
      expect(results[1].grade).toBe('B');
      expect(results[1].boosted).toBe(94.1);

      expect(results[2].upper_name).toBe('CHARLIE');
      expect(results[2].grade).toBe('C');
      expect(results[2].boosted).toBe(86.0);
    });
  });

  describe('7. Direct Expression ORDER BY with Batched UDFs (without SELECT alias)', () => {
    it('orders by a batched expression directly in orderBy(fn(...)) without projecting it in SELECT', async () => {
      await db.createTable('raw_numbers', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'val', type: DataType.FLOAT64 },
      ]);

      await db.insertMany('raw_numbers', [
        { id: 1, val: 10.0 },
        { id: 2, val: -5.0 },
        { id: 3, val: 30.0 },
        { id: 4, val: -50.0 },
        { id: 5, val: 20.0 },
      ]);

      // Batched abs value computation
      let batchCount = 0;
      db.registerBatchedFunction('batch_abs', (argsBatch) => {
        batchCount++;
        return argsBatch.map(([v]) => Math.abs(Number(v)));
      }, { returnType: DataType.FLOAT64 });

      batchCount = 0;

      // Select ONLY id and val, but order by batch_abs(val) DESC
      // |val|: -50 -> 50, 30 -> 30, 20 -> 20, 10 -> 10, -5 -> 5
      const rows = await db
        .from('raw_numbers')
        .select(['id', 'val'])
        .orderBy(fn('batch_abs', col('val')), 'desc')
        .toArray();

      expect(rows.length).toBe(5);
      expect(rows.map((r) => r.id)).toEqual([4, 3, 5, 1, 2]);
      expect(batchCount).toBeGreaterThan(0);
      // Ensure the internal sort helper wasn't leaked into output
      expect(Object.keys(rows[0])).toEqual(['id', 'val']);
    });
  });

  describe('8. Very Large Dataset (10,000 Rows) with Multi-Key Sort & Vector Invariants', () => {
    const N = 10000;

    it('processes 10,000 rows in exactly 79 chunks of 128 and guarantees exact sort parity', async () => {
      await db.createTable('huge_dataset', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'val', type: DataType.FLOAT64 },
        { name: 'cat', type: DataType.TEXT },
      ]);

      const items = [];
      for (let i = 1; i <= N; i++) {
        // High cardinality pseudorandom distribution
        const val = ((i * 3571 + 104729) % 50000) / 100;
        items.push({
          id: i,
          val,
          cat: `C_${i % 10}`,
        });
      }
      await db.insertMany('huge_dataset', items);

      let batchCalls = 0;
      let totalRowsProcessed = 0;
      const recordedChunkSizes: number[] = [];

      db.registerBatchedFunction('heavy_transform', (argsBatch) => {
        batchCalls++;
        recordedChunkSizes.push(argsBatch.length);
        totalRowsProcessed += argsBatch.length;
        return argsBatch.map(([v]) => {
          const num = Number(v);
          return Math.round((Math.sqrt(num) * 10 + (num % 7)) * 100) / 100;
        });
      }, { returnType: DataType.FLOAT64 });

      batchCalls = 0;
      recordedChunkSizes.length = 0;
      totalRowsProcessed = 0;

      // Query with primary ORDER BY heavy_transform DESC, secondary ORDER BY id ASC
      const resultRows = await db
        .from('huge_dataset')
        .select(['id', 'val', 'heavy_transform(val) as transformed'])
        .orderBy('transformed', 'desc')
        .orderBy('id', 'asc')
        .toArray();

      expect(resultRows.length).toBe(N);
      expect(totalRowsProcessed).toBe(N);

      // 10,000 / 128 = 78.125 -> 79 batches
      const expectedBatches = Math.ceil(N / 128);
      expect(batchCalls).toBe(expectedBatches);

      // Verify all batches up to 78 are exactly 128 items
      for (let i = 0; i < 78; i++) {
        expect(recordedChunkSizes[i]).toBe(128);
      }
      // Last batch: 10,000 % 128 = 16 items
      expect(recordedChunkSizes[78]).toBe(N % 128);

      // Verify descending order correctness
      for (let i = 0; i < resultRows.length - 1; i++) {
        const cur = resultRows[i].transformed;
        const nxt = resultRows[i + 1].transformed;
        if (cur === nxt) {
          // Tie-break: id ASC
          expect(resultRows[i].id).toBeLessThan(resultRows[i + 1].id);
        } else {
          expect(cur).toBeGreaterThan(nxt);
        }
      }
    });
  });

  describe('9. JOINs between Derived Subqueries and Tables with Batched ORDER BY', () => {
    it('joins a derived subquery containing a batched UDF with a regular table', async () => {
      await db.createTable('accounts', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'owner', type: DataType.TEXT },
        { name: 'balance', type: DataType.FLOAT64 },
      ]);

      await db.createTable('tiers', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'code', type: DataType.TEXT },
        { name: 'perk', type: DataType.TEXT },
      ]);

      await db.insertMany('accounts', [
        { id: 1, owner: 'Alex', balance: 5000 },
        { id: 2, owner: 'Jordan', balance: 25000 },
        { id: 3, owner: 'Taylor', balance: 1200 },
      ]);

      await db.insertMany('tiers', [
        { id: 10, code: 'PLATINUM', perk: 'Concierge' },
        { id: 20, code: 'GOLD', perk: 'Priority' },
        { id: 30, code: 'STANDARD', perk: 'Basic' },
      ]);

      db.registerBatchedFunction('assign_tier', (argsBatch) => {
        return argsBatch.map(([bal]) => {
          const b = Number(bal);
          return b >= 20000 ? 'PLATINUM' : b >= 5000 ? 'GOLD' : 'STANDARD';
        });
      });

      // Derived subquery with batched UDF
      const accountWithTier = db
        .from('accounts')
        .select(['id', 'owner', 'balance', 'assign_tier(balance) as tier_code']);

      // Join derived subquery with tiers table and order by balance desc
      const joined = await db
        .from(accountWithTier)
        .join('tiers', 'tier_code', '=', 'tiers.code')
        .select(['owner', 'tier_code', 'tiers.perk as perk', 'balance'])
        .orderBy('balance', 'desc')
        .toArray();

      expect(joined.length).toBe(3);
      expect(joined[0].owner).toBe('Jordan');
      expect(joined[0].tier_code).toBe('PLATINUM');
      expect(joined[0].perk).toBe('Concierge');

      expect(joined[1].owner).toBe('Alex');
      expect(joined[1].tier_code).toBe('GOLD');
      expect(joined[1].perk).toBe('Priority');

      expect(joined[2].owner).toBe('Taylor');
      expect(joined[2].tier_code).toBe('STANDARD');
      expect(joined[2].perk).toBe('Basic');
    });
  });

  describe('10. Transactions & ACID Consistency with Batched UDFs', () => {
    it('executes batched UDF queries within transactions with rollback safety', async () => {
      await db.createTable('wallets', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'user', type: DataType.TEXT },
        { name: 'coins', type: DataType.INT32 },
      ]);

      await db.insertMany('wallets', [
        { id: 1, user: 'U1', coins: 100 },
        { id: 2, user: 'U2', coins: 200 },
      ]);

      db.registerBatchedFunction('fiat_val', (argsBatch) => {
        return argsBatch.map(([coins]) => Number(coins) * 0.05);
      });

      // Transaction that modifies and queries within tx
      await db.transaction(async (tx) => {
        await tx.insertMany('wallets', [{ id: 3, user: 'U3', coins: 500 }]);

        const txRows = await tx
          .from('wallets')
          .select(['id', 'user', 'fiat_val(coins) as usd'])
          .orderBy('usd', 'desc')
          .toArray();

        expect(txRows.length).toBe(3);
        expect(txRows[0].user).toBe('U3');
        expect(txRows[0].usd).toBe(25);
      });

      // Verified committed state
      const committed = await db
        .from('wallets')
        .select(['id', 'fiat_val(coins) as usd'])
        .orderBy('usd', 'desc')
        .toArray();

      expect(committed.length).toBe(3);
      expect(committed[0].id).toBe(3);
    });
  });

  describe('11. SELECT and WHERE Containing the Same UDF Call (Common Subexpression Elimination)', () => {
    beforeEach(async () => {
      await db.createTable('students', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'name', type: DataType.TEXT },
        { name: 'score', type: DataType.FLOAT64 },
      ]);

      await db.insertMany('students', [
        { id: 1, name: 'Alice', score: 95 },
        { id: 2, name: 'Bob', score: 60 },
        { id: 3, name: 'Charlie', score: 85 },
        { id: 4, name: 'Diana', score: 40 },
        { id: 5, name: 'Evan', score: 75 },
      ]);
    });

    it('caches deterministic batched UDF call across WHERE and SELECT (evaluated once on candidates, 0 re-evaluations)', async () => {
      let batchCalls = 0;
      let totalItemsProcessed = 0;

      db.registerBatchedFunction(
        'compute_grade',
        (argsBatch) => {
          batchCalls++;
          totalItemsProcessed += argsBatch.length;
          return argsBatch.map(([s]) => (Number(s) >= 80 ? 'HONORS' : 'STANDARD'));
        },
        { deterministic: true, returnType: DataType.TEXT },
      );

      batchCalls = 0;
      totalItemsProcessed = 0;

      // Both SELECT and WHERE use compute_grade(score)
      const results = await db
        .from('students')
        .select(['id', 'name', 'score', 'compute_grade(score) as grade'])
        .where("compute_grade(score) = 'HONORS'")
        .orderBy('id', 'asc')
        .toArray();

      expect(results.length).toBe(2); // Alice (95) and Charlie (85)
      expect(results[0].name).toBe('Alice');
      expect(results[0].grade).toBe('HONORS');
      expect(results[1].name).toBe('Charlie');
      expect(results[1].grade).toBe('HONORS');

      // VERIFICATION:
      // Without caching: 5 items processed in WHERE + 2 items processed in SELECT = 7 items (2 batch calls)
      // With caching (CSE): exactly 5 items processed in WHERE, 0 re-evaluations in SELECT = 5 items (1 batch call)!
      expect(batchCalls).toBe(1);
      expect(totalItemsProcessed).toBe(5);
    });

    it('re-evaluates when UDF is explicitly non-deterministic (deterministic: false)', async () => {
      let nonDetCalls = 0;
      let nonDetItemsProcessed = 0;

      db.registerBatchedFunction(
        'dynamic_tag',
        (argsBatch) => {
          nonDetCalls++;
          nonDetItemsProcessed += argsBatch.length;
          return argsBatch.map(([s]) => (Number(s) >= 80 ? 'PASS' : 'FAIL'));
        },
        { deterministic: false, returnType: DataType.TEXT },
      );

      nonDetCalls = 0;
      nonDetItemsProcessed = 0;

      const results = await db
        .from('students')
        .select(['id', 'dynamic_tag(score) as tag'])
        .where("dynamic_tag(score) = 'PASS'")
        .toArray();

      expect(results.length).toBe(2);
      // Non-deterministic UDF is NOT cached: 5 items in WHERE + 2 items in SELECT = 7 items
      expect(nonDetCalls).toBe(2);
      expect(nonDetItemsProcessed).toBe(7);
    });

    it('caches identical UDF call repeated multiple times in SELECT projections', async () => {
      let transformCalls = 0;
      let itemsProcessed = 0;

      db.registerBatchedFunction(
        'double_score',
        (argsBatch) => {
          transformCalls++;
          itemsProcessed += argsBatch.length;
          return argsBatch.map(([s]) => Number(s) * 2);
        },
        { deterministic: true, returnType: DataType.FLOAT64 },
      );

      transformCalls = 0;
      itemsProcessed = 0;

      // Repeated twice in SELECT projections with different aliases
      const results = await db
        .from('students')
        .select([
          'id',
          'double_score(score) as s1',
          'double_score(score) as s2',
        ])
        .toArray();

      expect(results.length).toBe(5);
      expect(results[0].s1).toBe(190);
      expect(results[0].s2).toBe(190);

      // Caching ensures it is evaluated ONCE for all 5 rows, not 10 times
      expect(transformCalls).toBe(1);
      expect(itemsProcessed).toBe(5);
    });
  });
});
