import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/webdb.js';
import {
  InvalidDatabaseError,
  DataType,
  ColumnDefinition,
} from '../src/types.js';
import { MemoryVfsAdapter } from '../src/storage/memory.js';

describe('Test Suite 2: Schema Catalog & Page 1 Binary Structs (tests/catalog_binary.test.ts)', () => {
  it('1. Magic Bytes Validation (corrupt byte 0 -> InvalidDatabaseError)', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_corrupt_magic', vfs });
    await db.createTable('t1', [{ name: 'id', type: 'INT32' }]);
    await db.close();

    // Corrupt byte 0 of Page 1 in the VFS
    const page1Bytes = await vfs.readPage(1);
    expect(page1Bytes).not.toBeNull();
    page1Bytes![0] = 0xFF; // Corrupt 'W'
    await vfs.writePage(1, page1Bytes!);

    // Reopen must throw InvalidDatabaseError
    await expect(
      WebDB.open({ name: 'test_corrupt_magic', vfs })
    ).rejects.toThrow(InvalidDatabaseError);
  });

  it('2. Schema Persistence across close and reopen with 5 tables', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_schema_persistence', vfs });

    await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'email', type: 'TEXT', flags: { notNull: true } },
      { name: 'active', type: 'INT32' },
    ]);

    await db.createTable('products', [
      { name: 'sku', type: 'TEXT', flags: { primaryKey: true } },
      { name: 'price', type: 'FLOAT64' },
      { name: 'stock', type: 'INT32' },
    ]);

    await db.createTable('orders', [
      { name: 'order_id', type: 'INT64', flags: { primaryKey: true } },
      { name: 'user_id', type: 'INT32' },
      { name: 'total', type: 'FLOAT64' },
    ]);

    await db.createTable('identity_records', [
      { name: 'id', type: 'ulid', flags: { primaryKey: true } },
      { name: 'uuid_field', type: 'uuid' },
    ]);

    await db.createTable('blobs', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'data', type: 'BLOB' },
    ]);

    await db.close();

    // Re-open and verify bit-level reconstruction
    const db2 = await WebDB.open({ name: 'test_schema_persistence', vfs });

    const users = await db2.getTable('users');
    expect(users.columns).toHaveLength(3);
    expect(users.columns[0].name).toBe('id');
    expect(users.columns[0].type).toBe(DataType.INT32);
    expect(users.columns[1].name).toBe('email');
    expect(users.columns[1].type).toBe(DataType.TEXT);

    const products = await db2.getTable('products');
    expect(products.columns).toHaveLength(3);
    expect(products.columns[1].name).toBe('price');
    expect(products.columns[1].type).toBe(DataType.FLOAT64);

    const orders = await db2.getTable('orders');
    expect(orders.columns).toHaveLength(3);
    expect(orders.columns[0].type).toBe(DataType.INT64);

    const identity = await db2.getTable('identity_records');
    expect(identity.columns[0].type).toBe(DataType.ULID);
    expect(identity.columns[1].type).toBe(DataType.UUID);

    const blobs = await db2.getTable('blobs');
    expect(blobs.columns[1].type).toBe(DataType.BLOB);

    await db2.close();
  });

  it('3. Schema Version Increment on every table creation', async () => {
    const db = await WebDB.open({ name: 'test_schema_version_inc', storage: 'memory' });
    const initialVersion = db.pool.getSlotDataView(0).getUint32(20, true);
    expect(initialVersion).toBe(1);

    await db.createTable('tbl1', [{ name: 'id', type: 'INT32' }]);
    expect(db.pool.getSlotDataView(0).getUint32(20, true)).toBe(2);

    await db.createTable('tbl2', [{ name: 'id', type: 'INT32' }]);
    expect(db.pool.getSlotDataView(0).getUint32(20, true)).toBe(3);

    await db.createTable('tbl3', [{ name: 'id', type: 'INT32' }]);
    expect(db.pool.getSlotDataView(0).getUint32(20, true)).toBe(4);

    await db.close();
  });

  it('4. Dedicated Column Catalog Pages & 100-Column Table Support', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_100_cols', vfs });

    // Build 100 column definitions (spans 2 dedicated catalog pages, since 56 cols/page)
    const columns: ColumnDefinition[] = [];
    columns.push({ name: 'id', type: 'INT32', flags: { primaryKey: true } });
    for (let i = 1; i < 100; i++) {
      columns.push({ name: `col_${i}`, type: i % 2 === 0 ? 'INT32' : 'FLOAT64' });
    }

    const table = await db.createTable('wide_table', columns);
    expect(table.columnCount).toBe(100);
    expect(table.columns).toHaveLength(100);

    // Close and reopen
    await db.close();

    const db2 = await WebDB.open({ name: 'test_100_cols', vfs });
    const reopened = await db2.getTable('wide_table');

    expect(reopened.columnCount).toBe(100);
    expect(reopened.columns).toHaveLength(100);
    expect(reopened.columns[0].name).toBe('id');
    expect(reopened.columns[55].name).toBe('col_55');
    expect(reopened.columns[56].name).toBe('col_56');
    expect(reopened.columns[99].name).toBe('col_99');

    // Test insert and select on wide table
    const row: Record<string, any> = { id: 1 };
    for (let i = 1; i < 100; i++) {
      row[`col_${i}`] = i;
    }
    await db2.insert('wide_table', row);

    const fetched = await db2.from('wide_table').where('id', '=', 1).first();
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(1);
    expect(fetched!.col_55).toBe(55);
    expect(fetched!.col_99).toBe(99);

    await db2.close();
  });
});
