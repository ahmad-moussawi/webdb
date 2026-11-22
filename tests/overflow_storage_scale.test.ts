import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebDB, DataType } from '../src/index.js';
import { OpfsStorage } from '../src/host/storage/opfs.js';
import { testEngine } from "./helpers/test_engine.js";
import { IdbStorage } from "@ahmadmoussawi/webdb/storage/idb";

let openedDbs: WebDB[] = [];

afterEach(async () => {
  await Promise.all(openedDbs.map((db) => db.close().catch(() => {})));
  openedDbs = [];
});

function installMockOpfs(): { files: Map<string, Uint8Array>; restore: () => void } {
  const files = new Map<string, Uint8Array>();

  const makeFileHandle = (name: string) => ({
    async getFile() {
      const buf = files.get(name) ?? new Uint8Array(0);
      return {
        size: buf.byteLength,
        slice(start: number, end: number) {
          const sliced = buf.slice(start, end);
          return {
            async arrayBuffer() {
              return sliced.buffer.slice(
                sliced.byteOffset,
                sliced.byteOffset + sliced.byteLength,
              );
            },
          };
        },
      };
    },
    async createWritable(opts?: { keepExistingData?: boolean }) {
      const existing = opts?.keepExistingData ? (files.get(name) ?? new Uint8Array(0)) : new Uint8Array(0);
      let working = existing;
      let size = existing.byteLength;
      let cursor = 0;
      return {
        async seek(pos: number) {
          cursor = pos;
        },
        async write(data: Uint8Array) {
          const needed = cursor + data.byteLength;
          if (needed > working.byteLength) {
            const nextCap = Math.max(needed, working.byteLength * 2, 65536);
            const grown = new Uint8Array(nextCap);
            grown.set(working.subarray(0, size));
            working = grown;
          }
          working.set(data, cursor);
          cursor += data.byteLength;
          if (needed > size) size = needed;
        },
        async truncate(newSize: number) {
          if (newSize > working.byteLength) {
            const nextCap = Math.max(newSize, working.byteLength * 2, 65536);
            const grown = new Uint8Array(nextCap);
            grown.set(working.subarray(0, size));
            working = grown;
          }
          size = newSize;
        },
        async close() {
          files.set(name, working.subarray(0, size));
        },
      };
    },
  });

  const prevNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      ...(prevNavigator ?? {}),
      storage: {
        async getDirectory() {
          return {
            async getFileHandle(name: string) {
              if (!files.has(name)) files.set(name, new Uint8Array(0));
              return makeFileHandle(name);
            },
          };
        },
      },
    },
    configurable: true,
    writable: true,
  });

  return {
    files,
    restore() {
      Object.defineProperty(globalThis, 'navigator', {
        value: prevNavigator,
        configurable: true,
        writable: true,
      });
    },
  };
}

function makeDeterministicText(prefix: string, id: number, targetLen: number): string {
  const token = `[${prefix}:${id}]`;
  const unit = `${token}_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_`;
  const repeats = Math.ceil(targetLen / unit.length);
  return unit.repeat(repeats).slice(0, targetLen);
}

