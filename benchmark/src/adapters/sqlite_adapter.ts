import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { BenchmarkAdapter, BenchmarkRecord, EngineId, StorageCategory } from './types.js';

let cachedSqlite3: any = null;

async function getSqlite3(): Promise<any> {
  if (cachedSqlite3) return cachedSqlite3;
  cachedSqlite3 = await sqlite3InitModule({
    print: () => {},
    printErr: console.error,
  });
  return cachedSqlite3;
}

export class SqliteWasmAdapter implements BenchmarkAdapter {
  readonly id: EngineId;
  readonly name: string;
  readonly storage: StorageCategory;

  private isOpfs: boolean;
  private db: any = null;
  private dbFilename: string;

  constructor(id: 'sqlite_mem' | 'sqlite_opfs', isOpfs: boolean = false) {
    this.id = id;
    this.isOpfs = isOpfs;
    this.storage = isOpfs ? 'persistent' : 'memory';
    this.name = isOpfs ? 'SQLite WASM (OPFS)' : 'SQLite WASM (In-Memory)';
    this.dbFilename = `/bench_sqlite_${Date.now()}.sqlite3`;
  }

  static async isOpfsSupported(): Promise<boolean> {
    try {
      const sqlite3 = await getSqlite3();
      return !!(sqlite3.opfs && typeof FileSystemHandle !== 'undefined');
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    if (this.db) {
      await this.teardown();
    }

    const sqlite3 = await getSqlite3();

    if (this.isOpfs) {
      if (!sqlite3.opfs) {
        throw new Error('OPFS is not supported in this browser context (requires Web Worker or Cross-Origin-Isolation).');
      }
      this.db = new sqlite3.oo1.OpfsDb(this.dbFilename);
    } else {
      this.db = new sqlite3.oo1.DB(':memory:');
    }

    // Configure PRAGMAs for optimal performance
    this.db.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_mode = WAL;
      PRAGMA cache_size = -64000;
      
      CREATE TABLE benchmark (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER,
        score REAL,
        city TEXT,
        active INTEGER
      );

      CREATE INDEX idx_benchmark_age ON benchmark(age);
      CREATE INDEX idx_benchmark_score ON benchmark(score);
      CREATE INDEX idx_benchmark_active ON benchmark(active);

      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        amount REAL
      );

      CREATE INDEX idx_orders_user_id ON orders(user_id);
    `);
  }

  async bulkInsert(records: BenchmarkRecord[], orders: import('./types.js').OrderRecord[] = []): Promise<void> {
    if (!this.db) throw new Error('SQLite not initialized');
    const db = this.db;

    db.exec('BEGIN TRANSACTION;');
    const stmt = db.prepare(
      'INSERT INTO benchmark (id, name, age, score, city, active) VALUES (?, ?, ?, ?, ?, ?);'
    );
    const orderStmt = db.prepare(
      'INSERT INTO orders (id, user_id, amount) VALUES (?, ?, ?);'
    );

    try {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        stmt.bind([r.id, r.name, r.age, r.score, r.city, r.active]);
        stmt.step();
        stmt.reset();
      }
      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        orderStmt.bind([o.id, o.user_id, o.amount]);
        orderStmt.step();
        orderStmt.reset();
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    } finally {
      stmt.finalize();
      orderStmt.finalize();
    }
  }

  async pointLookup(ids: number[]): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error('SQLite not initialized');
    const db = this.db;
    const stmt = db.prepare('SELECT id, name, age, score, city, active FROM benchmark WHERE id = ?;');
    const results: BenchmarkRecord[] = [];

    try {
      for (let i = 0; i < ids.length; i++) {
        stmt.bind([ids[i]]);
        if (stmt.step()) {
          const row = stmt.get({});
          results.push(row as BenchmarkRecord);
        }
        stmt.reset();
      }
    } finally {
      stmt.finalize();
    }

    return results;
  }

  async rangeScan(minAge: number, maxAge: number): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error('SQLite not initialized');
    const db = this.db;
    const stmt = db.prepare(
      'SELECT id, name, age, score, city, active FROM benchmark WHERE age >= ? AND age <= ?;'
    );
    const results: BenchmarkRecord[] = [];

    try {
      stmt.bind([minAge, maxAge]);
      while (stmt.step()) {
        results.push(stmt.get({}) as BenchmarkRecord);
      }
    } finally {
      stmt.finalize();
    }

    return results;
  }

  async sortLimit(limit: number): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error('SQLite not initialized');
    const db = this.db;
    const stmt = db.prepare(
      'SELECT id, name, age, score, city, active FROM benchmark WHERE active = 1 ORDER BY score DESC LIMIT ?;'
    );
    const results: BenchmarkRecord[] = [];

    try {
      stmt.bind([limit]);
      while (stmt.step()) {
        results.push(stmt.get({}) as BenchmarkRecord);
      }
    } finally {
      stmt.finalize();
    }

    return results;
  }

  async aggregation(): Promise<{ count: number; sumScore: number; avgAge: number }> {
    if (!this.db) throw new Error('SQLite not initialized');
    const db = this.db;
    const rows = db.selectObjects(
      'SELECT COUNT(*) as count, SUM(score) as sumScore, AVG(age) as avgAge FROM benchmark WHERE active = 1;'
    );

    if (rows && rows.length > 0) {
      const r = rows[0];
      return {
        count: Number(r.count ?? 0),
        sumScore: Math.round(Number(r.sumScore ?? 0) * 100) / 100,
        avgAge: Number(r.avgAge ?? 0),
      };
    }

    return { count: 0, sumScore: 0, avgAge: 0 };
  }

  async joinQuery(): Promise<any[]> {
    if (!this.db) throw new Error('SQLite not initialized');
    return this.db.selectObjects(`
      SELECT orders.id as order_id, benchmark.name as user_name, orders.amount
      FROM orders
      JOIN benchmark ON orders.user_id = benchmark.id;
    `);
  }

  async teardown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (this.isOpfs && cachedSqlite3?.opfs) {
      try {
        cachedSqlite3.opfs.unlink(this.dbFilename);
      } catch {
        // ignore
      }
    }
  }
}
