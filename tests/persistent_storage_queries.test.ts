import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { WebDB, DataType, col, fn, QueryExecutionStalledError, RowSizeLimitExceededError } from '../src/index.js';

let openedDbs: WebDB[] = [];
let dbCounter = 0;

async function createIdbDb(): Promise<WebDB> {
  const db = await WebDB.open({
    name: `test_idb_matrix_${Date.now()}_${dbCounter++}`,
    storage: 'idb',
  });
  openedDbs.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
});

describe('Persistent Storage (IndexedDB) Matrix & Progress Guards', () => {
  describe('Progress Guards', () => {
    it('RowSizeLimitExceededError and QueryExecutionStalledError classes are properly exported', () => {
      const err1 = new RowSizeLimitExceededError('test size overflow');
      expect(err1).toBeInstanceOf(Error);
      expect(err1.name).toBe('RowSizeLimitExceededError');

      const err2 = new QueryExecutionStalledError('test stall');
      expect(err2).toBeInstanceOf(Error);
      expect(err2.name).toBe('QueryExecutionStalledError');
    });

    it('fails fast with RowSizeLimitExceededError if BUFFER_FULL occurs with 0 rows emitted', async () => {
      const db = await createIdbDb();
      await db.createTable('t', [{ name: 'id', type: DataType.INT32, primaryKey: true }]);
      await db.insert('t', { id: 1 });

      const originalWasm = (db as any).wasmCore;
      // Simulate VM emitting BUFFER_FULL with 0 rows (status = 3)
      (db as any).wasmCore = { vm_step: () => 3 };

      await expect(db.from('t').toArray()).rejects.toThrow(RowSizeLimitExceededError);

      (db as any).wasmCore = originalWasm;
    });

    it('fails fast with QueryExecutionStalledError if stepFn loops without forward progress', async () => {
      const db = await createIdbDb();
      await db.createTable('t', [{ name: 'id', type: DataType.INT32, primaryKey: true }]);
      await db.insert('t', { id: 1 });

      const originalWasm = (db as any).wasmCore;
      // Simulate VM repeatedly returning PAGE_FAULT for page 999 at the same PC without advancing
      (db as any).wasmCore = {
        vm_step: (ctx: any) => {
          ctx.fault_page_id = 999;
          return 2; // VmStatus.PAGE_FAULT
        },
      };

      await expect(db.from('t').toArray()).rejects.toThrow(QueryExecutionStalledError);

      (db as any).wasmCore = originalWasm;
    });
  });

  describe('Multi-page table scans and ORDER BY with Page Faults on IDB', () => {
    it('correctly sorts multi-page records across page fault boundaries', async () => {
      const db = await createIdbDb();

      await db.createTable('items', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'payload', type: DataType.TEXT },
        { name: 'score', type: DataType.FLOAT64 },
      ]);

      // Insert enough rows with realistic text to exceed a single 4096-byte page
      const count = 120;
      const rows = [];
      for (let i = 1; i <= count; i++) {
        rows.push({
          id: i,
          payload: `Long descriptive text payload for row #${i} to ensure data spans multiple 4KB pages in IndexedDB storage adapter`,
          score: Math.sin(i) * 100,
        });
      }
      await db.insertMany('items', rows);

      // Verify page count in storage
      const totalCount = await db.from('items').count('id', 'c').toArray();
      expect(totalCount[0].c).toBe(count);

      // Query with ORDER BY id DESC
      const descResults = await db.from('items').orderBy('id', 'desc').toArray();
      expect(descResults).toHaveLength(count);
      expect(descResults[0].id).toBe(count);
      expect(descResults[descResults.length - 1].id).toBe(1);

      // Query with ORDER BY score ASC, LIMIT 10, OFFSET 5
      const sortedByScore = [...rows].sort((a, b) => a.score - b.score);
      const expectedSlice = sortedByScore.slice(5, 15);

      const pagedResults = await db
        .from('items')
        .orderBy('score', 'asc')
        .offset(5)
        .limit(10)
        .toArray();

      expect(pagedResults).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(pagedResults[i].id).toBe(expectedSlice[i].id);
      }
    });

    it('handles ORDER BY with Batched UDFs on persistent IDB storage', async () => {
      const db = await createIdbDb();

      await db.createTable('scores', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'raw_score', type: DataType.INT32 },
      ]);

      const testData = [
        { id: 1, raw_score: 85 },
        { id: 2, raw_score: 42 },
        { id: 3, raw_score: 99 },
        { id: 4, raw_score: 73 },
        { id: 5, raw_score: 12 },
        { id: 6, raw_score: 60 },
      ];
      await db.insertMany('scores', testData);

      let batchCalls = 0;
      db.registerBatchedFunction(
        'grade_rank',
        (batch) => {
          batchCalls++;
          return batch.map(([score]) => {
            const s = Number(score);
            if (s >= 90) return 'A';
            if (s >= 75) return 'B';
            if (s >= 60) return 'C';
            return 'F';
          });
        },
        { returnType: DataType.TEXT },
      );

      const ranked = await db
        .from('scores')
        .select(['id', 'raw_score', fn('grade_rank', col('raw_score')).as('grade')])
        .orderBy('grade', 'asc')
        .toArray();

      expect(ranked).toHaveLength(6);
      expect(batchCalls).toBeGreaterThan(0);
      expect(ranked[0].grade).toBe('A');
      expect(ranked[ranked.length - 1].grade).toBe('F');
    });
  });

  describe('Joins and Aggregations across persistent IDB pages', () => {
    it('executes indexed and hash joins on IDB storage', async () => {
      const db = await createIdbDb();

      await db.createTable('departments', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'name', type: DataType.TEXT },
      ]);

      await db.createTable('employees', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'dept_id', type: DataType.INT32 },
        { name: 'salary', type: DataType.FLOAT64 },
      ]);

      await db.insertMany('departments', [
        { id: 1, name: 'Engineering' },
        { id: 2, name: 'Marketing' },
        { id: 3, name: 'Sales' },
      ]);

      const emps = [];
      for (let i = 1; i <= 60; i++) {
        emps.push({
          id: i,
          dept_id: (i % 3) + 1,
          salary: 50000 + i * 1000,
        });
      }
      await db.insertMany('employees', emps);

      const joinResult = await db
        .from('employees')
        .join('departments', 'employees.dept_id', '=', 'departments.id')
        .select(['employees.id', 'departments.name', 'employees.salary'])
        .orderBy('employees.id', 'asc')
        .limit(5)
        .toArray();

      expect(joinResult).toHaveLength(5);
      expect(joinResult[0].id).toBe(1);
      expect(joinResult[0].name).toBe('Marketing'); // (1 % 3) + 1 = 2
    });

    it('executes GROUP BY and aggregations on IDB storage', async () => {
      const db = await createIdbDb();

      await db.createTable('sales', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'region', type: DataType.TEXT },
        { name: 'amount', type: DataType.FLOAT64 },
      ]);

      await db.insertMany('sales', [
        { id: 1, region: 'North', amount: 100.0 },
        { id: 2, region: 'North', amount: 150.0 },
        { id: 3, region: 'South', amount: 200.0 },
        { id: 4, region: 'East', amount: 50.0 },
        { id: 5, region: 'East', amount: 75.0 },
        { id: 6, region: 'East', amount: 125.0 },
      ]);

      const grouped = await db
        .from('sales')
        .groupBy('region')
        .sum('amount', 'total')
        .toArray();

      const totals = Object.fromEntries(grouped.map((g) => [g.region, g.total]));
      expect(totals['North']).toBe(250.0);
      expect(totals['South']).toBe(200.0);
      expect(totals['East']).toBe(250.0);
    });
  });
});
