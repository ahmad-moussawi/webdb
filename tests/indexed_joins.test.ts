import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.ts';
import {
  UniqueConstraintViolationError,
  NotNullConstraintError,
} from '../src/types/index.ts';

describe('Phase 4: Indexed Joins & Verification', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'phase4_test', storage: 'memory' });
  });

  describe('1. Indexed Nested-Loop Join Acceleration', () => {
    it('accelerates inner join when inner table has a primary key index', async () => {
      await db.createTable('users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('orders', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'user_id', type: 'INT32' },
        { name: 'amount', type: 'FLOAT64' },
      ]);

      await db.insert('users', { id: 1, name: 'Alice' });
      await db.insert('users', { id: 2, name: 'Bob' });
      await db.insert('users', { id: 3, name: 'Charlie' });

      await db.insert('orders', { id: 101, user_id: 2, amount: 99.5 });
      await db.insert('orders', { id: 102, user_id: 1, amount: 25.0 });
      await db.insert('orders', { id: 103, user_id: 2, amount: 150.0 });
      await db.insert('orders', { id: 104, user_id: 99, amount: 500.0 }); // no user

      // Explain join
      const explain = await db
        .from('orders')
        .join('users', 'orders.user_id', '=', 'users.id')
        .select(['orders.id as order_id', 'users.name as user_name', 'orders.amount'])
        .explain();

      expect(explain.plan.joins).toHaveLength(1);
      expect(explain.plan.joins![0].scanType).toBe('IndexScan');
      expect(explain.plan.joins![0].indexName).toBe('pk_users');

      const opcodes = explain.instructions.map((i) => i.opcode);
      expect(opcodes).toContain('OP_OPEN_INDEX');
      expect(opcodes).toContain('OP_INDEX_SEEK_EQ');

      // Execute query
      const results = await db
        .from('orders')
        .join('users', 'orders.user_id', '=', 'users.id')
        .select(['orders.id as order_id', 'users.name as user_name', 'orders.amount'])
        .toArray();

      expect(results).toHaveLength(3);
      expect(results).toEqual([
        { order_id: 101, user_name: 'Bob', amount: 99.5 },
        { order_id: 102, user_name: 'Alice', amount: 25.0 },
        { order_id: 103, user_name: 'Bob', amount: 150.0 },
      ]);
    });

    it('accelerates inner join with non-unique secondary index on foreign key', async () => {
      await db.createTable('departments', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'dept_name', type: 'TEXT' },
      ]);

      await db.createTable('employees', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'dept_id', type: 'INT32' },
        { name: 'emp_name', type: 'TEXT' },
      ]);

      // Non-unique index on foreign key employees.dept_id
      await db.createIndex('employees', 'dept_id', { name: 'idx_emp_dept' });

      await db.insert('departments', { id: 10, dept_name: 'Engineering' });
      await db.insert('departments', { id: 20, dept_name: 'Marketing' });

      await db.insert('employees', { id: 1, dept_id: 10, emp_name: 'Dev1' });
      await db.insert('employees', { id: 2, dept_id: 10, emp_name: 'Dev2' });
      await db.insert('employees', { id: 3, dept_id: 20, emp_name: 'Mkt1' });
      await db.insert('employees', { id: 4, dept_id: 10, emp_name: 'Dev3' });

      // Explain join
      const explain = await db
        .from('departments')
        .join('employees', 'departments.id', '=', 'employees.dept_id')
        .select(['departments.dept_name', 'employees.emp_name'])
        .explain();

      expect(explain.plan.joins).toHaveLength(1);
      expect(explain.plan.joins![0].scanType).toBe('IndexScan');
      expect(explain.plan.joins![0].indexName).toBe('idx_emp_dept');

      const opcodes = explain.instructions.map((i) => i.opcode);
      expect(opcodes).toContain('OP_OPEN_INDEX');
      expect(opcodes).toContain('OP_INDEX_SEEK_GE');
      expect(opcodes).toContain('OP_INDEX_NEXT');

      // Execute join
      const results = await db
        .from('departments')
        .join('employees', 'departments.id', '=', 'employees.dept_id')
        .select(['departments.dept_name', 'employees.emp_name'])
        .toArray();

      expect(results).toHaveLength(4);
      expect(results).toEqual([
        { dept_name: 'Engineering', emp_name: 'Dev1' },
        { dept_name: 'Engineering', emp_name: 'Dev2' },
        { dept_name: 'Engineering', emp_name: 'Dev3' },
        { dept_name: 'Marketing', emp_name: 'Mkt1' },
      ]);
    });

    it('accelerates LEFT JOIN using index with null row emission on unmatched outer rows', async () => {
      await db.createTable('authors', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('profiles', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'author_id', type: 'INT32' },
        { name: 'bio', type: 'TEXT' },
      ]);

      await db.createIndex('profiles', 'author_id', { name: 'idx_profile_author', unique: true });

      await db.insert('authors', { id: 1, name: 'Alice' });
      await db.insert('authors', { id: 2, name: 'Bob' });
      await db.insert('authors', { id: 3, name: 'Charlie' });

      await db.insert('profiles', { id: 10, author_id: 1, bio: 'Alice biography' });
      await db.insert('profiles', { id: 20, author_id: 3, bio: 'Charlie biography' });
      // Author 2 (Bob) has no profile

      const explain = await db
        .from('authors')
        .leftJoin('profiles', 'authors.id', '=', 'profiles.author_id')
        .select(['authors.name', 'profiles.bio'])
        .explain();

      expect(explain.plan.joins![0].scanType).toBe('IndexScan');
      expect(explain.plan.joins![0].indexName).toBe('idx_profile_author');

      const rows = await db
        .from('authors')
        .leftJoin('profiles', 'authors.id', '=', 'profiles.author_id')
        .select(['authors.name', 'profiles.bio'])
        .toArray();

      expect(rows).toHaveLength(3);
      expect(rows).toEqual([
        { name: 'Alice', bio: 'Alice biography' },
        { name: 'Bob', bio: null },
        { name: 'Charlie', bio: 'Charlie biography' },
      ]);
    });
  });

  describe('2. Constraint Violations & Robustness', () => {
    it('enforces NOT NULL constraint on primary key column without autoInc', async () => {
      await db.createTable('items', [
        { name: 'sku', type: 'TEXT', flags: { primaryKey: true } },
        { name: 'desc', type: 'TEXT' },
      ]);

      await expect(db.insert('items', { desc: 'missing sku' } as any)).rejects.toThrow(
        NotNullConstraintError,
      );
    });

    it('rejects duplicate inserts on secondary UNIQUE index', async () => {
      await db.createTable('members', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, autoInc: true } },
        { name: 'phone', type: 'TEXT' },
      ]);

      await db.createIndex('members', 'phone', { name: 'idx_members_phone', unique: true });

      await db.insert('members', { phone: '123-456' });
      await expect(db.insert('members', { phone: '123-456' })).rejects.toThrow(
        UniqueConstraintViolationError,
      );
    });

    it('rejects duplicate inserts on composite UNIQUE index', async () => {
      await db.createTable('tenant_users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, autoInc: true } },
        { name: 'tenant_id', type: 'INT32' },
        { name: 'email', type: 'TEXT' },
      ]);

      await db.createIndex('tenant_users', ['tenant_id', 'email'], {
        name: 'idx_tenant_email',
        unique: true,
      });

      await db.insert('tenant_users', { tenant_id: 1, email: 'user@corp.com' });
      await db.insert('tenant_users', { tenant_id: 2, email: 'user@corp.com' }); // different tenant ok

      // Duplicate within tenant 1
      await expect(
        db.insert('tenant_users', { tenant_id: 1, email: 'user@corp.com' }),
      ).rejects.toThrow(UniqueConstraintViolationError);
    });
  });

  describe('3. Composite Index Lookups', () => {
    it('accelerates multi-column composite index point lookup', async () => {
      await db.createTable('audit_logs', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, autoInc: true } },
        { name: 'org_id', type: 'INT32' },
        { name: 'action', type: 'TEXT' },
        { name: 'details', type: 'TEXT' },
      ]);

      await db.createIndex('audit_logs', ['org_id', 'action'], {
        name: 'idx_audit_org_action',
      });

      await db.insert('audit_logs', { org_id: 10, action: 'LOGIN', details: 'user 1' });
      await db.insert('audit_logs', { org_id: 10, action: 'DELETE', details: 'doc 5' });
      await db.insert('audit_logs', { org_id: 20, action: 'LOGIN', details: 'user 2' });

      const explain = await db
        .from('audit_logs')
        .where('org_id', '=', 10)
        .where('action', '=', 'DELETE')
        .explain();

      expect(explain.plan.scanType).toBe('IndexScan');
      expect(explain.plan.indexName).toBe('idx_audit_org_action');

      const results = await db
        .from('audit_logs')
        .where('org_id', '=', 10)
        .where('action', '=', 'DELETE')
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ org_id: 10, action: 'DELETE', details: 'doc 5' });
    });
  });

  describe('4. Page Splits & Chaining', () => {
    it('correctly handles index leaf page split/chaining and searches across pages', async () => {
      await db.createTable('big_index_table', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'key_str', type: 'TEXT' },
      ]);

      await db.createIndex('big_index_table', 'key_str', { name: 'idx_big_keystr' });

      // Insert 120 records with distinct text keys to fill and chain index leaf pages
      const N = 120;
      for (let i = 1; i <= N; i++) {
        const padded = String(i).padStart(4, '0');
        await db.insert('big_index_table', {
          id: i,
          key_str: `key_payload_prefix_${padded}`,
        });
      }

      // Query point seek at beginning, middle, and end
      const first = await db
        .from('big_index_table')
        .where('key_str', '=', 'key_payload_prefix_0001')
        .toArray();
      expect(first).toHaveLength(1);
      expect(first[0].id).toBe(1);

      const mid = await db
        .from('big_index_table')
        .where('key_str', '=', 'key_payload_prefix_0060')
        .toArray();
      expect(mid).toHaveLength(1);
      expect(mid[0].id).toBe(60);

      const last = await db
        .from('big_index_table')
        .where('key_str', '=', 'key_payload_prefix_0120')
        .toArray();
      expect(last).toHaveLength(1);
      expect(last[0].id).toBe(120);

      // Verify all 120 rows are present
      const allRows = await db.from('big_index_table').toArray();
      expect(allRows).toHaveLength(N);
    });
  });

  describe('5. Transaction Rollbacks', () => {
    it('rolls back table rows and index entries when transaction fails', async () => {
      await db.createTable('accounts', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'owner', type: 'TEXT' },
        { name: 'balance', type: 'FLOAT64' },
      ]);

      await db.createIndex('accounts', 'owner', { name: 'idx_accounts_owner', unique: true });

      await db.insert('accounts', { id: 1, owner: 'Alice', balance: 100.0 });

      // Transaction that attempts to insert valid row then fails
      await expect(
        db.transaction(async (tx) => {
          await tx.insert('accounts', { id: 2, owner: 'Bob', balance: 200.0 });
          // Force an intentional failure
          throw new Error('Simulation of catastrophic transaction failure');
        }),
      ).rejects.toThrow('Simulation of catastrophic transaction failure');

      // Verify that Bob was rolled back and only Alice remains
      const rows = await db.from('accounts').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, owner: 'Alice' });

      // Point lookup on Bob using index returns empty
      const bobSearch = await db.from('accounts').where('owner', '=', 'Bob').toArray();
      expect(bobSearch).toEqual([]);

      // Inserting Bob now should succeed without unique constraint violation
      await db.insert('accounts', { id: 2, owner: 'Bob', balance: 250.0 });
      const bobAfter = await db.from('accounts').where('owner', '=', 'Bob').toArray();
      expect(bobAfter).toHaveLength(1);
      expect(bobAfter[0]).toMatchObject({ id: 2, owner: 'Bob', balance: 250.0 });
    });

    it('commits successfully when transaction completes without errors', async () => {
      await db.createTable('wallets', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'user', type: 'TEXT' },
      ]);

      await db.transaction(async (tx) => {
        await tx.insert('wallets', { id: 1, user: 'User1' });
        await tx.insert('wallets', { id: 2, user: 'User2' });
      });

      const wallets = await db.from('wallets').toArray();
      expect(wallets).toHaveLength(2);
    });
  });
});
