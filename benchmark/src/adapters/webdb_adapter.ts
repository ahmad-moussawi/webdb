import { WebDB } from '@webdb/core';
import { BenchmarkAdapter, BenchmarkRecord, EngineId, StorageCategory } from './types.js';

export class WebDbAdapter implements BenchmarkAdapter {
  readonly id: EngineId;
  readonly name: string;
  readonly storage: StorageCategory;

  private dbName: string = '';
  private db: WebDB | null = null;
  private storageMode: 'memory' | 'idb' | 'opfs';

  constructor(id: 'webdb_mem' | 'webdb_idb', storageMode: 'memory' | 'idb') {
    this.id = id;
    this.storageMode = storageMode;
    this.storage = storageMode === 'memory' ? 'memory' : 'persistent';
    this.name = storageMode === 'memory' ? 'WebDB (In-Memory)' : 'WebDB (IndexedDB VFS)';
  }

  async init(): Promise<void> {
    if (this.db) {
      await this.teardown();
    }

    // Always generate a unique database name per lifecycle to guarantee clean state
    this.dbName = `bench_wdb_${this.storageMode}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.db = await WebDB.open({
      name: this.dbName,
      storage: this.storageMode,
    });

    // Safeguard: drop tables if they exist
    try {
      const tables = await this.db.listTables();
      if (tables.some((t) => t.name === 'orders')) {
        await this.db.dropTable('orders');
      }
      if (tables.some((t) => t.name === 'benchmark')) {
        await this.db.dropTable('benchmark');
      }
    } catch {
      // ignore
    }

    await this.db.createTable('benchmark', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'age', type: 'INT32' },
      { name: 'score', type: 'FLOAT64' },
      { name: 'city', type: 'TEXT' },
      { name: 'active', type: 'INT32' },
    ]);

    await this.db.createTable('orders', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'user_id', type: 'INT32', flags: { notNull: true } },
      { name: 'amount', type: 'FLOAT64' },
    ]);
  }

  async bulkInsert(records: BenchmarkRecord[], orders: import('./types.js').OrderRecord[] = []): Promise<void> {
    if (!this.db) throw new Error('WebDB not initialized');
    const db = this.db;
    const len = records.length;
    for (let i = 0; i < len; i++) {
      await db.insert('benchmark', records[i]);
    }
    const orderLen = orders.length;
    for (let i = 0; i < orderLen; i++) {
      await db.insert('orders', orders[i]);
    }
  }

  async pointLookup(ids: number[]): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error('WebDB not initialized');
    const db = this.db;
    const results: BenchmarkRecord[] = [];
    const len = ids.length;
    for (let i = 0; i < len; i++) {
      const res = await db.from('benchmark').where('id', '=', ids[i]).toArray();
      if (res.length > 0) {
        results.push(res[0] as unknown as BenchmarkRecord);
      }
    }
    return results;
  }

  async rangeScan(minAge: number, maxAge: number): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error('WebDB not initialized');
    const rows = await this.db
      .from('benchmark')
      .where('age', '>=', minAge)
      .where('age', '<=', maxAge)
      .toArray();
    return rows as unknown as BenchmarkRecord[];
  }

  async sortLimit(limit: number): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error('WebDB not initialized');
    const rows = await this.db
      .from('benchmark')
      .where('active', '=', 1)
      .orderBy('score', 'desc')
      .limit(limit)
      .toArray();
    return rows as unknown as BenchmarkRecord[];
  }

  async aggregation(): Promise<{ count: number; sumScore: number; avgAge: number }> {
    if (!this.db) throw new Error('WebDB not initialized');
    const rows = await this.db
      .from('benchmark')
      .where('active', '=', 1)
      .select(['count(*) as cnt', 'sum(score) as sum_score', 'avg(age) as avg_age'])
      .toArray();

    if (rows.length > 0) {
      const r = rows[0] as any;
      return {
        count: Number(r.cnt ?? 0),
        sumScore: Number(r.sum_score ?? 0),
        avgAge: Number(r.avg_age ?? 0),
      };
    }
    return { count: 0, sumScore: 0, avgAge: 0 };
  }

  async joinQuery(): Promise<any[]> {
    if (!this.db) throw new Error('WebDB not initialized');
    return await this.db
      .from('orders')
      .join('benchmark', 'orders.user_id', '=', 'benchmark.id')
      .select(['orders.id as order_id', 'benchmark.name as user_name', 'orders.amount'])
      .toArray();
  }

  async teardown(): Promise<void> {
    if (this.db) {
      try {
        const tables = await this.db.listTables();
        if (tables.some((t) => t.name === 'orders')) {
          await this.db.dropTable('orders');
        }
        if (tables.some((t) => t.name === 'benchmark')) {
          await this.db.dropTable('benchmark');
        }
      } catch {
        // ignore
      }
      try {
        await this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }

    if (this.storageMode === 'idb' && this.dbName && typeof indexedDB !== 'undefined') {
      const actualIdbName = `webdb_${this.dbName}`;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(actualIdbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  }
}
