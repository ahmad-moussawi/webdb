import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/webdb.js';

describe('WebDB End-to-End & Storage Persistence', () => {
  it('creates tables, inserts rows, and queries data with MemoryVfsAdapter', async () => {
    const db = await WebDB.open({ name: 'memory_test', storage: 'memory' });

    await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'age', type: 'INT32' },
      { name: 'score', type: 'FLOAT64' },
    ]);

    await db.insert('users', { id: 1, name: 'Alice', age: 28, score: 95.5 });
    await db.insert('users', { id: 2, name: 'Bob', age: 19, score: 82.0 });
    await db.insert('users', { id: 3, name: 'Charlie', age: 34, score: 78.5 });

    // Select all
    const all = await db.from('users').toArray();
    expect(all).toHaveLength(3);

    // Filter by age > 20
    const adults = await db.from('users').where('age', '>', 20).toArray();
    expect(adults).toHaveLength(2);
    expect(adults.map((u) => u.name)).toEqual(['Alice', 'Charlie']);

    // Order by score descending with limit
    const topScorer = await db.from('users').orderBy('score', 'desc').limit(1).toArray();
    expect(topScorer).toHaveLength(1);
    expect(topScorer[0].name).toBe('Alice');
  });

  it('handles multi-page table expansion when page fills', async () => {
    const db = await WebDB.open({ name: 'multipage_test', storage: 'memory' });

    await db.createTable('logs', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'message', type: 'TEXT' },
    ]);

    // Insert 100 rows with 100-byte text payloads (total ~12 KB, will span across 3-4 pages)
    for (let i = 1; i <= 100; i++) {
      await db.insert('logs', {
        id: i,
        message: `Log event message #${i} with extended textual details to consume slotted page byte storage...`,
      });
    }

    const allLogs = await db.from('logs').toArray();
    expect(allLogs).toHaveLength(100);
    expect(allLogs[0].id).toBe(1);
    expect(allLogs[99].id).toBe(100);

    // Filter across multiple pages
    const filtered = await db.from('logs').where('id', '>', 90).toArray();
    expect(filtered).toHaveLength(10);
    expect(filtered.map((l) => l.id)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it('persists data across database re-opens using IndexedDbVfsAdapter', async () => {
    const dbName = 'persisted_idb_test';

    // 1. Open database and write data
    const db1 = await WebDB.open({ name: dbName, storage: 'idb' });
    await db1.createTable('tasks', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'title', type: 'TEXT', flags: { notNull: true } },
      { name: 'done', type: 'INT32' },
    ]);

    await db1.insert('tasks', { id: 1, title: 'Build Prototype', done: 1 });
    await db1.insert('tasks', { id: 2, title: 'Verify Slotted Pages', done: 1 });
    await db1.insert('tasks', { id: 3, title: 'Compile to Wasm (V2)', done: 0 });
    await db1.close();

    // 2. Re-open database from IndexedDB
    const db2 = await WebDB.open({ name: dbName, storage: 'idb' });
    const pendingTasks = await db2.from('tasks').where('done', '=', 0).toArray();

    expect(pendingTasks).toHaveLength(1);
    expect(pendingTasks[0].title).toBe('Compile to Wasm (V2)');

    const allTasks = await db2.from('tasks').orderBy('id', 'asc').toArray();
    expect(allTasks).toHaveLength(3);
    await db2.close();
  });
});
