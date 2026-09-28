import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.ts';
import {
  UniqueConstraintViolationError,
  NotNullConstraintError,
  IndexFlag,
} from '../src/types/index.ts';

describe('Primary Key & Unique Constraint Enforcement (Phase 1)', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'pk_enforcement_test', storage: 'memory' });
  });

  it('automatically registers primary key IndexDescriptor on createTable', async () => {
    const table = await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'name', type: 'TEXT' },
    ]);

    expect(table.primaryKey).toEqual(['id']);
    expect(table.indexes).toBeDefined();
    expect(table.indexes).toHaveLength(1);

    const pkIndex = table.indexes![0];
    expect(pkIndex.name).toBe('pk_users');
    expect(pkIndex.tableId).toBe(table.tableId);
    expect(pkIndex.rootPageId).toBeGreaterThan(0);
    expect(pkIndex.columnCount).toBe(1);
    expect((pkIndex.flags & IndexFlag.PRIMARY) !== 0).toBe(true);
    expect((pkIndex.flags & IndexFlag.UNIQUE) !== 0).toBe(true);
  });

  it('rejects duplicate primary key inserts with UniqueConstraintViolationError', async () => {
    await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'name', type: 'TEXT' },
    ]);

    await db.insert('users', { id: 1, name: 'Alice' });
    await db.insert('users', { id: 2, name: 'Bob' });

    // Attempting duplicate ID 1 must fail
    await expect(db.insert('users', { id: 1, name: 'Alice Duplicate' })).rejects.toThrow(
      UniqueConstraintViolationError,
    );
    await expect(db.insert('users', { id: 1, name: 'Alice Duplicate' })).rejects.toThrow(
      /Duplicate key value violates unique constraint "pk_users"/,
    );

    // Verify only the 2 original rows exist
    const rows = await db.from('users').toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
  });

  it('enforces NOT NULL constraint on primary key columns', async () => {
    await db.createTable('accounts', [
      { name: 'acc_id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'balance', type: 'FLOAT64' },
    ]);

    // Explicit null
    await expect(
      db.insert('accounts', { acc_id: null as any, balance: 100.0 }),
    ).rejects.toThrow(NotNullConstraintError);

    // Missing key
    await expect(
      db.insert('accounts', { balance: 200.0 } as any),
    ).rejects.toThrow(NotNullConstraintError);
  });

  it('supports AUTO_INC primary key and catches duplicate explicit inserts', async () => {
    await db.createTable('tickets', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, autoInc: true } },
      { name: 'title', type: 'TEXT' },
    ]);

    // Auto-assigned 1 and 2
    await db.insert('tickets', { title: 'Ticket 1' });
    await db.insert('tickets', { title: 'Ticket 2' });

    const rows = await db.from('tickets').toArray();
    expect(rows).toEqual([
      { id: 1, title: 'Ticket 1' },
      { id: 2, title: 'Ticket 2' },
    ]);

    // Inserting an explicit duplicate ID 1 must fail
    await expect(db.insert('tickets', { id: 1, title: 'Conflict' })).rejects.toThrow(
      UniqueConstraintViolationError,
    );
  });

  it('enforces composite primary key uniqueness', async () => {
    await db.createTable('order_items', [
      { name: 'order_id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'item_id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'qty', type: 'INT32' },
    ]);

    const table = await db.getTable('order_items');
    expect(table.primaryKey).toEqual(['order_id', 'item_id']);
    expect(table.indexes![0].columnCount).toBe(2);

    // Insert valid distinct combinations
    await db.insert('order_items', { order_id: 100, item_id: 1, qty: 5 });
    await db.insert('order_items', { order_id: 100, item_id: 2, qty: 2 });
    await db.insert('order_items', { order_id: 101, item_id: 1, qty: 1 });

    // Inserting exact duplicate (100, 1) must be rejected
    await expect(
      db.insert('order_items', { order_id: 100, item_id: 1, qty: 99 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    const rows = await db.from('order_items').toArray();
    expect(rows).toHaveLength(3);
  });

  it('supports TEXT primary key uniqueness', async () => {
    await db.createTable('currencies', [
      { name: 'code', type: 'TEXT', flags: { primaryKey: true } },
      { name: 'symbol', type: 'TEXT' },
    ]);

    await db.insert('currencies', { code: 'USD', symbol: '$' });
    await db.insert('currencies', { code: 'EUR', symbol: '€' });

    await expect(
      db.insert('currencies', { code: 'USD', symbol: 'US$' }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    const rows = await db.from('currencies').toArray();
    expect(rows).toHaveLength(2);
  });

  it('scales across multiple index leaf pages (> 255 keys) and rejects duplicates', async () => {
    await db.createTable('big_table', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'val', type: 'INT32' },
    ]);

    // Insert 300 entries (a 4KB index leaf holds ~255 int cells, so this triggers page chaining)
    for (let i = 1; i <= 300; i++) {
      await db.insert('big_table', { id: i, val: i * 10 });
    }

    const rows = await db.from('big_table').toArray();
    expect(rows).toHaveLength(300);

    // Duplicate check on early page (id: 10)
    await expect(
      db.insert('big_table', { id: 10, val: 999 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Duplicate check on chained page (id: 280)
    await expect(
      db.insert('big_table', { id: 280, val: 999 }),
    ).rejects.toThrow(UniqueConstraintViolationError);
  });
});
