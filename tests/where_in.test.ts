import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { MAX_IN_LIST_SIZE } from '../src/constants.js';

describe('QueryBuilder & VDBE: whereIn / whereNotIn (Specification & Implementation)', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'test_where_in_db', storage: 'memory' });
    await db.createTable('users', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
      { name: 'dept', type: 'TEXT' },
      { name: 'age', type: 'INT32' },
      { name: 'bio', type: 'TEXT' },
    ]);

    await db.insert('users', { id: 1, name: 'Alice', dept: 'Engineering', age: 30, bio: 'Coder' });
    await db.insert('users', { id: 2, name: 'Bob', dept: 'Marketing', age: 25, bio: 'Marketer' });
    await db.insert('users', { id: 3, name: 'Charlie', dept: 'Engineering', age: 35, bio: null });
    await db.insert('users', { id: 4, name: 'Diana', dept: 'Design', age: 28, bio: 'Designer' });
    await db.insert('users', { id: 5, name: 'Evan', dept: 'Sales', age: 40, bio: null });
  });

  describe('Basic Usage', () => {
    it('filters rows with whereIn on numeric column', async () => {
      const rows = await db.from('users').whereIn('id', [2, 4]).toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual([2, 4]);
    });

    it('filters rows with whereIn on string column', async () => {
      const rows = await db
        .from('users')
        .whereIn('dept', ['Marketing', 'Design'])
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Diana']);
    });

    it('filters rows with whereNotIn', async () => {
      const rows = await db
        .from('users')
        .whereNotIn('dept', ['Engineering', 'Sales'])
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Diana']);
    });

    it('supports standard comparison operator overload: where(col, "in", values)', async () => {
      const rows = await db.from('users').where('id', 'in', [1, 3, 5]).toArray();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.id).sort()).toEqual([1, 3, 5]);
    });

    it('supports standard comparison operator overload: where(col, "not in", values)', async () => {
      const rows = await db.from('users').where('id', 'not in', [1, 2, 3]).toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual([4, 5]);
    });

    it('supports orWhereIn', async () => {
      const rows = await db
        .from('users')
        .where('dept', '=', 'Marketing')
        .orWhereIn('id', [1, 4])
        .toArray();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob', 'Diana']);
    });

    it('supports orWhereNotIn', async () => {
      const rows = await db
        .from('users')
        .where('dept', '=', 'Marketing')
        .orWhereNotIn('dept', ['Engineering', 'Design', 'Marketing'])
        .toArray();
      // 'Marketing' matches Bob; NOT IN ['Engineering', 'Design', 'Marketing'] matches Evan ('Sales')
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Evan']);
    });

    it('combines whereIn with other filter predicates and ordering', async () => {
      const rows = await db
        .from('users')
        .whereIn('dept', ['Engineering', 'Marketing', 'Design'])
        .where('age', '>=', 28)
        .orderBy('age', 'desc')
        .toArray();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.name)).toEqual(['Charlie', 'Alice', 'Diana']);
    });
  });

  describe('Edge Cases', () => {
    it('empty array whereIn(col, []) returns empty result immediately (0 rows)', async () => {
      const rows = await db.from('users').whereIn('id', []).toArray();
      expect(rows).toEqual([]);
    });

    it('empty array whereIn(col, []) with secondary where returns empty result', async () => {
      const rows = await db
        .from('users')
        .whereIn('dept', [])
        .where('age', '>', 0)
        .toArray();
      expect(rows).toEqual([]);
    });

    it('empty array whereNotIn(col, []) acts as pass-through (returns all rows)', async () => {
      const rows = await db.from('users').whereNotIn('id', []).toArray();
      expect(rows).toHaveLength(5);
    });

    it('empty array in nested orWhereIn handles boolean logic correctly', async () => {
      const rows = await db
        .from('users')
        .where('id', '=', 2)
        .orWhereIn('id', [])
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(2);
    });

    it('handles duplicate values in whereIn array without duplicate row emissions', async () => {
      const rows = await db.from('users').whereIn('id', [2, 2, 4, 2, 4]).toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual([2, 4]);
    });

    it('SQL 3VL: rows with NULL column value do not match whereIn', async () => {
      // bio is null for Charlie (id: 3) and Evan (id: 5)
      const rows = await db
        .from('users')
        .whereIn('bio', ['Coder', 'Marketer', 'Designer'])
        .toArray();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.id).sort()).toEqual([1, 2, 4]);
    });

    it('SQL 3VL: rows with NULL column value do not match whereNotIn', async () => {
      // In SQL 3VL: NULL NOT IN ('Coder') is UNKNOWN (excluded)
      const rows = await db.from('users').whereNotIn('bio', ['Coder']).toArray();
      expect(rows.map((r) => r.id).sort()).toEqual([2, 4]);
    });

    it('null inside whereIn array: whereIn(col, [1, null]) matches non-null item', async () => {
      const rows = await db.from('users').whereIn('id', [1, null]).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
    });

    it('handles large array (e.g. 1000 items) without register exhaustion', async () => {
      const largeList = Array.from({ length: 1000 }, (_, i) => i + 1);
      const rows = await db.from('users').whereIn('id', largeList).toArray();
      expect(rows).toHaveLength(5);
    });

    it('throws RangeError when array exceeds MAX_IN_LIST_SIZE', async () => {
      const oversizedList = new Array(MAX_IN_LIST_SIZE + 1).fill(1);
      expect(() => {
        db.from('users').whereIn('id', oversizedList);
      }).toThrow(RangeError);
      expect(() => {
        db.from('users').whereNotIn('id', oversizedList);
      }).toThrow(/WebDB: whereNotIn list exceeds maximum limit/);
    });

    it('throws TypeError when whereIn is called with non-array', () => {
      expect(() => {
        (db.from('users') as any).whereIn('id', 'not-an-array');
      }).toThrow(TypeError);
    });
  });

  describe('Index Usage & Acceleration Proof', () => {
    it('uses IndexScan on PRIMARY KEY with whereIn', async () => {
      const qb = db.from('users').whereIn('id', [1, 3, 5]);
      const explain = await qb.explain();

      expect(explain.plan.scanType).toBe('IndexScan');
      expect(explain.plan.indexName).toBe('pk_users');

      const rows = await qb.toArray();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.id).sort()).toEqual([1, 3, 5]);
    });

    it('uses IndexScan on UNIQUE secondary index with whereIn', async () => {
      await db.createTable('accounts', [
        { name: 'id', type: 'INT32', primaryKey: true },
        { name: 'account_no', type: 'TEXT' },
        { name: 'balance', type: 'INT32' },
      ]);
      await db.createIndex('accounts', 'account_no', { unique: true, name: 'idx_acc_no_uniq' });

      await db.insert('accounts', { id: 1, account_no: 'ACC-100', balance: 500 });
      await db.insert('accounts', { id: 2, account_no: 'ACC-200', balance: 1500 });
      await db.insert('accounts', { id: 3, account_no: 'ACC-300', balance: 2500 });

      const qb = db.from('accounts').whereIn('account_no', ['ACC-100', 'ACC-300']);
      const explain = await qb.explain();

      expect(explain.plan.scanType).toBe('IndexScan');
      expect(explain.plan.indexName).toBe('idx_acc_no_uniq');

      const rows = await qb.toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.account_no).sort()).toEqual(['ACC-100', 'ACC-300']);
    });

    it('falls back to TableScan when filtering on non-indexed column', async () => {
      const qb = db.from('users').whereIn('dept', ['Engineering', 'Design']);
      const explain = await qb.explain();

      expect(explain.plan.scanType).toBe('TableScan');
      expect(explain.plan.indexName).toBeUndefined();

      const rows = await qb.toArray();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Charlie', 'Diana']);
    });

    it('IndexScan multi-seek handles non-existent keys gracefully', async () => {
      const qb = db.from('users').whereIn('id', [2, 999, 4, 888]);
      const explain = await qb.explain();

      expect(explain.plan.scanType).toBe('IndexScan');
      expect(explain.plan.indexName).toBe('pk_users');

      const rows = await qb.toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual([2, 4]);
    });

    it('IndexScan multi-seek with secondary filter and limit', async () => {
      const qb = db
        .from('users')
        .whereIn('id', [1, 2, 3, 4, 5])
        .where('age', '>=', 30)
        .limit(1);

      const explain = await qb.explain();
      expect(explain.plan.scanType).toBe('IndexScan');

      const rows = await qb.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].age).toBeGreaterThanOrEqual(30);
    });
  });
});
