import { describe, it, expect, beforeEach } from 'vitest';
import {
  WebDB,
  CostBasedPlanner,
  HeuristicPlanner,
  NoOpPlanner,
  CustomOrderPlanner,
  QueryPlanner,
} from '../src/index.ts';

describe('Join Cost Planner & Optimization', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'join_planner_test', storage: 'memory' });
  });

  describe('1. Join Reordering to avoid Cartesian scans', () => {
    it('inverts join order when inner table has no index but outer has a primary key index', async () => {
      // Table 1: large indexed table
      await db.createTable('users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      // Table 2: small unindexed lookup table (no index on user_id)
      await db.createTable('badges', [
        { name: 'id', type: 'INT32' },
        { name: 'user_id', type: 'INT32' },
        { name: 'title', type: 'TEXT' },
      ]);

      // Populate users (many rows)
      for (let i = 1; i <= 20; i++) {
        await db.insert('users', { id: i, name: `User_${i}` });
      }

      // Populate badges (few rows)
      await db.insert('badges', { id: 1, user_id: 5, title: 'Gold' });
      await db.insert('badges', { id: 2, user_id: 12, title: 'Silver' });

      // User wrote: from('users').join('badges', 'users.id', '=', 'badges.user_id')
      // If executed naively: scans 20 users, and for each user scans all badges (20 * 2 = 40 checks).
      // If inverted: scans 2 badges, and seeks into users via primary key (2 index seeks!).
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .explain();

      // Planner should recognize users has the PK index and choose badges as driving table
      expect(explain.plan.joinOrder).toEqual(['badges', 'users']);
      expect(explain.plan.table).toBe('badges');
      expect(explain.plan.estimatedCost).toBeDefined();
      expect(explain.plan.estimatedRows).toBeDefined();

      // Execute query and verify correctness of results
      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: 'User_5', title: 'Gold' },
          { name: 'User_12', title: 'Silver' },
        ]),
      );
    });
  });

  describe('2. Filter Pushdown in Join Loops', () => {
    it('filters driving table rows early so non-matching rows never seek inner tables', async () => {
      await db.createTable('customers', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'city', type: 'TEXT' },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('orders', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'customer_id', type: 'INT32' },
        { name: 'total', type: 'FLOAT64' },
      ]);

      await db.createIndex('orders', 'customer_id', { name: 'idx_orders_customer' });

      await db.insert('customers', { id: 1, city: 'Beirut', name: 'Alice' });
      await db.insert('customers', { id: 2, city: 'Tripoli', name: 'Bob' });
      await db.insert('customers', { id: 3, city: 'Beirut', name: 'Charlie' });
      await db.insert('customers', { id: 4, city: 'Sidon', name: 'Diana' });

      await db.insert('orders', { id: 101, customer_id: 1, total: 100 });
      await db.insert('orders', { id: 102, customer_id: 2, total: 200 });
      await db.insert('orders', { id: 103, customer_id: 3, total: 300 });
      await db.insert('orders', { id: 104, customer_id: 4, total: 400 });

      // Query with single-table filter on customers (city = 'Beirut')
      const rows = await db
        .from('customers')
        .join('orders', 'customers.id', '=', 'orders.customer_id')
        .where('customers.city', '=', 'Beirut')
        .select(['customers.name', 'orders.total'])
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: 'Alice', total: 100 },
          { name: 'Charlie', total: 300 },
        ]),
      );
    });

    it('filters rows when single-table filters exist on both joined tables', async () => {
      await db.createTable('departments', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'dept_name', type: 'TEXT' },
        { name: 'active', type: 'INT32' },
      ]);

      await db.createTable('employees', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'dept_id', type: 'INT32' },
        { name: 'emp_name', type: 'TEXT' },
        { name: 'salary', type: 'FLOAT64' },
      ]);

      await db.createIndex('employees', 'dept_id', { name: 'idx_emp_dept' });

      await db.insert('departments', { id: 10, dept_name: 'Engineering', active: 1 });
      await db.insert('departments', { id: 20, dept_name: 'HR', active: 0 }); // inactive

      await db.insert('employees', { id: 1, dept_id: 10, emp_name: 'Dev1', salary: 90000 });
      await db.insert('employees', { id: 2, dept_id: 10, emp_name: 'Dev2', salary: 40000 }); // low salary
      await db.insert('employees', { id: 3, dept_id: 20, emp_name: 'HR1', salary: 80000 }); // inactive dept

      const rows = await db
        .from('departments')
        .join('employees', 'departments.id', '=', 'employees.dept_id')
        .where('departments.active', '=', 1)
        .where('employees.salary', '>', 50000)
        .select(['departments.dept_name', 'employees.emp_name', 'employees.salary'])
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        dept_name: 'Engineering',
        emp_name: 'Dev1',
        salary: 90000,
      });
    });
  });

  describe('3. Output Column Projection Preservation', () => {
    it('preserves user SELECT * column order even when tables are reordered by the planner', async () => {
      await db.createTable('authors', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('posts', [
        { name: 'id', type: 'INT32' },
        { name: 'author_id', type: 'INT32' },
        { name: 'title', type: 'TEXT' },
      ]);

      for (let i = 1; i <= 10; i++) {
        await db.insert('authors', { id: i, name: `Author_${i}` });
      }
      await db.insert('posts', { id: 101, author_id: 3, title: 'WebDB Joins' });

      // SELECT without explicit projection
      const rows = await db
        .from('authors')
        .join('posts', 'authors.id', '=', 'posts.author_id')
        .toArray();

      expect(rows).toHaveLength(1);
      const row = rows[0];

      // Verify all columns from both tables are present
      expect(row).toHaveProperty('name', 'Author_3');
      expect(row).toHaveProperty('title', 'WebDB Joins');
    });
  });

  describe('4. Semantic Dependency Preservation for LEFT JOIN', () => {
    it('never promotes the right side of a LEFT JOIN above its outer table', async () => {
      await db.createTable('projects', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('tasks', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'project_id', type: 'INT32' },
        { name: 'title', type: 'TEXT' },
      ]);

      await db.createIndex('tasks', 'project_id', { name: 'idx_tasks_project' });

      await db.insert('projects', { id: 1, name: 'Apollo' });
      await db.insert('projects', { id: 2, name: 'Gemini' }); // no tasks

      await db.insert('tasks', { id: 10, project_id: 1, title: 'Launch' });

      const explain = await db
        .from('projects')
        .leftJoin('tasks', 'projects.id', '=', 'tasks.project_id')
        .select(['projects.name', 'tasks.title'])
        .explain();

      // In LEFT JOIN, projects must remain the outer table
      expect(explain.plan.joinOrder).toEqual(['projects', 'tasks']);
      expect(explain.plan.table).toBe('projects');

      const rows = await db
        .from('projects')
        .leftJoin('tasks', 'projects.id', '=', 'tasks.project_id')
        .select(['projects.name', 'tasks.title'])
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows).toEqual([
        { name: 'Apollo', title: 'Launch' },
        { name: 'Gemini', title: null },
      ]);
    });
  });

  describe('5. Multi-Table (3-Table) Joins', () => {
    it('optimizes 3-table join order and executes correctly', async () => {
      await db.createTable('customers', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('orders', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'customer_id', type: 'INT32' },
        { name: 'date', type: 'TEXT' },
      ]);

      await db.createTable('order_items', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'order_id', type: 'INT32' },
        { name: 'product', type: 'TEXT' },
      ]);

      await db.createIndex('orders', 'customer_id', { name: 'idx_orders_customer' });
      await db.createIndex('order_items', 'order_id', { name: 'idx_items_order' });

      await db.insert('customers', { id: 1, name: 'Alice' });
      await db.insert('customers', { id: 2, name: 'Bob' });

      await db.insert('orders', { id: 101, customer_id: 1, date: '2026-01-01' });
      await db.insert('orders', { id: 102, customer_id: 2, date: '2026-01-02' });

      await db.insert('order_items', { id: 1001, order_id: 101, product: 'Laptop' });
      await db.insert('order_items', { id: 1002, order_id: 101, product: 'Mouse' });
      await db.insert('order_items', { id: 1003, order_id: 102, product: 'Keyboard' });

      const explain = await db
        .from('customers')
        .join('orders', 'customers.id', '=', 'orders.customer_id')
        .join('order_items', 'orders.id', '=', 'order_items.order_id')
        .select(['customers.name', 'orders.date', 'order_items.product'])
        .explain();

      expect(explain.plan.joinOrder).toBeDefined();
      expect(explain.plan.joinOrder).toHaveLength(3);
      expect(explain.plan.estimatedCost).toBeGreaterThan(0);

      const rows = await db
        .from('customers')
        .join('orders', 'customers.id', '=', 'orders.customer_id')
        .join('order_items', 'orders.id', '=', 'order_items.order_id')
        .select(['customers.name', 'orders.date', 'order_items.product'])
        .orderBy('order_items.product', 'asc')
        .toArray();

      expect(rows).toHaveLength(3);
      expect(rows).toEqual([
        { name: 'Bob', date: '2026-01-02', product: 'Keyboard' },
        { name: 'Alice', date: '2026-01-01', product: 'Laptop' },
        { name: 'Alice', date: '2026-01-01', product: 'Mouse' },
      ]);
    });
  });

  describe('6. Pluggable Planner Architecture', () => {
    beforeEach(async () => {
      await db.createTable('users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
      ]);

      await db.createTable('badges', [
        { name: 'id', type: 'INT32' },
        { name: 'user_id', type: 'INT32' },
        { name: 'title', type: 'TEXT' },
      ]);

      for (let i = 1; i <= 20; i++) {
        await db.insert('users', { id: i, name: `User_${i}` });
      }
      await db.insert('badges', { id: 1, user_id: 5, title: 'Gold' });
      await db.insert('badges', { id: 2, user_id: 12, title: 'Silver' });
    });

    it('allows passing planner class to WebDB.open()', async () => {
      const heuristicDb = await WebDB.open({
        name: 'heuristic_db',
        storage: 'memory',
        planner: HeuristicPlanner,
      });

      expect(heuristicDb.getPlanner()).toBe(HeuristicPlanner);
    });

    it('NoOpPlanner preserves original table order without reordering', async () => {
      // By default (CostBasedPlanner), join is reordered to ['badges', 'users']
      const defaultExplain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .explain();
      expect(defaultExplain.plan.joinOrder).toEqual(['badges', 'users']);

      // With NoOpPlanner, join order strictly preserves syntactic order ['users', 'badges']
      const noOpExplain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(NoOpPlanner)
        .explain();

      expect(noOpExplain.plan.joinOrder).toEqual(['users', 'badges']);
      expect(noOpExplain.plan.table).toBe('users');

      // Results must still be completely correct!
      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(NoOpPlanner)
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: 'User_5', title: 'Gold' },
          { name: 'User_12', title: 'Silver' },
        ]),
      );
    });

    it('allows changing planner dynamically via db.setPlanner()', async () => {
      db.setPlanner(NoOpPlanner);
      expect(db.getPlanner()).toBe(NoOpPlanner);

      const explainNoOp = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .explain();
      expect(explainNoOp.plan.joinOrder).toEqual(['users', 'badges']);

      // Switch back to CostBasedPlanner
      db.setPlanner(CostBasedPlanner);
      const explainCost = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .explain();
      expect(explainCost.plan.joinOrder).toEqual(['badges', 'users']);
    });

    it('supports query-level planner override with .withPlanner()', async () => {
      db.setPlanner(NoOpPlanner);

      // Query overrides db-level NoOpPlanner with CostBasedPlanner
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(CostBasedPlanner)
        .explain();

      expect(explain.plan.joinOrder).toEqual(['badges', 'users']);
    });

    it('supports custom planner implementation', async () => {
      let customInvoked = false;
      const customPlanner: QueryPlanner = {
        name: 'custom-tracker',
        optimize: (plan) => {
          customInvoked = true;
          return new CostBasedPlanner().optimize(plan);
        },
      };

      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(customPlanner)
        .toArray();

      expect(customInvoked).toBe(true);
      expect(rows).toHaveLength(2);
    });

    it('CustomOrderPlanner enforces specified table order using array of names', async () => {
      // Force users first
      const explainUsersFirst = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(new CustomOrderPlanner(['users', 'badges']))
        .explain();

      expect(explainUsersFirst.plan.joinOrder).toEqual(['users', 'badges']);

      // Force badges first
      const explainBadgesFirst = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(new CustomOrderPlanner(['badges', 'users']))
        .explain();

      expect(explainBadgesFirst.plan.joinOrder).toEqual(['badges', 'users']);

      // Execute query with badges first and verify rows are correct
      const rows = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(new CustomOrderPlanner(['badges', 'users']))
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: 'User_5', title: 'Gold' },
          { name: 'User_12', title: 'Silver' },
        ]),
      );
    });

    it('CustomOrderPlanner supports comparator function', async () => {
      // Sort tables in reverse alphabetical order: 'users' before 'badges'
      const explain = await db
        .from('users')
        .join('badges', 'users.id', '=', 'badges.user_id')
        .select(['users.name', 'badges.title'])
        .withPlanner(new CustomOrderPlanner((a, b) => b.name.localeCompare(a.name)))
        .explain();

      expect(explain.plan.joinOrder).toEqual(['users', 'badges']);
    });
  });
});
