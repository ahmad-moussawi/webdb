import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { MemoryVfsAdapter } from '../src/host/storage/memory.js';
import {
  TableNotFoundError,
  TableAlreadyExistsError,
  ColumnNotFoundError,
  ColumnAlreadyExistsError,
  CannotDropColumnError,
  IdentifierTooLongError,
  NotNullConstraintError,
  UniqueConstraintViolationError,
  RowSizeLimitExceededError,
  ColumnDefinition,
} from '../src/types/index.js';

describe('Schema Mutations & ALTER TABLE (tests/alter_table.test.ts)', () => {
  it('1. renameTable: O(1) metadata rename, preserves data, indexes, and persists across reopen', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_rename_table', vfs });

    const created = await db.createTable('accounts', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'email', type: 'TEXT', notNull: true },
      { name: 'balance', type: 'FLOAT64' },
    ]);
    await db.createIndex('accounts', 'email', { unique: true });
    await db.createIndex('accounts', 'balance', { name: 'custom_balance_idx' });

    await db.insertMany('accounts', [
      { email: 'a@example.com', balance: 100.5 },
      { email: 'b@example.com', balance: 250.75 },
    ]);

    const renamed = await db.renameTable('accounts', 'customers');
    expect(renamed.name).toBe('customers');
    expect(renamed.rootPageId).toBe(created.rootPageId); // O(1) in-place metadata update
    expect(renamed.colCatalogPageId).toBe(created.colCatalogPageId);

    // Old table name no longer resolves
    await expect(db.getTable('accounts')).rejects.toThrow(TableNotFoundError);

    // Auto-named indexes updated, custom index name preserved
    const indexes = await db.listIndexes('customers');
    expect(indexes.map((i) => i.name).sort()).toEqual([
      'custom_balance_idx',
      'idx_customers_email',
      'pk_customers',
    ]);

    // Queries and index scans work on new table name
    const row = await db.from('customers').where('email', '=', 'b@example.com').first();
    expect(row).toEqual({ id: 2, email: 'b@example.com', balance: 250.75 });

    // Auto-increment sequence continues seamlessly
    await db.insert('customers', { email: 'c@example.com', balance: 500 });
    const row3 = await db.from('customers').where('email', '=', 'c@example.com').first();
    expect(row3?.id).toBe(3);

    // Validation errors
    await expect(db.renameTable('non_existent', 'foo')).rejects.toThrow(TableNotFoundError);
    await expect(db.renameTable('customers', 'x'.repeat(65))).rejects.toThrow(
      IdentifierTooLongError,
    );

    await db.createTable('other_tbl', [{ name: 'id', type: 'INT32' }]);
    await expect(db.renameTable('customers', 'other_tbl')).rejects.toThrow(
      TableAlreadyExistsError,
    );

    await db.close();

    // Reopen and verify persistence
    const db2 = await WebDB.open({ name: 'test_rename_table', vfs });
    const rowsAfterReopen = await db2.from('customers').orderBy('id', 'asc').toArray();
    expect(rowsAfterReopen).toHaveLength(3);
    expect(rowsAfterReopen[2]).toEqual({ id: 3, email: 'c@example.com', balance: 500 });
    await db2.close();
  });

  it('2. renameColumn: O(1) metadata rename across single and multi-page catalogs, preserving indexes', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_rename_col', vfs });

    // Create a 65-column table (spans 2 column catalog pages: 56 + 9)
    const cols = [
      { name: 'id', type: 'INT32' as const, primaryKey: true },
      { name: 'username', type: 'TEXT' as const },
    ];
    for (let i = 2; i < 65; i++) {
      cols.push({ name: `col_${i}`, type: 'INT32' as const });
    }

    const created = await db.createTable('wide_users', cols);
    await db.createIndex('wide_users', 'username', { unique: true });

    await db.insert('wide_users', { id: 1, username: 'alice', col_60: 42 });
    await db.insert('wide_users', { id: 2, username: 'bob', col_60: 99 });

    // Rename column on first catalog page ('username' -> 'handle')
    await db.renameColumn('wide_users', 'username', 'handle');
    // Rename column on second catalog page ('col_60' -> 'score_60')
    const updatedMeta = await db.renameColumn('wide_users', 'col_60', 'score_60');
    expect(updatedMeta.rootPageId).toBe(created.rootPageId); // Zero data page rewrite

    // Query using the renamed indexed column and second-page column
    const bob = await db.from('wide_users').where('handle', '=', 'bob').first();
    expect(bob?.id).toBe(2);
    expect(bob?.score_60).toBe(99);

    // Unique index on renamed column still enforces uniqueness
    await expect(
      db.insert('wide_users', { id: 3, handle: 'alice', score_60: 10 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Validation errors
    await expect(db.renameColumn('wide_users', 'missing_col', 'new_col')).rejects.toThrow(
      ColumnNotFoundError,
    );
    await expect(db.renameColumn('wide_users', 'handle', 'id')).rejects.toThrow(
      ColumnAlreadyExistsError,
    );
    await expect(
      db.renameColumn('wide_users', 'handle', 'c'.repeat(65)),
    ).rejects.toThrow(IdentifierTooLongError);

    await db.close();

    // Reopen and verify CRC32 checksums and column names on both catalog pages
    const db2 = await WebDB.open({ name: 'test_rename_col', vfs });
    const alice = await db2.from('wide_users').where('handle', '=', 'alice').first();
    expect(alice?.id).toBe(1);
    expect(alice?.score_60).toBe(42);
    await db2.close();
  });

  it('3. addColumn: migrates existing rows with defaultValue, preserves autoInc and secondary indexes', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_add_col', vfs });

    await db.createTable('employees', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT', notNull: true },
    ]);
    await db.createIndex('employees', 'name', { unique: true });

    await db.insertMany('employees', [{ name: 'Alice' }, { name: 'Bob' }]);

    // Add a NOT NULL column with a defaultValue and indexed: true
    await db.addColumn(
      'employees',
      { name: 'department', type: 'TEXT', notNull: true, indexed: true },
      { defaultValue: 'Engineering' },
    );

    // Add a nullable column without defaultValue
    await db.addColumn('employees', { name: 'bonus', type: 'FLOAT64' });

    const rows = await db.from('employees').orderBy('id', 'asc').toArray();
    expect(rows).toEqual([
      { id: 1, name: 'Alice', department: 'Engineering', bonus: null },
      { id: 2, name: 'Bob', department: 'Engineering', bonus: null },
    ]);

    // Auto-increment sequence continues from 3
    await db.insert('employees', {
      name: 'Charlie',
      department: 'Sales',
      bonus: 1500.5,
    });
    const charlie = await db.from('employees').where('department', '=', 'Sales').first();
    expect(charlie).toEqual({
      id: 3,
      name: 'Charlie',
      department: 'Sales',
      bonus: 1500.5,
    });

    // Existing unique index on 'name' is still enforced
    await expect(
      db.insert('employees', { name: 'Alice', department: 'HR', bonus: 0 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Adding a NOT NULL column without defaultValue to a non-empty table must fail and roll back
    await expect(
      db.addColumn('employees', { name: 'required_code', type: 'TEXT', notNull: true }),
    ).rejects.toThrow(NotNullConstraintError);

    // Verify table schema & rows are completely intact after failed addColumn
    const metaAfterFail = await db.getTable('employees');
    expect(metaAfterFail.columns.map((c) => c.name)).toEqual([
      'id',
      'name',
      'department',
      'bonus',
    ]);
    expect(await db.from('employees').toArray()).toHaveLength(3);

    await db.close();
  });

  it('4. dropColumn: removes column data, cascade-drops dependent indexes, and remaps surviving indexes', async () => {
    const db = await WebDB.open({ name: 'test_drop_col', storage: 'memory' });

    await db.createTable('products', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: ' legacy_code', type: 'TEXT' },
      { name: 'sku', type: 'TEXT', notNull: true },
      { name: 'category', type: 'TEXT' },
      { name: 'price', type: 'FLOAT64' },
    ]);

    // Fix typo column name first via renameColumn
    await db.renameColumn('products', ' legacy_code', 'legacy_code');

    await db.createIndex('products', 'legacy_code');
    await db.createIndex('products', 'sku', { unique: true });
    await db.createIndex('products', ['category', 'price'], {
      name: 'idx_cat_price',
    });

    await db.insertMany('products', [
      { legacy_code: 'OLD-1', sku: 'SKU-100', category: 'Books', price: 19.99 },
      { legacy_code: 'OLD-2', sku: 'SKU-200', category: 'Games', price: 59.99 },
    ]);

    // Drop 'legacy_code' (column index 1), which shifts 'sku' (2->1), 'category' (3->2), 'price' (4->3)
    const metaAfterDrop = await db.dropColumn('products', 'legacy_code');
    expect(metaAfterDrop.columns.map((c) => c.name)).toEqual([
      'id',
      'sku',
      'category',
      'price',
    ]);

    // Dependent index 'idx_products_legacy_code' was cascade-dropped, while 'idx_products_sku' and 'idx_cat_price' survived
    const survivingIndexes = await db.listIndexes('products');
    expect(survivingIndexes.map((i) => i.name).sort()).toEqual([
      'idx_cat_price',
      'idx_products_sku',
      'pk_products',
    ]);

    // Verify rows have 'legacy_code' removed and surviving columns intact
    const rows = await db.from('products').orderBy('id', 'asc').toArray();
    expect(rows).toEqual([
      { id: 1, sku: 'SKU-100', category: 'Books', price: 19.99 },
      { id: 2, sku: 'SKU-200', category: 'Games', price: 59.99 },
    ]);

    // Remapped unique index on 'sku' still enforces uniqueness
    await expect(
      db.insert('products', { sku: 'SKU-100', category: 'Books', price: 29.99 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Cannot drop PRIMARY KEY column
    await expect(db.dropColumn('products', 'id')).rejects.toThrow(CannotDropColumnError);

    // Cannot drop the last remaining column on a single-column table
    await db.createTable('single_col', [{ name: 'only_col', type: 'INT32' }]);
    await expect(db.dropColumn('single_col', 'only_col')).rejects.toThrow(
      CannotDropColumnError,
    );

    await db.close();
  });

  it('5. Unified db.alterTable() API and transactional ACID rollback of schema mutations', async () => {
    const db = await WebDB.open({ name: 'test_alter_tx', storage: 'memory' });

    await db.createTable('orders', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'item', type: 'TEXT' },
      { name: 'temp_flag', type: 'INT32' },
    ]);
    await db.insertMany('orders', [
      { item: 'Laptop', temp_flag: 1 },
      { item: 'Mouse', temp_flag: 0 },
    ]);

    // Execute all 4 operations via unified alterTable inside a transaction that then aborts
    await expect(
      db.transaction(async (tx) => {
        await tx.alterTable('orders', {
          type: 'renameColumn',
          from: 'item',
          to: 'product_name',
        });
        await tx.alterTable('orders', {
          type: 'addColumn',
          column: { name: 'quantity', type: 'INT32', notNull: true },
          defaultValue: 1,
        });
        await tx.alterTable('orders', {
          type: 'dropColumn',
          column: 'temp_flag',
        });
        await tx.alterTable('orders', {
          type: 'renameTable',
          newName: 'purchase_orders',
        });

        const insideTxRows = await tx
          .from('purchase_orders')
          .orderBy('id', 'asc')
          .toArray();
        expect(insideTxRows).toEqual([
          { id: 1, product_name: 'Laptop', quantity: 1 },
          { id: 2, product_name: 'Mouse', quantity: 1 },
        ]);

        throw new Error('Abort schema migration transaction');
      }),
    ).rejects.toThrow('Abort schema migration transaction');

    // Verify full rollback to original table name, original columns, and original rows
    await expect(db.getTable('purchase_orders')).rejects.toThrow(TableNotFoundError);
    const originalTable = await db.getTable('orders');
    expect(originalTable.columns.map((c) => c.name)).toEqual([
      'id',
      'item',
      'temp_flag',
    ]);
    const rowsAfterRollback = await db.from('orders').orderBy('id', 'asc').toArray();
    expect(rowsAfterRollback).toEqual([
      { id: 1, item: 'Laptop', temp_flag: 1 },
      { id: 2, item: 'Mouse', temp_flag: 0 },
    ]);

    // Now commit the migration via db.alterTable
    await db.transaction(async (tx) => {
      await tx.alterTable('orders', {
        type: 'renameColumn',
        from: 'item',
        to: 'product_name',
      });
      await tx.alterTable('orders', {
        type: 'addColumn',
        column: { name: 'quantity', type: 'INT32', notNull: true },
        defaultValue: 2,
      });
      await tx.alterTable('orders', {
        type: 'dropColumn',
        column: 'temp_flag',
      });
      await tx.alterTable('orders', {
        type: 'renameTable',
        newName: 'purchase_orders',
      });
    });

    const committedRows = await db
      .from('purchase_orders')
      .orderBy('id', 'asc')
      .toArray();
    expect(committedRows).toEqual([
      { id: 1, product_name: 'Laptop', quantity: 2 },
      { id: 2, product_name: 'Mouse', quantity: 2 },
    ]);

    await db.close();
  });

  it('6. Binary layout & catalog page boundary transitions (8 <-> 9 Null-Bitmap bytes and 56 <-> 57 catalog pages)', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_boundary_transitions', vfs });

    // Start with 8 columns (1-byte Null-Bitmap: ceil(8/8) = 1)
    const initialCols: ColumnDefinition[] = [
      { name: 'id', type: 'INT32', primaryKey: true },
    ];
    for (let i = 1; i < 8; i++) {
      initialCols.push({ name: `c${i}`, type: i % 2 === 0 ? 'TEXT' : 'INT32' });
    }
    await db.createTable('boundary_tbl', initialCols);

    // Insert rows with alternating NULL and non-NULL values across columns 1..7
    await db.insertMany('boundary_tbl', [
      { id: 1, c1: 10, c2: null, c3: 30, c4: 'four', c5: null, c6: 'six', c7: 70 },
      { id: 2, c1: null, c2: 'two', c3: null, c4: null, c5: 50, c6: null, c7: null },
    ]);

    // Transition 8 -> 9 columns (Null-Bitmap grows from 1 byte to 2 bytes)
    await db.addColumn(
      'boundary_tbl',
      { name: 'c8', type: 'TEXT' },
      { defaultValue: 'eighth' },
    );

    let rows = await db.from('boundary_tbl').orderBy('id', 'asc').toArray();
    expect(rows[0]).toMatchObject({
      id: 1,
      c1: 10,
      c2: null,
      c4: 'four',
      c5: null,
      c7: 70,
      c8: 'eighth',
    });
    expect(rows[1]).toMatchObject({
      id: 2,
      c1: null,
      c2: 'two',
      c5: 50,
      c7: null,
      c8: 'eighth',
    });

    // Expand up to 56 columns (fills 1st Column Catalog Page 0x0C to its exact 56-column capacity)
    for (let i = 9; i < 56; i++) {
      await db.addColumn('boundary_tbl', { name: `c${i}`, type: 'INT32' });
    }
    const meta56 = await db.getTable('boundary_tbl');
    expect(meta56.columnCount).toBe(56);

    // Transition 56 -> 57 columns (allocates and chains a 2nd Column Catalog Page 0x0C, Null-Bitmap = 8 bytes)
    const meta57 = await db.addColumn(
      'boundary_tbl',
      { name: 'c56', type: 'INT32' },
      { defaultValue: 5600 },
    );
    expect(meta57.columnCount).toBe(57);

    rows = await db.from('boundary_tbl').orderBy('id', 'asc').toArray();
    expect(rows[0].c56).toBe(5600);
    expect(rows[0].c4).toBe('four');
    expect(rows[0].c5).toBeNull();
    expect(rows[1].c2).toBe('two');
    expect(rows[1].c56).toBe(5600);

    // Shrink 57 -> 56 columns (frees the 2nd chained Column Catalog Page back to the freelist)
    const metaBackTo56 = await db.dropColumn('boundary_tbl', 'c56');
    expect(metaBackTo56.columnCount).toBe(56);

    // Reopen database to verify catalog page chain and CRC32 integrity on disk
    await db.close();
    const db2 = await WebDB.open({ name: 'test_boundary_transitions', vfs });
    const reopenedRows = await db2.from('boundary_tbl').orderBy('id', 'asc').toArray();
    expect(reopenedRows).toHaveLength(2);
    expect(reopenedRows[0].c8).toBe('eighth');
    expect(reopenedRows[0].c56).toBeUndefined();
    await db2.close();
  });

  it('7. Multi-page table rebuild (200 rows) under tight 16-slot buffer pool + WAL crash recovery', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({
      name: 'test_large_alter_crash',
      vfs,
      slotCount: 16,
    });

    await db.createTable('events', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'code', type: 'TEXT', notNull: true },
      { name: 'payload', type: 'TEXT' },
      { name: 'obsolete_blob', type: 'TEXT' },
    ]);
    await db.createIndex('events', 'code', { unique: true });

    const initialBatch = Array.from({ length: 200 }, (_, i) => ({
      code: `EVT-${String(i + 1).padStart(4, '0')}`,
      payload: `Event payload data #${i + 1} `.repeat(20), // ~500B per row -> ~25+ data pages
      obsolete_blob: `Obsolete field #${i + 1} `.repeat(10),
    }));
    await db.insertMany('events', initialBatch);
    await db.checkpoint();

    // Perform addColumn + dropColumn inside a transaction (commits to WAL without checkpointing)
    await db.transaction(async (tx) => {
      await tx.addColumn(
        'events',
        { name: 'severity', type: 'INT32', notNull: true, indexed: true },
        { defaultValue: 3 },
      );
      await tx.dropColumn('events', 'obsolete_blob');
    });

    // Also start a second transaction that starts rebuilding and spills uncommitted frames, then crashes mid-flight
    await expect(
      db.transaction(async (tx) => {
        await tx.addColumn(
          'events',
          { name: 'uncommitted_col', type: 'TEXT' },
          { defaultValue: 'should_not_survive '.repeat(15) },
        );
        throw new Error('Simulated crash during second schema migration');
      }),
    ).rejects.toThrow('Simulated crash during second schema migration');

    // Simulate hard process crash BEFORE checkpointing the first committed migration
    (db.coordinator as any).pauseIdleTimer();
    const walFramesBeforeCrash = await vfs.getWalFrameCount();
    expect(walFramesBeforeCrash).toBeGreaterThan(0);

    // Reopen from VFS -> recoverFromWal replays the committed schema rebuild and discards the uncommitted one
    const dbRecovered = await WebDB.open({
      name: 'test_large_alter_crash',
      vfs,
      slotCount: 16,
    });

    const recoveredMeta = await dbRecovered.getTable('events');
    expect(recoveredMeta.columns.map((c) => c.name)).toEqual([
      'id',
      'code',
      'payload',
      'severity',
    ]);

    const allRows = await dbRecovered.from('events').orderBy('id', 'asc').toArray();
    expect(allRows).toHaveLength(200);
    expect(allRows[0].code).toBe('EVT-0001');
    expect(allRows[0].severity).toBe(3);
    expect(allRows[0].obsolete_blob).toBeUndefined();
    expect(allRows[199].code).toBe('EVT-0200');

    // Verify secondary unique index on 'code' and new index on 'severity' work after WAL recovery
    const foundByCode = await dbRecovered
      .from('events')
      .where('code', '=', 'EVT-0150')
      .first();
    expect(foundByCode?.id).toBe(150);

    await expect(
      dbRecovered.insert('events', {
        code: 'EVT-0150',
        payload: 'dup',
        severity: 1,
      }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    await dbRecovered.close();
  });

  it('8. RowSizeLimitExceededError (> 2048B) mid-migration during addColumn rolls back atomically', async () => {
    const db = await WebDB.open({ name: 'test_alter_row_overflow', storage: 'memory' });

    await db.createTable('documents', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'body', type: 'TEXT' },
    ]);
    await db.createIndex('documents', 'id', { name: 'idx_doc_id' }).catch(() => {});

    // 19 normal rows and 1 near-max row (2000 bytes)
    const docs = Array.from({ length: 19 }, (_, i) => ({
      id: i + 1,
      body: `Short document body #${i + 1}`,
    }));
    docs.push({
      id: 20,
      body: 'X'.repeat(2000), // 2000 bytes <= 2048 limit
    });
    await db.insertMany('documents', docs);

    // Adding a column with a 100-byte default value pushes row #20 over 2048 bytes -> RowSizeLimitExceededError
    await expect(
      db.addColumn(
        'documents',
        { name: 'footer', type: 'TEXT' },
        { defaultValue: 'F'.repeat(100) },
      ),
    ).rejects.toThrow(RowSizeLimitExceededError);

    // Verify atomic rollback: schema still has only ['id', 'body'] and all 20 rows are intact
    const meta = await db.getTable('documents');
    expect(meta.columns.map((c) => c.name)).toEqual(['id', 'body']);

    const survivingDocs = await db.from('documents').orderBy('id', 'asc').toArray();
    expect(survivingDocs).toHaveLength(20);
    expect((survivingDocs[19].body as string).length).toBe(2000);

    await db.close();
  });

  it('9. Dropping a middle fixed-width column shifts colOffset and remaps composite indexes for JOIN and GROUP BY', async () => {
    const db = await WebDB.open({ name: 'test_middle_col_drop', storage: 'memory' });

    await db.createTable('departments', [
      { name: 'dept_id', type: 'INT32', primaryKey: true },
      { name: 'dept_name', type: 'TEXT' },
    ]);
    await db.insertMany('departments', [
      { dept_id: 10, dept_name: 'Platform' },
      { dept_id: 20, dept_name: 'AI' },
    ]);

    await db.createTable('staff', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'deprecated_token', type: 'INT64' }, // 8-byte fixed column at colIdx 1
      { name: 'dept_id', type: 'INT32' }, // colIdx 2 -> shifts to 1
      { name: 'level', type: 'INT32' }, // colIdx 3 -> shifts to 2
      { name: 'salary', type: 'FLOAT64' }, // 8-byte fixed column at colIdx 4 -> shifts to 3
      { name: 'name', type: 'TEXT' }, // var column at colIdx 5 -> shifts to 4
    ]);

    // Composite index referencing deprecated_token (should be cascade-dropped)
    await db.createIndex('staff', ['deprecated_token', 'dept_id'], {
      name: 'idx_deprecated_dept',
    });
    // Composite index on ['dept_id', 'level'] (should survive with columnIndices shifted from [2, 3] to [1, 2])
    await db.createIndex('staff', ['dept_id', 'level'], {
      name: 'idx_dept_level',
    });

    await db.insertMany('staff', [
      { deprecated_token: 1001n, dept_id: 10, level: 4, salary: 120000.5, name: 'Alice' },
      { deprecated_token: 1002n, dept_id: 10, level: 5, salary: 150000.0, name: 'Bob' },
      { deprecated_token: 1003n, dept_id: 20, level: 5, salary: 180000.25, name: 'Charlie' },
    ]);

    // Drop the middle INT64 column 'deprecated_token'
    const updatedStaff = await db.dropColumn('staff', 'deprecated_token');
    expect(updatedStaff.columns.map((c) => c.name)).toEqual([
      'id',
      'dept_id',
      'level',
      'salary',
      'name',
    ]);

    const indexes = await db.listIndexes('staff');
    expect(indexes.find((i) => i.name === 'idx_deprecated_dept')).toBeUndefined();
    const survivingComp = indexes.find((i) => i.name === 'idx_dept_level')!;
    expect(survivingComp).toBeDefined();
    expect(survivingComp.columnIndices.slice(0, 2)).toEqual([1, 2]);

    // Verify JOIN and ORDER BY on shifted columns
    const joined = await db
      .from('staff')
      .join('departments', 'staff.dept_id', '=', 'departments.dept_id')
      .orderBy('salary', 'desc')
      .toArray();
    expect(joined).toHaveLength(3);
    expect(joined[0]).toMatchObject({
      name: 'Charlie',
      dept_name: 'AI',
      salary: 180000.25,
    });

    // Verify GROUP BY + SUM aggregation on shifted fixed-width columns
    const grouped = await db
      .from('staff')
      .select(['dept_id', 'sum(salary) as total_salary'])
      .groupBy('dept_id')
      .orderBy('dept_id', 'asc')
      .toArray();
    expect(grouped).toEqual([
      { dept_id: 10, total_salary: 270000.5 },
      { dept_id: 20, total_salary: 180000.25 },
    ]);

    await db.close();
  });

  it('10. Nested savepoint (tx.transaction) partial schema rollback inside an outer transaction', async () => {
    const db = await WebDB.open({ name: 'test_nested_savepoint_alter', storage: 'memory' });

    await db.createTable('projects', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'title', type: 'TEXT', notNull: true },
    ]);
    await db.insert('projects', { title: 'Apollo' });

    await db.transaction(async (tx) => {
      // Outer transaction adds 'budget' column and inserts a row
      await tx.addColumn(
        'projects',
        { name: 'budget', type: 'INT32', notNull: true },
        { defaultValue: 10000 },
      );
      await tx.insert('projects', { title: 'Gemini', budget: 25000 });

      // Nested savepoint performs destructive schema mutations and then aborts
      await expect(
        tx.transaction(async (nestedTx) => {
          await nestedTx.renameColumn('projects', 'title', 'project_title');
          await nestedTx.dropColumn('projects', 'budget');
          await nestedTx.renameTable('projects', 'archived_projects');

          const nestedRows = await nestedTx.from('archived_projects').toArray();
          expect(nestedRows).toEqual([
            { id: 1, project_title: 'Apollo' },
            { id: 2, project_title: 'Gemini' },
          ]);

          throw new Error('Revert nested schema refactor');
        }),
      ).rejects.toThrow('Revert nested schema refactor');

      // Outer transaction state ('projects' with ['id', 'title', 'budget']) is restored and continues
      await tx.insert('projects', { title: 'Artemis', budget: 50000 });
    });

    const finalMeta = await db.getTable('projects');
    expect(finalMeta.columns.map((c) => c.name)).toEqual(['id', 'title', 'budget']);

    const finalRows = await db.from('projects').orderBy('id', 'asc').toArray();
    expect(finalRows).toEqual([
      { id: 1, title: 'Apollo', budget: 10000 },
      { id: 2, title: 'Gemini', budget: 25000 },
      { id: 3, title: 'Artemis', budget: 50000 },
    ]);

    await db.close();
  });
});
