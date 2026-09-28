import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/host/api/webdb';
import { exportDatabaseToSql } from '../playground/src/utils/sqlExporter';

describe('SQLite SQL Exporter', () => {
  it('exports tables and records to a valid SQLite .sql dump', async () => {
    const db = await WebDB.open({ name: 'test_export_db', storage: 'memory' });

    // 1. Create tables
    await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'age', type: 'INT32' },
      { name: 'rating', type: 'FLOAT64' },
    ]);

    await db.createTable('tags', [
      { name: 'tag_id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'tag_name', type: 'TEXT', flags: { notNull: true } },
    ]);

    // 2. Insert records
    await db.insert('users', { id: 1, name: "Alice O'Connor", age: 28, rating: 4.95 });
    await db.insert('users', { id: 2, name: 'Bob "The Builder"', age: 34, rating: 4.8 });
    await db.insert('tags', { tag_id: 10, tag_name: 'VIP' });

    // 3. Export to SQLite SQL
    const { sql, tableCount, rowCount } = await exportDatabaseToSql(db, 'test_export_db');

    expect(tableCount).toBe(2);
    expect(rowCount).toBe(3);

    // Verify SQL contents
    expect(sql).toContain('PRAGMA foreign_keys = OFF;');
    expect(sql).toContain('BEGIN TRANSACTION;');
    expect(sql).toContain('DROP TABLE IF EXISTS "users";');
    expect(sql).toContain('CREATE TABLE "users" (');
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(sql).toContain('"name" TEXT NOT NULL');
    expect(sql).toContain('DROP TABLE IF EXISTS "tags";');
    expect(sql).toContain('CREATE TABLE "tags" (');
    expect(sql).toContain('INSERT INTO "users" ("id", "name", "age", "rating") VALUES');
    // Check escaping of single quote in O'Connor
    expect(sql).toContain("'Alice O''Connor'");
    // Check double quote inside string
    expect(sql).toContain('\'Bob "The Builder"\'');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('PRAGMA foreign_keys = ON;');
  });
});
