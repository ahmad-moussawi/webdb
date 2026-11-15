import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  WebDB,
  IndexKeySizeExceededError,
  MAX_INDEX_KEY_SIZE,
} from '../src/index.js';
import { MemoryVfsAdapter } from '../src/host/storage/memory.js';

describe('Phase 2: Row Overflow Pages (TOAST) & Relaxed Row Limits', () => {
  it('1. Inserts and queries large TEXT (10 KB, 50 KB) and BLOB (120 KB) rows seamlessly', async () => {
    const db = await WebDB.open({ name: 'test_overflow_basic', storage: 'memory' });

    await db.createTable('articles', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'title', type: 'TEXT', notNull: true },
      { name: 'body', type: 'TEXT' },
      { name: 'attachment', type: 'BLOB' },
    ]);

    const body10k = 'Lorem ipsum dolor sit amet. '.repeat(360); // ~10 KB
    const body50k = 'WebDB Overflow Storage Engine! '.repeat(1650); // ~51 KB
    const blob120k = new Uint8Array(120_000);
    for (let i = 0; i < blob120k.length; i++) {
      blob120k[i] = i & 0xff;
    }

    await db.insertMany('articles', [
      { id: 1, title: 'Short', body: 'Small body', attachment: new Uint8Array([1, 2, 3]) },
      { id: 2, title: 'Medium 10K', body: body10k, attachment: null },
      { id: 3, title: 'Large 50K + 120K Blob', body: body50k, attachment: blob120k },
    ]);

    // Full row hydration
    const rows = await db.from('articles').orderBy('id', 'asc').toArray();
    expect(rows).toHaveLength(3);
    expect(rows[0].body).toBe('Small body');
    expect(rows[1].body).toBe(body10k);
    expect(rows[2].body).toBe(body50k);
    expect(rows[2].attachment).toEqual(blob120k);

    // Partial projection (lazy TOAST: only inline metadata columns)
    const metaOnly = await db.from('articles').select('id', 'title').orderBy('id', 'asc').toArray();
    expect(metaOnly).toEqual([
      { id: 1, title: 'Short' },
      { id: 2, title: 'Medium 10K' },
      { id: 3, title: 'Large 50K + 120K Blob' },
    ]);

    await db.close();
  });

  it('2. Evaluates WHERE filters (LIKE / equality) on overflow TEXT columns inside VDBE VM', async () => {
    const db = await WebDB.open({ name: 'test_overflow_where', storage: 'memory' });

    await db.createTable('docs', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'content', type: 'TEXT' },
    ]);

    const pad = 'A'.repeat(12_000);
    await db.insertMany('docs', [
      { id: 1, content: `${pad}ALPHA_TOKEN${pad}` },
      { id: 2, content: `${pad}BETA_NEEDLE${pad}` },
      { id: 3, content: `${pad}GAMMA_TOKEN${pad}` },
    ]);

    const matched = await db
      .from('docs')
      .where('content', 'LIKE', '%BETA_NEEDLE%')
      .toArray();

    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe(2);
    expect((matched[0].content as string).includes('BETA_NEEDLE')).toBe(true);

    await db.close();
  });

  it('3. Frees and recycles overflow pages on UPDATE and DELETE without leaking pages', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_overflow_reclaim', storage: vfs });

    await db.createTable('blobs', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'data', type: 'TEXT' },
    ]);

    // Insert 40 KB row (~10 overflow pages)
    const payload40k = 'Z'.repeat(40_000);
    await db.insert('blobs', { id: 1, data: payload40k });

    const sizeAfterInsert = (await db.exportBinary()).byteLength;

    // Update row to another 40 KB payload -> old 10 overflow pages freed & recycled for new payload
    const updated40k = 'Y'.repeat(40_000);
    await db.update('blobs', { id: 1 }, { data: updated40k });

    const fetched = await db.from('blobs').where('id', '=', 1).toArray();
    expect(fetched).toHaveLength(1);
    expect(fetched[0].data).toBe(updated40k);

    const sizeAfterUpdate = (await db.exportBinary()).byteLength;
    // Recycling freed pages means file size should not grow significantly (at most 1 page if tail split)
    expect(sizeAfterUpdate).toBeLessThanOrEqual(sizeAfterInsert + 4096);

    // Delete row and re-insert 40 KB row -> should reuse freed overflow pages
    await db.delete('blobs', { id: 1 });
    await db.insert('blobs', { id: 2, data: 'W'.repeat(40_000) });

    const sizeAfterReinsert = (await db.exportBinary()).byteLength;
    expect(sizeAfterReinsert).toBeLessThanOrEqual(sizeAfterUpdate + 4096);

    const afterReinsert = await db.from('blobs').toArray();
    expect(afterReinsert).toHaveLength(1);
    expect(afterReinsert[0].id).toBe(2);
    expect((afterReinsert[0].data as string).length).toBe(40_000);

    await db.close();
  });

  it('4. Enforces MAX_INDEX_KEY_SIZE (1024B) on indexed columns while allowing overflow on non-indexed columns', async () => {
    const db = await WebDB.open({ name: 'test_overflow_index_limit', storage: 'memory' });

    await db.createTable('posts', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'slug', type: 'TEXT' },
      { name: 'body', type: 'TEXT' },
    ]);
    await db.createIndex('posts', 'slug', { name: 'idx_posts_slug' });

    // Non-indexed overflow column (20 KB) with short indexed slug (100 B) -> succeeds
    await db.insert('posts', {
      id: 1,
      slug: 'valid-short-slug',
      body: 'B'.repeat(20_000),
    });

    // Indexed column exceeding MAX_INDEX_KEY_SIZE (1024 B) -> throws IndexKeySizeExceededError
    await expect(
      db.insert('posts', {
        id: 2,
        slug: 'K'.repeat(MAX_INDEX_KEY_SIZE + 1),
        body: 'short',
      }),
    ).rejects.toThrow(IndexKeySizeExceededError);

    // Creating an index on a column that already contains > 1024B values -> throws IndexKeySizeExceededError
    await expect(
      db.createIndex('posts', 'body', { name: 'idx_posts_body' }),
    ).rejects.toThrow(IndexKeySizeExceededError);

    const rows = await db.from('posts').where('slug', '=', 'valid-short-slug').toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0].body as string).length).toBe(20_000);

    await db.close();
  });

  it('5. Preserves overflow rows across ALTER TABLE (addColumn / dropColumn)', async () => {
    const db = await WebDB.open({ name: 'test_overflow_alter', storage: 'memory' });

    await db.createTable('notes', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'legacy_col', type: 'INT32' },
      { name: 'markdown', type: 'TEXT' },
    ]);

    const hugeMarkdown = '# Heading\n\n' + 'Paragraph content. '.repeat(1000); // ~19 KB
    await db.insert('notes', { id: 1, legacy_col: 42, markdown: hugeMarkdown });

    await db.addColumn('notes', { name: 'tag', type: 'TEXT' }, { defaultValue: 'v2' });
    await db.dropColumn('notes', 'legacy_col');

    const rows = await db.from('notes').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      markdown: hugeMarkdown,
      tag: 'v2',
    });

    await db.close();
  });

  it('6. Persists and recovers overflow pages across close/reopen with IndexedDB VFS & WAL', async () => {
    const dbName = `test_overflow_idb_wal_${Date.now()}_${Math.random()}`;
    const db1 = await WebDB.open({ name: dbName, storage: 'idb' });

    await db1.createTable('assets', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'payload', type: 'TEXT' },
    ]);

    const bigText = 'IndexedDB-WAL-Overflow-'.repeat(1500); // ~34.5 KB
    await db1.insert('assets', { id: 101, payload: bigText });
    await db1.close();

    // Reopen fresh instance from the same IndexedDB store
    const db2 = await WebDB.open({ name: dbName, storage: 'idb' });
    const rows = await db2.from('assets').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(101);
    expect(rows[0].payload).toBe(bigText);

    await db2.close();
  });
});

