import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { QueryBuilder } from '../src/host/api/query_builder.js';
import {
  col,
  fn,
  exp,
  sql,
  AggregateNotAllowedInWhereError,
  UnknownFunctionError,
  TooManyCursorsError,
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

    it('supports smart expression filtering in where(expr, op, value) e.g. .where("days_ago(hire_date)", "<=", 30)', async () => {
      // Create a table with date strings
      await db.createTable('orders', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'customer_id', type: 'INT32' },
        { name: 'order_date', type: 'TEXT' },
        { name: 'total_amount', type: 'FLOAT64' },
      ]);

      await db.insert('orders', { id: 1, customer_id: 101, order_date: '2026-09-20', total_amount: 150.0 });
      await db.insert('orders', { id: 2, customer_id: 102, order_date: '2026-09-01', total_amount: 320.0 });
      await db.insert('orders', { id: 3, customer_id: 103, order_date: '2026-07-15', total_amount: 80.0 });

      // Register a mock days_ago function: calculates days between 2026-09-28 and order_date
      db.registerFunction('days_ago', (dateStr: string) => {
        if (!dateStr) return null;
        const now = new Date('2026-09-28T00:00:00Z').getTime();
        const past = new Date(`${dateStr}T00:00:00Z`).getTime();
        return Math.floor((now - past) / (1000 * 60 * 60 * 24));
      });

      // 1. 3-argument smart expression: .where("days_ago(order_date)", "<=", 30)
      const recentOrders = await db.from('orders')
        .select(['id', 'customer_id', 'total_amount'])
        .where('days_ago(order_date)', '<=', 30)
        .orderBy('total_amount', 'desc')
        .toArray();

      expect(recentOrders).toEqual([
        { id: 2, customer_id: 102, total_amount: 320.0 },
        { id: 1, customer_id: 101, total_amount: 150.0 },
      ]);

      // 2. 1-argument comparison expression: .where("days_ago(order_date) <= 30")
      const recentBySingleExpr = await db.from('orders')
        .select(['id', 'customer_id'])
        .where('days_ago(order_date) <= 30')
        .orderBy('id', 'asc')
        .toArray();

      expect(recentBySingleExpr).toEqual([
        { id: 1, customer_id: 101 },
        { id: 2, customer_id: 102 },
      ]);

      // 3. Using exp() / sql() helper: .where(exp("days_ago(order_date)"), "<=", 30)
      const recentByExpHelper = await db.from('orders')
        .select(['id', 'customer_id'])
        .where(exp('days_ago(order_date)'), '<=', 30)
        .where(sql('total_amount'), '>', 100)
        .orderBy('id', 'asc')
        .toArray();

      expect(recentByExpHelper).toEqual([
        { id: 1, customer_id: 101 },
        { id: 2, customer_id: 102 },
      ]);

      // 4. Using whereRaw: .whereRaw("days_ago(order_date) <= 30")
      const recentByWhereRaw = await db.from('orders')
        .select(['id'])
        .whereRaw('days_ago(order_date) <= 30')
        .toArray();

      expect(recentByWhereRaw).toEqual([
        { id: 1 },
        { id: 2 },
      ]);

      // 5. Using ExpressionBuilder comparison methods: col.lte(30)
      const recentByBuilder = await db.from('orders')
        .select(['id'])
        .where(fn('days_ago', col('order_date')).lte(30))
        .toArray();

      expect(recentByBuilder).toEqual([
        { id: 1 },
        { id: 2 },
      ]);

      // 6. Order by expression string directly
      const byDaysDesc = await db.from('orders')
        .select(['id'])
        .orderBy('days_ago(order_date)', 'desc')
        .toArray();

      expect(byDaysDesc).toEqual([
        { id: 3 }, // ~75 days ago
        { id: 2 }, // 27 days ago
        { id: 1 }, // 8 days ago
      ]);

      // 7. Order by select alias
      const byAliasAsc = await db.from('orders')
        .select(['id', 'days_ago(order_date) as days_since'])
        .orderBy('days_since', 'asc')
        .toArray();

      expect(byAliasAsc).toEqual([
        { id: 1, days_since: 8 },
        { id: 2, days_since: 27 },
        { id: 3, days_since: 75 },
      ]);

      // 8. Order by ExpressionBuilder
      const byBuilderDesc = await db.from('orders')
        .select(['id'])
        .orderBy(fn('days_ago', col('order_date')), 'desc')
        .toArray();

      expect(byBuilderDesc).toEqual([
        { id: 3 },
        { id: 2 },
        { id: 1 },
      ]);
    });
  });

  describe('Smart GroupBy and Having Support', () => {
    let db: WebDB;

    beforeEach(async () => {
      db = await WebDB.open({ name: 'test_qb_groupby_having', storage: 'memory' });

      await db.createTable('employees', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
        { name: 'dept', type: 'TEXT' },
        { name: 'salary', type: 'FLOAT64' },
        { name: 'join_date', type: 'TEXT' },
      ]);

      await db.insert('employees', { id: 1, name: 'Alice', dept: 'Engineering', salary: 120000, join_date: '2023-01-15' });
      await db.insert('employees', { id: 2, name: 'Bob', dept: 'Engineering', salary: 140000, join_date: '2023-03-20' });
      await db.insert('employees', { id: 3, name: 'Charlie', dept: 'Sales', salary: 90000, join_date: '2023-01-10' });
      await db.insert('employees', { id: 4, name: 'Diana', dept: 'Sales', salary: 110000, join_date: '2024-05-12' });
      await db.insert('employees', { id: 5, name: 'Eve', dept: 'Marketing', salary: 80000, join_date: '2024-06-01' });
    });

    it('filters aggregated groups with having using aggregate function', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'count(*) as headcount', 'sum(salary) as total_salary'])
        .groupBy('dept')
        .having('count(*)', '>', 1)
        .orderBy('dept', 'asc')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering', headcount: 2, total_salary: 260000 },
        { dept: 'Sales', headcount: 2, total_salary: 200000 },
      ]);
    });

    it('filters aggregated groups with having using select alias', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'sum(salary) as total_salary'])
        .groupBy('dept')
        .having('total_salary', '>=', 250000)
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering', total_salary: 260000 },
      ]);
    });

    it('filters aggregated groups using single expression string in having()', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'count(*) as cnt'])
        .groupBy('dept')
        .having('count(*) = 1')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Marketing', cnt: 1 },
      ]);
    });

    it('supports havingRaw and orHaving', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'sum(salary) as total_salary', 'count(*) as cnt'])
        .groupBy('dept')
        .havingRaw('total_salary > 250000')
        .orHaving('cnt', '=', 1)
        .orderBy('dept', 'asc')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering', total_salary: 260000, cnt: 2 },
        { dept: 'Marketing', total_salary: 80000, cnt: 1 },
      ]);
    });

    it('supports ExpressionBuilder in having()', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'count(*) as cnt'])
        .groupBy('dept')
        .having(exp('count(*)').gt(1))
        .orderBy('dept', 'asc')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering', cnt: 2 },
        { dept: 'Sales', cnt: 2 },
      ]);
    });

    it('auto-registers aggregate functions from having when not in select', async () => {
      const rows = await db.from('employees')
        .select(['dept'])
        .groupBy('dept')
        .having('count(*)', '>', 1)
        .orderBy('dept', 'asc')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering' },
        { dept: 'Sales' },
      ]);
    });

    it('supports groupBy with expressions (e.g. substr)', async () => {
      const rows = await db.from('employees')
        .select(['substr(join_date, 1, 4) as join_year', 'count(*) as cnt'])
        .groupBy('substr(join_date, 1, 4)')
        .having('cnt', '>=', 2)
        .orderBy('join_year', 'asc')
        .toArray();

      expect(rows).toEqual([
        { join_year: '2023', cnt: 3 },
        { join_year: '2024', cnt: 2 },
      ]);
    });

    it('supports groupBy with select alias', async () => {
      const rows = await db.from('employees')
        .select(['substr(join_date, 1, 4) as year', 'count(*) as cnt'])
        .groupBy('year')
        .having('cnt', '>', 2)
        .toArray();

      expect(rows).toEqual([
        { year: '2023', cnt: 3 },
      ]);
    });

    it('supports groupBy with ExpressionBuilder', async () => {
      const rows = await db.from('employees')
        .select(['substr(join_date, 1, 4) as year', 'count(*) as cnt'])
        .groupBy(fn('substr', col('join_date'), 1, 4))
        .having('cnt', '>', 2)
        .toArray();

      expect(rows).toEqual([
        { year: '2023', cnt: 3 },
      ]);
    });

    it('supports groupBy without aggregates (distinct groups)', async () => {
      const rows = await db.from('employees')
        .select(['dept'])
        .groupBy('dept')
        .orderBy('dept', 'asc')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering' },
        { dept: 'Marketing' },
        { dept: 'Sales' },
      ]);
    });

    it('supports having filtering on grouping column', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'count(*) as cnt'])
        .groupBy('dept')
        .having('dept', '=', 'Marketing')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Marketing', cnt: 1 },
      ]);
    });

    it('supports having with callback / subquery grouping', async () => {
      const rows = await db.from('employees')
        .select(['dept', 'count(*) as cnt'])
        .groupBy('dept')
        .having((q) => {
          q.having('count(*)', '=', 1).orHaving('dept', '=', 'Engineering');
        })
        .orderBy('dept', 'asc')
        .toArray();

      expect(rows).toEqual([
        { dept: 'Engineering', cnt: 2 },
        { dept: 'Marketing', cnt: 1 },
      ]);
    });

    it('throws error when having references a column not in groupBy or aggregates', async () => {
      await expect(
        db.from('employees')
          .select(['dept', 'count(*) as cnt'])
          .groupBy('dept')
          .having('name', '=', 'Alice')
          .toArray()
      ).rejects.toThrow(/Column "name" in HAVING clause must be an aggregate or grouping column/);
    });
  });

  describe('Table Join Support (INNER & LEFT JOIN, Multi-Table, Filters, Sorters)', () => {
    let db: WebDB;

    beforeEach(async () => {
      db = await WebDB.open({ name: 'test_qb_joins', storage: 'memory' });

      // Table 1: customers
      await db.createTable('customers', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'name', type: 'TEXT', flags: { notNull: true } },
        { name: 'city', type: 'TEXT' },
      ]);

      // Table 2: orders
      await db.createTable('orders', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'customer_id', type: 'INT32' },
        { name: 'total_amount', type: 'FLOAT64' },
        { name: 'status', type: 'TEXT' },
      ]);

      // Table 3: order_items
      await db.createTable('order_items', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
        { name: 'order_id', type: 'INT32' },
        { name: 'item_name', type: 'TEXT' },
        { name: 'qty', type: 'INT32' },
      ]);

      // Seed customers:
      // 1: Alice (Beirut), 2: Bob (Paris), 3: Charlie (Tokyo, no orders)
      await db.insert('customers', { id: 1, name: 'Alice', city: 'Beirut' });
      await db.insert('customers', { id: 2, name: 'Bob', city: 'Paris' });
      await db.insert('customers', { id: 3, name: 'Charlie', city: 'Tokyo' });

      // Seed orders:
      // 101: Alice, 150.0, completed
      // 102: Alice, 50.0, pending
      // 103: Bob, 200.0, completed
      await db.insert('orders', { id: 101, customer_id: 1, total_amount: 150.0, status: 'completed' });
      await db.insert('orders', { id: 102, customer_id: 1, total_amount: 50.0, status: 'pending' });
      await db.insert('orders', { id: 103, customer_id: 2, total_amount: 200.0, status: 'completed' });

      // Seed order_items:
      // 1: order 101 -> Laptop
      // 2: order 101 -> Mouse
      // 3: order 103 -> Keyboard
      await db.insert('order_items', { id: 1, order_id: 101, item_name: 'Laptop', qty: 1 });
      await db.insert('order_items', { id: 2, order_id: 101, item_name: 'Mouse', qty: 2 });
      await db.insert('order_items', { id: 3, order_id: 103, item_name: 'Keyboard', qty: 1 });
    });

    it('executes 2-table INNER JOIN with select aliases', async () => {
      const rows = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .select([
          'customers.name as customer_name',
          'orders.id as order_id',
          'orders.total_amount as amount',
        ])
        .orderBy('order_id', 'asc')
        .toArray();

      expect(rows).toEqual([
        { customer_name: 'Alice', order_id: 101, amount: 150.0 },
        { customer_name: 'Alice', order_id: 102, amount: 50.0 },
        { customer_name: 'Bob', order_id: 103, amount: 200.0 },
      ]);
    });

    it('supports innerJoin alias and explicit operator', async () => {
      const rows = await db.from('customers')
        .innerJoin('orders', 'customers.id', '=', 'orders.customer_id')
        .select(['customers.name', 'orders.id as order_id'])
        .orderBy('order_id', 'asc')
        .toArray();

      expect(rows).toEqual([
        { name: 'Alice', order_id: 101 },
        { name: 'Alice', order_id: 102 },
        { name: 'Bob', order_id: 103 },
      ]);
    });

    it('executes INNER JOIN with WHERE filters on both tables', async () => {
      const rows = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .where('customers.city', '=', 'Beirut')
        .where('orders.status', '=', 'completed')
        .select(['customers.name', 'orders.total_amount as amount'])
        .toArray();

      expect(rows).toEqual([
        { name: 'Alice', amount: 150.0 },
      ]);
    });

    it('executes 2-table LEFT JOIN including rows without matches', async () => {
      const rows = await db.from('customers')
        .leftJoin('orders', 'customers.id', 'orders.customer_id')
        .select([
          'customers.name as customer_name',
          'orders.id as order_id',
          'orders.total_amount as amount',
        ])
        .orderBy('customers.id', 'asc')
        .toArray();

      // Alice has 101, 102. Bob has 103. Charlie has no orders (NULLs).
      expect(rows).toEqual([
        { customer_name: 'Alice', order_id: 101, amount: 150.0 },
        { customer_name: 'Alice', order_id: 102, amount: 50.0 },
        { customer_name: 'Bob', order_id: 103, amount: 200.0 },
        { customer_name: 'Charlie', order_id: null, amount: null },
      ]);
    });

    it('executes 3-table multi-join (customers -> orders -> order_items)', async () => {
      const rows = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .join('order_items', 'orders.id', 'order_items.order_id')
        .select([
          'customers.name as customer_name',
          'orders.id as order_id',
          'order_items.item_name as item',
          'order_items.qty as quantity',
        ])
        .orderBy('order_items.id', 'asc')
        .toArray();

      expect(rows).toEqual([
        { customer_name: 'Alice', order_id: 101, item: 'Laptop', quantity: 1 },
        { customer_name: 'Alice', order_id: 101, item: 'Mouse', quantity: 2 },
        { customer_name: 'Bob', order_id: 103, item: 'Keyboard', quantity: 1 },
      ]);
    });

    it('executes multi-table join with mixed INNER and LEFT JOIN', async () => {
      const rows = await db.from('customers')
        .leftJoin('orders', 'customers.id', 'orders.customer_id')
        .leftJoin('order_items', 'orders.id', 'order_items.order_id')
        .select([
          'customers.name as customer_name',
          'orders.id as order_id',
          'order_items.item_name as item',
        ])
        .orderBy('customers.id', 'asc')
        .toArray();

      expect(rows).toEqual([
        { customer_name: 'Alice', order_id: 101, item: 'Laptop' },
        { customer_name: 'Alice', order_id: 101, item: 'Mouse' },
        { customer_name: 'Alice', order_id: 102, item: null },
        { customer_name: 'Bob', order_id: 103, item: 'Keyboard' },
        { customer_name: 'Charlie', order_id: null, item: null },
      ]);
    });

    it('supports joins with ORDER BY, LIMIT, and OFFSET', async () => {
      const rows = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .select(['customers.name', 'orders.total_amount as amount'])
        .orderBy('orders.total_amount', 'desc')
        .limit(2)
        .offset(1)
        .toArray();

      // Sorted desc: 200 (Bob), 150 (Alice), 50 (Alice)
      // offset 1, limit 2 => 150 (Alice), 50 (Alice)
      expect(rows).toEqual([
        { name: 'Alice', amount: 150.0 },
        { name: 'Alice', amount: 50.0 },
      ]);
    });

    it('retrieves single joined row with .first()', async () => {
      const row = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .select(['customers.name', 'orders.id as order_id'])
        .where('orders.id', '=', 103)
        .first();

      expect(row).toEqual({
        name: 'Bob',
        order_id: 103,
      });
    });

    it('supports join without explicit select() with default column disambiguation', async () => {
      const rows = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .where('orders.id', '=', 103)
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveProperty('customers.id', 2);
      expect(rows[0]).toHaveProperty('name', 'Bob');
      expect(rows[0]).toHaveProperty('city', 'Paris');
      expect(rows[0]).toHaveProperty('orders.id', 103);
      expect(rows[0]).toHaveProperty('customer_id', 2);
      expect(rows[0]).toHaveProperty('total_amount', 200.0);
      expect(rows[0]).toHaveProperty('status', 'completed');
    });

    it('disassembles join query with explain()', async () => {
      const explain = await db.from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .select(['customers.name', 'orders.total_amount as amount'])
        .explain();

      expect(explain.plan.joins).toHaveLength(1);
      expect(explain.plan.joins![0]).toEqual({
        type: 'inner',
        table: 'orders',
        leftCol: 'customers.id',
        op: '=',
        rightCol: 'orders.customer_id',
      });
      // Should open cursor 0 and cursor 1
      const openOps = explain.instructions.filter((i) => i.opcode === 'OP_OPEN_CURSOR');
      expect(openOps).toHaveLength(2);
      expect(openOps[0].p1).toBe('c[0]');
      expect(openOps[1].p1).toBe('c[1]');
    });

    it('throws TooManyCursorsError when exceeding 16 cursors per frame', async () => {
      let qb = db.from('customers');
      // Chain 16 joins -> 1 primary + 16 joined = 17 tables > 16 cursors limit
      for (let i = 0; i < 16; i++) {
        qb = qb.join('orders', 'customers.id', 'orders.customer_id');
      }

      await expect(qb.toArray()).rejects.toThrow(TooManyCursorsError);
      await expect(qb.toArray()).rejects.toThrow(/17 exceeds maximum limit of 16 cursors/);
    });
  });

  describe('String Pattern Operations (LIKE, STARTS_WITH, ENDS_WITH, CONTAINS)', () => {
    let db: WebDB;

    beforeEach(async () => {
      db = await WebDB.open({ name: 'patterns_test', storage: 'memory' });
      await db.createTable('items', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
        { name: 'category', type: 'TEXT' },
      ]);

      await db.insert('items', { id: 1, name: 'Apple iPhone 15', category: 'Phone' });
      await db.insert('items', { id: 2, name: 'Google Pixel 8', category: 'Phone' });
      await db.insert('items', { id: 3, name: 'Apple iPad Pro', category: 'Tablet' });
      await db.insert('items', { id: 4, name: 'Samsung Galaxy Tab', category: 'Tablet' });
    });

    it('supports lowercase string operators in where (like, starts_with, ends_with, contains)', async () => {
      // starts_with
      const starts = await db.from('items').where('name', 'starts_with', 'Apple').toArray();
      expect(starts).toHaveLength(2);
      expect(starts.map((i) => i.id)).toEqual([1, 3]);

      // ends_with
      const ends = await db.from('items').where('name', 'ends_with', '15').toArray();
      expect(ends).toHaveLength(1);
      expect(ends[0].name).toBe('Apple iPhone 15');

      // like
      const like = await db.from('items').where('name', 'like', '%Pixel%').toArray();
      expect(like).toHaveLength(1);
      expect(like[0].name).toBe('Google Pixel 8');

      // contains
      const contains = await db.from('items').where('name', 'contains', 'Galaxy').toArray();
      expect(contains).toHaveLength(1);
      expect(contains[0].name).toBe('Samsung Galaxy Tab');
    });

    it('emits dedicated string opcodes in bytecode instead of OP_EQ', async () => {
      const explainStarts = await db.from('items').where('name', 'starts_with', 'Apple').explain();
      const opStarts = explainStarts.instructions.map((i) => i.opcode);
      expect(opStarts).toContain('OP_STR_STARTS_WITH');
      expect(opStarts).not.toContain('OP_EQ');

      const explainEnds = await db.from('items').where('name', 'ends_with', '15').explain();
      const opEnds = explainEnds.instructions.map((i) => i.opcode);
      expect(opEnds).toContain('OP_STR_ENDS_WITH');
      expect(opEnds).not.toContain('OP_EQ');

      const explainLike = await db.from('items').where('name', 'like', '%Pixel%').explain();
      const opLike = explainLike.instructions.map((i) => i.opcode);
      expect(opLike).toContain('OP_STR_LIKE');
      expect(opLike).not.toContain('OP_EQ');

      const explainContains = await db.from('items').where('name', 'contains', 'Galaxy').explain();
      const opContains = explainContains.instructions.map((i) => i.opcode);
      expect(opContains).toContain('OP_STR_CONTAINS');
      expect(opContains).not.toContain('OP_EQ');
    });

    it('supports dedicated QueryBuilder helper methods (whereLike, whereStartsWith, etc.)', async () => {
      const p1 = await db.from('items').whereStartsWith('name', 'Apple').toArray();
      expect(p1).toHaveLength(2);

      const p2 = await db.from('items').whereEndsWith('name', 'Pro').toArray();
      expect(p2).toHaveLength(1);
      expect(p2[0].name).toBe('Apple iPad Pro');

      const p3 = await db.from('items').whereLike('name', '%Galaxy%').toArray();
      expect(p3).toHaveLength(1);

      const p4 = await db.from('items').whereContains('name', 'iPhone').toArray();
      expect(p4).toHaveLength(1);
    });

    it('supports string pattern functions in expressions (starts_with, ends_with, like, contains)', async () => {
      // In where expression
      const rows = await db.from('items').where("starts_with(name, 'Apple')").toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual([1, 3]);

      // In select expression
      const projected = await db.from('items')
        .select(['name', "starts_with(name, 'Apple') as is_apple"])
        .toArray();
      expect(projected[0]).toEqual({ name: 'Apple iPhone 15', is_apple: 1 });
      expect(projected[1]).toEqual({ name: 'Google Pixel 8', is_apple: 0 });
    });
  });
});


