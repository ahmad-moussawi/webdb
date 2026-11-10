import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebDB, DataType, col, fn } from '../src/index.js';

let openedDbs: WebDB[] = [];
let dbSeq = 0;

async function openIdb(options: { name?: string; slotCount?: number } = {}): Promise<WebDB> {
  const db = await WebDB.open({
    name: options.name ?? `idb_integration_${Date.now()}_${dbSeq++}`,
    storage: 'idb',
    slotCount: options.slotCount,
  });
  openedDbs.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
});

describe('Full Storage Lifecycle & Buffer Pool Thrashing Integration Tests', () => {
  it('handles multi-page table scans and ORDER BY under extreme buffer pool eviction pressure', async () => {
    // Small buffer pool (only 16 page slots) to force frequent evictions and page faults
    const db = await openIdb({ slotCount: 16 });

    await db.createTable('documents', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'title', type: DataType.TEXT, notNull: true },
      { name: 'category', type: DataType.TEXT, notNull: true },
      { name: 'priority', type: DataType.INT32, notNull: true },
      { name: 'views', type: DataType.INT32, notNull: true },
    ]);

    // Insert 250 documents with ~120 bytes each -> spans ~15-20 pages (exceeding the 16-slot pool)
    const totalDocs = 250;
    const docs = [];
    const categories = ['Tech', 'Science', 'Design', 'Marketing', 'Finance'];
    for (let i = 1; i <= totalDocs; i++) {
      docs.push({
        id: i,
        title: `Technical Whitepaper & Architecture Specification #${i} for Distributed Systems`,
        category: categories[i % categories.length],
        priority: (i * 7) % 10,
        views: (i * 13) % 1000,
      });
    }
    await db.insertMany('documents', docs);

    // 1. Full table scan with aggregate
    const countRes = await db.from('documents').count('id', 'total').toArray();
    expect(countRes[0].total).toBe(totalDocs);

    // 2. Full scan with ORDER BY priority DESC, views ASC across all pages
    const sorted = await db
      .from('documents')
      .orderBy('priority', 'desc')
      .orderBy('views', 'asc')
      .toArray();

    expect(sorted).toHaveLength(totalDocs);

    // Verify ordering correctness
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev.priority === curr.priority) {
        expect(prev.views).toBeLessThanOrEqual(curr.views);
      } else {
        expect(prev.priority).toBeGreaterThan(curr.priority);
      }
    }

    // 3. Paged query with OFFSET and LIMIT under buffer pool eviction
    const page2 = await db
      .from('documents')
      .where('category', '=', 'Tech')
      .orderBy('views', 'desc')
      .offset(10)
      .limit(10)
      .toArray();

    const expectedTechDocs = docs
      .filter((d) => d.category === 'Tech')
      .sort((a, b) => b.views - a.views)
      .slice(10, 20);

    expect(page2).toHaveLength(expectedTechDocs.length);
    for (let i = 0; i < page2.length; i++) {
      expect(page2[i].id).toBe(expectedTechDocs[i].id);
    }
  });

  it('performs multi-table joins where joined tables exceed the buffer pool slot capacity', async () => {
    // 16 slots total buffer pool
    const db = await openIdb({ slotCount: 16 });

    await db.createTable('authors', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'name', type: DataType.TEXT, notNull: true },
      { name: 'country', type: DataType.TEXT, notNull: true },
    ]);

    await db.createTable('articles', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'author_id', type: DataType.INT32, notNull: true },
      { name: 'headline', type: DataType.TEXT, notNull: true },
      { name: 'read_time', type: DataType.INT32, notNull: true },
    ]);

    const numAuthors = 30;
    const authors = [];
    for (let a = 1; a <= numAuthors; a++) {
      authors.push({
        id: a,
        name: `Author ${a} of International Journal`,
        country: a % 2 === 0 ? 'Canada' : 'Sweden',
      });
    }
    await db.insertMany('authors', authors);

    const numArticles = 120;
    const articles = [];
    for (let i = 1; i <= numArticles; i++) {
      articles.push({
        id: i,
        author_id: (i % numAuthors) + 1,
        headline: `Headline article #${i} discussing browser-native high performance computing`,
        read_time: (i * 3) % 15 + 1,
      });
    }
    await db.insertMany('articles', articles);

    // Join across both tables with ORDER BY and LIMIT
    const joinRows = await db
      .from('articles')
      .join('authors', 'articles.author_id', '=', 'authors.id')
      .where('authors.country', '=', 'Sweden')
      .select([
        'articles.id',
        'articles.headline',
        'authors.name',
        'authors.country',
        'articles.read_time',
      ])
      .orderBy('articles.read_time', 'desc')
      .limit(15)
      .toArray();

    expect(joinRows.length).toBeGreaterThan(0);
    expect(joinRows.length).toBeLessThanOrEqual(15);
    for (const r of joinRows) {
      expect(r.country).toBe('Sweden');
    }
    // Verify sorting order
    for (let i = 1; i < joinRows.length; i++) {
      expect(joinRows[i - 1].read_time).toBeGreaterThanOrEqual(joinRows[i].read_time);
    }
  });

  it('re-opens an existing database from storage, replays WAL, and queries data seamlessly', async () => {
    const dbName = `idb_persist_e2e_${Date.now()}_${dbSeq++}`;

    // Session 1: Create, insert, update
    const db1 = await WebDB.open({ name: dbName, storage: 'idb' });
    openedDbs.push(db1);

    await db1.createTable('projects', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'name', type: DataType.TEXT, notNull: true },
      { name: 'status', type: DataType.TEXT, notNull: true },
      { name: 'budget', type: DataType.FLOAT64, notNull: true },
    ]);

    await db1.insertMany('projects', [
      { id: 1, name: 'WebDB Core Engine', status: 'ACTIVE', budget: 150000.0 },
      { id: 2, name: 'VitePress Documentation', status: 'COMPLETED', budget: 35000.0 },
      { id: 3, name: 'Interactive Demos', status: 'ACTIVE', budget: 45000.0 },
      { id: 4, name: 'Playground Web IDE', status: 'ACTIVE', budget: 85000.0 },
    ]);

    await db1.update('projects', 2, { budget: 40000.0 });
    await db1.delete('projects', 3);
    await db1.close();

    // Session 2: Re-open the database from IndexedDB
    const db2 = await WebDB.open({ name: dbName, storage: 'idb' });
    openedDbs.push(db2);

    const activeProjects = await db2
      .from('projects')
      .where('status', '=', 'ACTIVE')
      .orderBy('budget', 'desc')
      .toArray();

    expect(activeProjects).toHaveLength(2);
    expect(activeProjects[0].name).toBe('WebDB Core Engine');
    expect(activeProjects[0].budget).toBe(150000.0);
    expect(activeProjects[1].name).toBe('Playground Web IDE');
    expect(activeProjects[1].budget).toBe(85000.0);

    const completed = await db2.from('projects').where('id', '=', 2).first();
    expect(completed?.budget).toBe(40000.0);

    const deleted = await db2.from('projects').where('id', '=', 3).first();
    expect(deleted).toBeNull();
  });

  it('keeps live queries responsive across mutations with ORDER BY on IDB', async () => {
    const db = await openIdb();

    await db.createTable('messages', [
      { name: 'id', type: DataType.INT32, primaryKey: true, autoInc: true },
      { name: 'text', type: DataType.TEXT, notNull: true },
      { name: 'timestamp', type: DataType.INT32, notNull: true },
    ]);

    const snapshots: any[][] = [];
    const subscription = db
      .from('messages')
      .orderBy('timestamp', 'asc')
      .live((rows) => {
        snapshots.push([...rows]);
      });

    // Wait initial tick
    await new Promise((r) => setTimeout(r, 25));

    await db.insert('messages', { text: 'Hello World', timestamp: 100 });
    await new Promise((r) => setTimeout(r, 35));

    await db.insert('messages', { text: 'Second Message', timestamp: 200 });
    await new Promise((r) => setTimeout(r, 35));

    await db.insert('messages', { text: 'Early Message', timestamp: 50 });
    await new Promise((r) => setTimeout(r, 35));

    subscription.destroy();

    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    const lastSnapshot = snapshots[snapshots.length - 1];
    expect(lastSnapshot).toHaveLength(3);
    // Verify live query ordering
    expect(lastSnapshot[0].text).toBe('Early Message');
    expect(lastSnapshot[1].text).toBe('Hello World');
    expect(lastSnapshot[2].text).toBe('Second Message');
  });

  it('handles transactions with atomic commit and rollback on persistent storage', async () => {
    const db = await openIdb();

    await db.createTable('wallets', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'balance', type: DataType.FLOAT64, notNull: true },
    ]);

    await db.insertMany('wallets', [
      { id: 1, balance: 1000.0 },
      { id: 2, balance: 500.0 },
    ]);

    // Successful transaction
    await db.transaction(async (tx) => {
      await tx.update('wallets', 1, { balance: 900.0 });
      await tx.update('wallets', 2, { balance: 600.0 });
    });

    const w1 = await db.from('wallets').where('id', '=', 1).first();
    const w2 = await db.from('wallets').where('id', '=', 2).first();
    expect(w1?.balance).toBe(900.0);
    expect(w2?.balance).toBe(600.0);

    // Rolling back transaction on error
    await expect(
      db.transaction(async (tx) => {
        await tx.update('wallets', 1, { balance: 500.0 });
        throw new Error('Transaction aborted intentional fail');
      }),
    ).rejects.toThrow('Transaction aborted intentional fail');

    // Values should remain as they were before the aborted transaction
    const w1After = await db.from('wallets').where('id', '=', 1).first();
    expect(w1After?.balance).toBe(900.0);
  });
});

