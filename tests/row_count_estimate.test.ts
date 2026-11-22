import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/index.ts';
import { testEngine } from "./helpers/test_engine.js";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";

describe('rowCountEstimate stays in sync with DML', () => {
  it('is reflected by getTable/listTables after insert, insertMany, delete and rollback', async () => {
    const db = await WebDB.open({ name: 'rc', engine: testEngine(), storage: new MemoryStorage() });
    await db.createTable('t', [{ name: 'id', type: 'INT32', flags: { primaryKey: true } }]);
    // Prime the metadata cache before any DML
    expect((await db.getTable('t')).rowCountEstimate).toBe(0);

    await db.insert('t', { id: 1 });
    await db.insertMany('t', [{ id: 2 }, { id: 3 }]);
    expect((await db.getTable('t')).rowCountEstimate).toBe(3);
    expect((await db.listTables())[0].rowCountEstimate).toBe(3);

    await db.delete('t', { id: 1 });
    expect((await db.listTables())[0].rowCountEstimate).toBe(2);

    await expect(
      db.transaction(async (tx) => {
        await tx.insert('t', { id: 10 });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await db.listTables())[0].rowCountEstimate).toBe(2);
  });

  it('survives close and reopen', async () => {
    const { MemoryStorage } = await import('../src/index.ts');
    const vfs = new MemoryStorage();
    const a = await WebDB.open({ name: 'rc2', engine: testEngine(), storage: vfs });
    await a.createTable('t', [{ name: 'id', type: 'INT32', flags: { primaryKey: true } }]);
    await a.insertMany('t', [{ id: 1 }, { id: 2 }]);
    await a.close();
    const b = await WebDB.open({ name: 'rc2', engine: testEngine(), storage: vfs });
    expect((await b.listTables())[0].rowCountEstimate).toBe(2);
  });
});