describe('Extensive Scale Integration: Thousands of Multi-TEXT Rows on IndexedDB & OPFS', () => {
  it(
    'IndexedDB: inserts, queries, updates, deletes, and recovers 2,000 multi-TEXT rows with overflow pages',
    async () => {
      const dbName = `idb_scale_overflow_${Date.now()}_${Math.random()}`;
      const db1 = await WebDB.open({ name: dbName, engine: testEngine(), storage: new IdbStorage(dbName) });
      openedDbs.push(db1);

      await db1.createTable('articles', [
        { name: 'id', type: DataType.INT32, primaryKey: true },
        { name: 'category', type: DataType.TEXT, notNull: true },
        { name: 'title', type: DataType.TEXT, notNull: true },
        { name: 'summary', type: DataType.TEXT, notNull: true },
        { name: 'body', type: DataType.TEXT, notNull: true },
        { name: 'notes', type: DataType.TEXT },
      ]);
      await db1.createIndex('articles', 'category', { name: 'idx_articles_category' });

      const TOTAL_ROWS = 2000;
      const BATCH_SIZE = 500;
      const categories = ['engineering', 'science', 'design', 'product', 'ops'];

      const expectedRows = new Map<
        number,
        { category: string; title: string; summary: string; body: string; notes: string }
      >();

      for (let start = 1; start <= TOTAL_ROWS; start += BATCH_SIZE) {
        const batch = [];
        for (let id = start; id < start + BATCH_SIZE; id++) {
          const category = categories[id % categories.length];
          const title = `Article #${id} (${category})`;
          // Mix inline rows and multi-column overflow rows (> 3,800 B combined)
          const summaryLen = id % 3 === 0 ? 1800 : 400;
          const bodyLen = id % 2 === 0 ? 5200 : 2200;
          const notesLen = id % 4 === 0 ? 4500 : 120;

          const summary = makeDeterministicText('SUM', id, summaryLen);
          const body = makeDeterministicText('BODY', id, bodyLen);
          const notes = makeDeterministicText('NOTE', id, notesLen);

          const row = { id, category, title, summary, body, notes };
          batch.push(row);
          expectedRows.set(id, { category, title, summary, body, notes });
        }
        await db1.insertMany('articles', batch);
      }

      // 1. Total row count
      const countRes = await db1.from('articles').count('id', 'total').toArray();
      expect(countRes[0].total).toBe(TOTAL_ROWS);

      // 2. Selective projection (only inline columns, skipping TOAST hydration)
      const titlesOnly = await db1
        .from('articles')
        .select('id', 'title')
        .where('category', '=', 'engineering')
        .orderBy('id', 'asc')
        .toArray();
      expect(titlesOnly).toHaveLength(TOTAL_ROWS / categories.length);
      expect(titlesOnly[0]).toEqual({ id: 5, title: 'Article #5 (engineering)' });
      expect(titlesOnly[titlesOnly.length - 1]).toEqual({
        id: 2000,
        title: 'Article #2000 (engineering)',
      });

      // 3. Full multi-column TOAST hydration via indexed filter + pagination
      const pageRows = await db1
        .from('articles')
        .where('category', '=', 'science')
        .orderBy('id', 'desc')
        .offset(10)
        .limit(15)
        .toArray();
      expect(pageRows).toHaveLength(15);
      for (const r of pageRows) {
        const exp = expectedRows.get(r.id as number)!;
        expect(r.title).toBe(exp.title);
        expect(r.summary).toBe(exp.summary);
        expect(r.body).toBe(exp.body);
        expect(r.notes).toBe(exp.notes);
      }

      // 4. VDBE WHERE LIKE on overflow TEXT column
      const needleMatch = await db1
        .from('articles')
        .where('body', 'LIKE', '%[BODY:1338]%')
        .toArray();
      expect(needleMatch).toHaveLength(1);
      expect(needleMatch[0].id).toBe(1338);
      expect(needleMatch[0].body).toBe(expectedRows.get(1338)!.body);

      // 5. Bulk update 400 'ops' rows + targeted inline<->overflow flips, and bulk delete 400 'product' rows
      const bulkUpdatedBody = makeDeterministicText('BULK_OPS_BODY', 9999, 6400);
      const bulkUpdatedNotes = makeDeterministicText('BULK_OPS_NOTE', 9999, 4300);
      await db1.transaction(async (tx) => {
        await tx.update(
          'articles',
          { category: 'ops' },
          { body: bulkUpdatedBody, notes: bulkUpdatedNotes },
        );
        for (const [id, exp] of expectedRows) {
          if (exp.category === 'ops') {
            exp.body = bulkUpdatedBody;
            exp.notes = bulkUpdatedNotes;
          }
        }

        for (const id of [10, 20, 500]) {
          const newBody = makeDeterministicText('UPDATED_BODY', id, id % 20 === 0 ? 600 : 7500);
          const newNotes = makeDeterministicText('UPDATED_NOTE', id, 4200);
          await tx.update('articles', { id }, { body: newBody, notes: newNotes });
          const prev = expectedRows.get(id)!;
          prev.body = newBody;
          prev.notes = newNotes;
        }

        await tx.delete('articles', { category: 'product' });
        for (const [id, exp] of expectedRows) {
          if (exp.category === 'product') {
            expectedRows.delete(id);
          }
        }
      });

      await db1.close();

      // 6. Reopen from IndexedDB and verify persistence & recovery
      const db2 = await WebDB.open({ name: dbName, engine: testEngine(), storage: new IdbStorage(dbName) });
      openedDbs.push(db2);

      const postCount = await db2.from('articles').count('id', 'total').toArray();
      expect(postCount[0].total).toBe(expectedRows.size);

      // Spot check updated, untouched, and deleted rows
      for (const checkId of [1, 10, 20, 499, 500, 1500, 2000]) {
        const res = await db2.from('articles').where('id', '=', checkId).toArray();
        expect(res).toHaveLength(1);
        const exp = expectedRows.get(checkId)!;
        expect(res[0].summary).toBe(exp.summary);
        expect(res[0].body).toBe(exp.body);
        expect(res[0].notes).toBe(exp.notes);
      }

      const deletedCheck = await db2
        .from('articles')
        .where('category', '=', 'product')
        .toArray();
      expect(deletedCheck).toHaveLength(0);
    },
    180_000,
  );

  it(
    'OPFS: inserts, checkpoints, queries, updates, and crash-recovers 2,000 multi-TEXT rows with overflow pages',
    async () => {
      const mockOpfs = installMockOpfs();
      const opfsName = `opfs_scale_overflow_${Date.now()}_${Math.random()}`;

      try {
        const vfs1 = new OpfsStorage(opfsName);
        const db1 = await WebDB.open({ engine: testEngine(), storage: vfs1 });

        await db1.createTable('documents', [
          { name: 'id', type: DataType.INT32, primaryKey: true },
          { name: 'tag', type: DataType.TEXT, notNull: true },
          { name: 'col_a', type: DataType.TEXT, notNull: true },
          { name: 'col_b', type: DataType.TEXT, notNull: true },
          { name: 'col_c', type: DataType.TEXT, notNull: true },
        ]);
        await db1.createIndex('documents', 'tag', { name: 'idx_documents_tag' });

        const TOTAL_ROWS = 2000;
        const BATCH_SIZE = 500;
        const tags = ['alpha', 'beta', 'gamma', 'delta'];
        const expected = new Map<
          number,
          { tag: string; col_a: string; col_b: string; col_c: string }
        >();

        for (let start = 1; start <= TOTAL_ROWS; start += BATCH_SIZE) {
          const batch = [];
          for (let id = start; id < start + BATCH_SIZE; id++) {
            const tag = tags[id % tags.length];
            const col_a = makeDeterministicText('A', id, 600);
            const col_b = makeDeterministicText('B', id, id % 2 === 0 ? 4800 : 1900);
            const col_c = makeDeterministicText('C', id, id % 3 === 0 ? 5500 : 1600);
            batch.push({ id, tag, col_a, col_b, col_c });
            expected.set(id, { tag, col_a, col_b, col_c });
          }
          await db1.insertMany('documents', batch);
        }

        // Force WAL checkpoint mid-run and verify OPFS file backing grew appropriately
        await db1.checkpoint();
        const dbFileBytes = mockOpfs.files.get(`${opfsName}.db`)?.byteLength ?? 0;
        expect(dbFileBytes).toBeGreaterThan(2 * 1024 * 1024);

        const countRes = await db1.from('documents').count('id', 'total').toArray();
        expect(countRes[0].total).toBe(TOTAL_ROWS);

        // Uncheckpointed transaction with bulk updates + targeted updates + bulk deletes before simulated abrupt crash
        const bulkNewB = makeDeterministicText('B_BULK', 7777, 6200);
        const bulkNewC = makeDeterministicText('C_BULK', 7777, 4100);
        await db1.transaction(async (tx) => {
          await tx.update('documents', { tag: 'delta' }, { col_b: bulkNewB, col_c: bulkNewC });
          for (const [, exp] of expected) {
            if (exp.tag === 'delta') {
              exp.col_b = bulkNewB;
              exp.col_c = bulkNewC;
            }
          }

          for (const id of [25, 250, 501]) {
            const newB = makeDeterministicText('B_NEW', id, 6200);
            const newC = makeDeterministicText('C_NEW', id, 4100);
            await tx.update('documents', { id }, { col_b: newB, col_c: newC });
            const prev = expected.get(id)!;
            prev.col_b = newB;
            prev.col_c = newC;
          }

          await tx.delete('documents', { tag: 'alpha' });
          for (const [id, exp] of expected) {
            if (exp.tag === 'alpha') {
              expected.delete(id);
            }
          }
        });

        // Simulate abrupt crash (open new OpfsStorage without calling db1.close())
        const db2 = await WebDB.open({
          engine: testEngine(),
          storage: new OpfsStorage(opfsName),
        });
        openedDbs.push(db2);

        const postCount = await db2.from('documents').count('id', 'total').toArray();
        expect(postCount[0].total).toBe(expected.size);

        // Verify indexed query + ORDER BY + LIMIT/OFFSET + full multi-column TOAST hydration
        const gammaSlice = await db2
          .from('documents')
          .where('tag', '=', 'gamma')
          .orderBy('id', 'asc')
          .offset(20)
          .limit(20)
          .toArray();
        expect(gammaSlice).toHaveLength(20);
        for (const r of gammaSlice) {
          const exp = expected.get(r.id as number)!;
          expect(r.col_a).toBe(exp.col_a);
          expect(r.col_b).toBe(exp.col_b);
          expect(r.col_c).toBe(exp.col_c);
        }

        // Verify updated overflow rows survived WAL crash recovery
        for (const updatedId of [25, 250, 501, 1999]) {
          const rows = await db2.from('documents').where('id', '=', updatedId).toArray();
          expect(rows).toHaveLength(1);
          expect(rows[0].col_b).toBe(expected.get(updatedId)!.col_b);
          expect(rows[0].col_c).toBe(expected.get(updatedId)!.col_c);
        }

        // Verify LIKE search across overflow col_b
        const likeMatch = await db2
          .from('documents')
          .where('col_b', 'LIKE', '%[B:1502]%')
          .toArray();
        expect(likeMatch).toHaveLength(1);
        expect(likeMatch[0].id).toBe(1502);
      } finally {
        mockOpfs.restore();
      }
    },
    180_000,
  );
});

