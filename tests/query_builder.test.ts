import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { QueryBuilder } from '../src/host/api/query_builder.js';
import {
  col,
  fn,
  AggregateNotAllowedInWhereError,
  UnknownFunctionError,
} from '../src/index.js';

describe('QueryBuilder Unit & Integration Tests', () => {
  describe('AST Construction & Boolean Precedence', () => {
    const mockExecutor: any = {
      explainQuery: async () => ({}) as any,
      executeQuery: async () => [],
    };

    it('builds flat comparison and null filters', () => {
      const qb = new QueryBuilder(mockExecutor, 'users');
      qb.where('age', '>=', 18)
        .where('status', '=', 'active')
        .whereNull('deleted_at')
        .whereNotNull('email');

      const filters = qb.getFilters();
      expect(filters).toHaveLength(4);
      expect(filters[0]).toEqual({ type: 'cmp', colName: 'age', op: '>=', value: 18 });
      expect(filters[1]).toEqual({ type: 'cmp', colName: 'status', op: '=', value: 'active' });
      expect(filters[2]).toEqual({ type: 'null', colName: 'deleted_at', isNull: true });
      expect(filters[3]).toEqual({ type: 'null', colName: 'email', isNull: false });
    });

    it('builds OR conditions and chains them seamlessly', () => {
      const qb = new QueryBuilder(mockExecutor, 'users');
      qb.where('role', '=', 'admin')
        .orWhere('role', '=', 'editor')
        .orWhere('role', '=', 'moderator');

      const filters = qb.getFilters();
      expect(filters).toHaveLength(1);
      expect(filters[0].type).toBe('or');
      expect(filters[0].children).toHaveLength(3);
      expect(filters[0].children![0]).toEqual({ type: 'cmp', colName: 'role', op: '=', value: 'admin' });
      expect(filters[0].children![1]).toEqual({ type: 'cmp', colName: 'role', op: '=', value: 'editor' });
      expect(filters[0].children![2]).toEqual({ type: 'cmp', colName: 'role', op: '=', value: 'moderator' });
    });

    it('handles mixed AND followed by OR according to boolean precedence', () => {
      const qb = new QueryBuilder(mockExecutor, 'users');
      qb.where('age', '>=', 21)
        .where('status', '=', 'active')
        .orWhere('role', '=', 'superuser');

      const filters = qb.getFilters();
      expect(filters).toHaveLength(1);
      expect(filters[0].type).toBe('or');
      const children = filters[0].children!;
      expect(children).toHaveLength(2);
      expect(children[0]).toEqual({
        type: 'and',
        children: [
          { type: 'cmp', colName: 'age', op: '>=', value: 21 },
          { type: 'cmp', colName: 'status', op: '=', value: 'active' },
        ],
      });
      expect(children[1]).toEqual({ type: 'cmp', colName: 'role', op: '=', value: 'superuser' });
    });

    it('builds nested conditions via subquery callback: A AND (B OR C)', () => {
      const qb = new QueryBuilder(mockExecutor, 'users');
      qb.where('age', '>', 18)
        .where((sub) => {
          sub.where('dept', '=', 'Engineering')
             .orWhere('role', '=', 'admin');
        });

      const filters = qb.getFilters();
      expect(filters).toHaveLength(2);
      expect(filters[0]).toEqual({ type: 'cmp', colName: 'age', op: '>', value: 18 });
      expect(filters[1].type).toBe('or');
      expect(filters[1].children).toHaveLength(2);
      expect(filters[1].children![0]).toEqual({ type: 'cmp', colName: 'dept', op: '=', value: 'Engineering' });
      expect(filters[1].children![1]).toEqual({ type: 'cmp', colName: 'role', op: '=', value: 'admin' });
    });

    it('builds NOT expressions with whereNot and nested whereNot', () => {
      const qb = new QueryBuilder(mockExecutor, 'users');
      qb.whereNot('status', '=', 'banned')
        .whereNot((sub) => {
          sub.where('role', '=', 'guest')
             .orWhere('role', '=', 'restricted');
        });

      const filters = qb.getFilters();
      expect(filters).toHaveLength(2);
      expect(filters[0]).toEqual({
        type: 'not',
        child: { type: 'cmp', colName: 'status', op: '=', value: 'banned' },
      });
      expect(filters[1].type).toBe('not');
      expect(filters[1].child?.type).toBe('or');
      expect(filters[1].child?.children).toHaveLength(2);
    });

    it('supports orWhereNot, orWhereNull, and orWhereNotNull', () => {
      const qb = new QueryBuilder(mockExecutor, 'users');
      qb.where('active', '=', 1)
        .orWhereNot('status', '=', 'archived')
        .orWhereNull('suspended_at')
        .orWhereNotNull('verified_at');

      const root = qb.getRootFilter();
      expect(root?.type).toBe('or');
      expect(root?.children).toHaveLength(4);
      expect(root?.children![1].type).toBe('not');
      expect(root?.children![2]).toEqual({ type: 'null', colName: 'suspended_at', isNull: true });
      expect(root?.children![3]).toEqual({ type: 'null', colName: 'verified_at', isNull: false });
    });
  });

  describe('End-to-End Query Execution with Nested Conditions', () => {
    let db: WebDB;

    beforeEach(async () => {
      db = await WebDB.open({ name: 'test_qb_nested', storage: 'memory' });
      await db.createTable('members', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'name', type: 'TEXT', flags: { notNull: true } },
        { name: 'age', type: 'INT32', flags: { notNull: true } },
        { name: 'dept', type: 'TEXT' },
        { name: 'role', type: 'TEXT', flags: { notNull: true } },
        { name: 'salary', type: 'INT32' },
      ]);

      await db.insert('members', { id: 1, name: 'Alice', age: 30, dept: 'Engineering', role: 'developer', salary: 120000 });
      await db.insert('members', { id: 2, name: 'Bob', age: 45, dept: 'Sales', role: 'manager', salary: 110000 });
      await db.insert('members', { id: 3, name: 'Charlie', age: 22, dept: 'Engineering', role: 'intern', salary: 50000 });
      await db.insert('members', { id: 4, name: 'Diana', age: 28, dept: null, role: 'consultant', salary: 95000 });
      await db.insert('members', { id: 5, name: 'Eve', age: 38, dept: 'HR', role: 'director', salary: 130000 });
      await db.insert('members', { id: 6, name: 'Frank', age: 50, dept: 'Sales', role: 'lead', salary: 85000 });
    });

    it('executes A AND (B OR C): age >= 25 AND (dept = "Engineering" OR role = "manager")', async () => {
      const results = await db.from('members')
        .where('age', '>=', 25)
        .where((sub) => {
          sub.where('dept', '=', 'Engineering')
             .orWhere('role', '=', 'manager');
        })
        .toArray();

      // Alice (30, Eng, dev) matches: age >= 25 and dept = Eng
      // Bob (45, Sales, manager) matches: age >= 25 and role = manager
      // Charlie (22, Eng, intern) fails age >= 25
      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('executes NOT (A OR B): NOT (dept = "HR" OR dept = "Sales")', async () => {
      const results = await db.from('members')
        .whereNot((sub) => {
          sub.where('dept', '=', 'HR')
             .orWhere('dept', '=', 'Sales');
        })
        .toArray();

      // Should exclude Bob (Sales), Eve (HR), Frank (Sales)
      // Alice (Engineering), Charlie (Engineering) match
      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(['Alice', 'Charlie']);
    });

    it('executes (A AND B) OR (C AND D): (Eng AND salary >= 100k) OR (Sales AND salary < 100k)', async () => {
      const results = await db.from('members')
        .where((sub) => {
          sub.where('dept', '=', 'Engineering')
             .where('salary', '>=', 100000);
        })
        .orWhere((sub) => {
          sub.where('dept', '=', 'Sales')
             .where('salary', '<', 100000);
        })
        .toArray();

      // Alice (Eng, 120k) matches first branch
      // Frank (Sales, 85k) matches second branch
      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(['Alice', 'Frank']);
    });

    it('combines whereNull / whereNotNull with nested blocks', async () => {
      const results = await db.from('members')
        .whereNotNull('dept')
        .where((sub) => {
          sub.where('age', '>', 35)
             .orWhere('salary', '<', 60000);
        })
        .toArray();

      // Bob (45, Sales, non-null dept) matches age > 35
      // Charlie (22, Eng, non-null dept) matches salary < 60000
      // Eve (38, HR, non-null dept) matches age > 35
      // Frank (50, Sales, non-null dept) matches age > 35
      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(['Bob', 'Charlie', 'Eve', 'Frank']);
    });

    it('retrieves the first matching row with .first()', async () => {
      const row = await db.from('members')
        .where('dept', '=', 'Engineering')
        .where((sub) => {
          sub.where('role', '=', 'developer')
             .orWhere('role', '=', 'lead');
        })
        .first();

      expect(row).not.toBeNull();
      expect(row?.name).toBe('Alice');
    });

    it('disassembles nested condition plans with EXPLAIN', async () => {
      const explain = await db.from('members')
        .where('age', '>', 25)
        .where((sub) => {
          sub.where('dept', '=', 'Engineering')
             .orWhere('role', '=', 'manager');
        })
        .explain();

      expect(explain.instructions.length).toBeGreaterThan(0);
      expect(explain.assembly).toContain('OP_OPEN_CURSOR');
      expect(explain.assembly).toContain('OP_EMIT_ROW');
    });
  });

  describe('Projection & Select Support (Arrays, Aliases, Function Calls)', () => {
    let db: WebDB;

    beforeEach(async () => {
      db = await WebDB.open({ name: 'test_qb_select', storage: 'memory' });
      await db.createTable('users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'name', type: 'TEXT', flags: { notNull: true } },
        { name: 'age', type: 'INT32' },
        { name: 'dept', type: 'TEXT' },
        { name: 'role', type: 'TEXT' },
        { name: 'salary', type: 'FLOAT64' },
      ]);

      await db.insert('users', { id: 1, name: 'Alice Chen', age: 29, dept: 'Engineering', role: 'Lead Architect', salary: 145000 });
      await db.insert('users', { id: 2, name: 'Bob Miller', age: 22, dept: 'Engineering', role: 'Junior Dev', salary: 75000 });
      await db.insert('users', { id: 3, name: 'Charlie Kim', age: 35, dept: 'Sales', role: 'Manager', salary: 160000 });
    });

    it('selects array of column strings', async () => {
      const rows = await db.from('users')
        .select(['id', 'name'])
        .orderBy('id')
        .toArray();

      expect(rows).toEqual([
        { id: 1, name: 'Alice Chen' },
        { id: 2, name: 'Bob Miller' },
        { id: 3, name: 'Charlie Kim' },
      ]);
      // Ensure unselected columns are stripped
      expect(rows[0]).not.toHaveProperty('salary');
      expect(rows[0]).not.toHaveProperty('role');
    });

    it('selects columns via varargs syntax', async () => {
      const rows = await db.from('users')
        .select('id', 'name', 'salary')
        .where('id', '=', 1)
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: 1,
        name: 'Alice Chen',
        salary: 145000,
      });
    });

    it('selects column aliases via object spec { col, as }', async () => {
      const rows = await db.from('users')
        .select([
          'id',
          { col: 'name', as: 'full_name' },
          { col: 'salary', as: 'compensation' },
        ])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        { id: 1, full_name: 'Alice Chen', compensation: 145000 },
      ]);
    });

    it('selects column aliases via key-value dictionary object {[col]: alias}', async () => {
      const rows = await db.from('users')
        .select({
          id: 'userId',
          name: 'fullName',
          role: 'jobRole',
        })
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        { userId: 1, fullName: 'Alice Chen', jobRole: 'Lead Architect' },
      ]);
    });

    it('selects column aliases via { column: alias } mapping', async () => {
      const rows = await db.from('users')
        .select(['id', { name: 'user_name' }])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        { id: 1, user_name: 'Alice Chen' },
      ]);
    });

    it('selects column aliases via SQL "column AS alias" string syntax', async () => {
      const rows = await db.from('users')
        .select(['id', 'name as full_name', 'salary AS comp'])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        { id: 1, full_name: 'Alice Chen', comp: 145000 },
      ]);
    });

    it('executes scalar string functions: upper, lower, length, substr', async () => {
      const rows = await db.from('users')
        .select([
          'id',
          'upper(name) as upper_name',
          'lower(role) as lower_role',
          'length(name) as name_len',
          'substr(name, 1, 5) as short_name',
        ])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        {
          id: 1,
          upper_name: 'ALICE CHEN',
          lower_role: 'lead architect',
          name_len: 10,
          short_name: 'Alice',
        },
      ]);
    });

    it('executes function calls written as SQL function strings e.g. upper(name) as upper_name', async () => {
      const rows = await db.from('users')
        .select(['id', 'upper(name) as upper_name', 'lower(role) as lower_role'])
        .where('id', '=', 2)
        .toArray();

      expect(rows).toEqual([
        {
          id: 2,
          upper_name: 'BOB MILLER',
          lower_role: 'junior dev',
        },
      ]);
    });

    it('executes end-to-end queries combining string (trim, substr, upper) and math (abs, round, floor, ceil) functions', async () => {
      await db.insert('users', {
        id: 4,
        name: '   Dana Scully   ',
        age: 31,
        dept: '  Federal Bureau  ',
        role: 'Special Agent',
        salary: -84320.65,
      });

      const rows = await db.from('users')
        .select([
          'id',
          'trim(name) as clean_name',
          'trim(dept) as clean_dept',
          'upper(role) as upper_role',
          'substr(role, 1, 7) as short_role',
          'abs(salary) as abs_salary',
          'round(salary) as rounded_salary',
          'floor(salary) as floor_salary',
          'ceil(salary) as ceil_salary',
        ])
        .where('id', '=', 4)
        .toArray();

      expect(rows).toEqual([
        {
          id: 4,
          clean_name: 'Dana Scully',
          clean_dept: 'Federal Bureau',
          upper_role: 'SPECIAL AGENT',
          short_role: 'Special',
          abs_salary: 84320.65,
          rounded_salary: -84321,
          floor_salary: -84321,
          ceil_salary: -84320,
        },
      ]);
    });

    it('supports aggregate functions inside select with groupBy', async () => {
      const rows = await db.from('users')
        .select(['dept', 'count(*) as headcount', 'sum(salary) as total_payroll'])
        .groupBy('dept')
        .orderBy('dept')
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        dept: 'Engineering',
        headcount: 2,
        total_payroll: 220000,
      });
      expect(rows[1]).toEqual({
        dept: 'Sales',
        headcount: 1,
        total_payroll: 160000,
      });
    });

    it('supports SelectColumnSpec aliasing with aggregate expressions and groupBy', async () => {
      const rows = await db.from('users')
        .select([
          { col: 'dept', as: 'department' },
          'count(*) as count',
          'sum(salary) as total',
        ])
        .groupBy('dept')
        .orderBy('dept')
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        department: 'Engineering',
        count: 2,
        total: 220000,
      });
    });

    it('supports chaining multiple select() calls', async () => {
      const rows = await db.from('users')
        .select('id')
        .select(['name'])
        .select({ salary: 'full_salary' })
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        { id: 1, name: 'Alice Chen', full_salary: 145000 },
      ]);
    });

    it('projects single row correctly with .first()', async () => {
      const row = await db.from('users')
        .select(['id', { col: 'name', as: 'lead_name' }])
        .where('id', '=', 1)
        .first();

      expect(row).toEqual({
        id: 1,
        lead_name: 'Alice Chen',
      });
    });

    it('includes select projection metadata in explain() plan', async () => {
      const explain = await db.from('users')
        .select(['id', { col: 'name', as: 'full_name' }])
        .explain();

      expect(explain.plan.select).toBeDefined();
      expect(explain.plan.select).toHaveLength(2);
      expect(explain.plan.select![0].alias).toBe('id');
      expect(explain.plan.select![1].alias).toBe('full_name');
    });

    it('executes compound arithmetic expressions in SELECT', async () => {
      const rows = await db.from('users')
        .select([
          'id',
          'salary * 1.1 as adjusted_salary',
          'floor(salary / 1000) as salary_k',
          'salary + 500 * 2 as total_comp',
        ])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        {
          id: 1,
          adjusted_salary: 159500,
          salary_k: 145,
          total_comp: 146000,
        },
      ]);
    });

    it('supports Drizzle-style standalone expression helpers (col, fn)', async () => {
      const rows = await db.from('users')
        .select([
          'id',
          col('salary').mul(1.1).as('adjusted_salary'),
          fn.floor(col('salary').div(1000)).as('salary_k'),
          fn.upper(col('name')).as('upper_name'),
        ])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        {
          id: 1,
          adjusted_salary: 159500,
          salary_k: 145,
          upper_name: 'ALICE CHEN',
        },
      ]);
    });

    it('enforces function clause validation: disallows aggregates in WHERE', () => {
      expect(() => {
        db.from('users').where('count(*)', '>', 0);
      }).toThrow(AggregateNotAllowedInWhereError);

      expect(() => {
        db.from('users').where(fn.count(), '>', 0);
      }).toThrow(AggregateNotAllowedInWhereError);

      expect(() => {
        db.from('users').where('sum(salary)', '>', 1000);
      }).toThrow(AggregateNotAllowedInWhereError);

      expect(() => {
        db.from('users').where('avg(salary) + 10', '>', 5000);
      }).toThrow(AggregateNotAllowedInWhereError);

      expect(() => {
        db.from('users').orWhere('min(age)', '<', 18);
      }).toThrow(AggregateNotAllowedInWhereError);

      expect(() => {
        db.from('users').whereNot('max(salary)', '>', 50000);
      }).toThrow(AggregateNotAllowedInWhereError);
    });

    it('supports implicit UDF registration and execution across host boundary', async () => {
      // Register custom UDFs
      db.registerFunction('slugify', (val: string) => {
        return String(val).toLowerCase().replace(/\s+/g, '-');
      });

      db.registerFunction('calc_bonus', (salary: number, multiplier: number) => {
        return Number(salary) * Number(multiplier);
      });

      // Execute query using implicit UDF calling via SQL string syntax
      const rows = await db.from('users')
        .select([
          'id',
          'slugify(name) as name_slug',
          'calc_bonus(salary, 0.15) as bonus',
        ])
        .where('id', '=', 1)
        .toArray();

      expect(rows).toEqual([
        {
          id: 1,
          name_slug: 'alice-chen',
          bonus: 21750,
        },
      ]);

      // Execute query using standalone helper fn() for UDF
      const helperRows = await db.from('users')
        .select([
          'id',
          fn('slugify', col('name')).as('slug'),
        ])
        .where('id', '=', 2)
        .toArray();

      expect(helperRows).toEqual([
        {
          id: 2,
          slug: 'bob-miller',
        },
      ]);
    });

    it('throws UnknownFunctionError when calling unregistered function', async () => {
      await expect(
        db.from('users')
          .select(['id', 'mystery_func(name) as result'])
          .where('id', '=', 1)
          .toArray(),
      ).rejects.toThrow(UnknownFunctionError);
    });

    it('filters rows using expression UDF in WHERE clause e.g. .where("regex_match(name, \'^[A-Z][a-z]+\')")', async () => {
      // Register regex_match UDF
      db.registerFunction('regex_match', (val: string, pattern: string) => {
        if (val === null || val === undefined) return false;
        return new RegExp(pattern).test(val);
      });

      // Match users whose name starts with capital letter followed by lowercase (Alice, Bob, Charlie)
      // but not Dana Scully whose name starts with whitespace '   Dana Scully   '
      const rows = await db.from('users')
        .select(['id', 'name'])
        .where("regex_match(name, '^[A-Z][a-z]+')")
        .toArray();

      expect(rows).toEqual([
        { id: 1, name: 'Alice Chen' },
        { id: 2, name: 'Bob Miller' },
        { id: 3, name: 'Charlie Kim' },
      ]);

      // Narrow filter further to match only 'Alice'
      const aliceOnly = await db.from('users')
        .select(['id', 'name'])
        .where("regex_match(name, '^Alice')")
        .toArray();

      expect(aliceOnly).toEqual([
        { id: 1, name: 'Alice Chen' },
      ]);
    });
  });
});

