# Joins, Grouping & Aggregations

WebDB supports relational `INNER JOIN` and `LEFT JOIN` queries across up to 16 tables, as well as `GROUP BY` aggregations (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`) and post-aggregation `HAVING` filters.

---

## 1. Joining Tables (`.join()`, `.innerJoin()`, `.leftJoin()`)

### `INNER JOIN` (`.join()` / `.innerJoin()`)

Returns rows where there is a match in both tables. You can pass `(table, leftCol, rightCol)` (which defaults to `'='`) or explicitly pass a comparison operator `(table, leftCol, '=', rightCol)`:

```typescript
const userOrders = await db
  .from('users')
  .join('orders', 'users.id', '=', 'orders.user_id')
  .select(
    'users.name as customerName',
    'orders.id as orderId',
    'orders.total as orderTotal',
  )
  .where('users.country', '=', 'US')
  .where('orders.total', '>', 100)
  .orderBy('orders.total', 'desc')
  .toArray();
```

### `LEFT JOIN` (`.leftJoin()`)

Returns all rows from the left (driving) table, filling columns from the joined table with `null` when no matching row exists:

```typescript
// Find all users and their badge (if they have one)
const usersWithBadges = await db
  .from('users')
  .leftJoin('badges', 'users.id', '=', 'badges.user_id')
  .select('users.name as name', 'badges.title as badgeTitle')
  .toArray();
// Unmatched rows have { name: 'Bob', badgeTitle: null }
```

### Multi-Table Joins

Chain multiple `.join()` or `.leftJoin()` calls to join several tables in a single query. WebDB's query planner automatically determines the optimal join order and uses secondary B+Tree indexes whenever available:

```typescript
const report = await db
  .from('orders')
  .join('users', 'orders.user_id', '=', 'users.id')
  .leftJoin('coupons', 'orders.coupon_id', '=', 'coupons.id')
  .select(
    'orders.id as orderId',
    'users.email as email',
    'coupons.code as couponCode',
    'orders.total as total',
  )
  .where('orders.status', '=', 'paid')
  .toArray();
```

> [!TIP]
> **Performance Tip:** Always create an index (`await db.createIndex('orders', 'user_id')`) on foreign key columns used in joins. This allows WebDB to perform fast indexed nested-loop lookups rather than scanning the inner table repeatedly.

---

## 2. Aggregations (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`)

You can write aggregate queries using either `.select()` expressions or dedicated aggregate helper methods (`.count()`, `.sum()`, `.avg()`, `.min()`, `.max()`).

### Whole-Table Aggregation

```typescript
// Using .select() expressions
const summary = await db
  .from('orders')
  .where('status', '=', 'paid')
  .select(
    'count(*) as totalOrders',
    'sum(total) as grossRevenue',
    'avg(total) as averageOrderValue',
    'min(total) as smallestOrder',
    'max(total) as largestOrder',
  )
  .first();

console.log(summary);
// { totalOrders: 128, grossRevenue: 19450.5, averageOrderValue: 151.95, ... }
```

Or using the fluent aggregate methods:

```typescript
const stats = await db
  .from('orders')
  .count('*', 'totalOrders')
  .sum('total', 'revenue')
  .avg('total', 'avgOrder')
  .first();
```

---

## 3. Grouping Rows (`.groupBy()`)

Group records by up to **8 columns** (or expressions) to compute aggregates per group:

```typescript
const salesByCategory = await db
  .from('products')
  .groupBy('category')
  .select(
    'category',
    'count(*) as productCount',
    'avg(price) as avgPrice',
    'sum(stock) as totalStock',
  )
  .orderBy('productCount', 'desc')
  .toArray();

console.table(salesByCategory);
// ┌─────────┬───────────────┬──────────────┬──────────┬────────────┐
// │ (index) │ category      │ productCount │ avgPrice │ totalStock │
// ├─────────┼───────────────┼──────────────┼──────────┼────────────┤
// │ 0       │ 'Electronics' │ 45           │ 299.99   │ 1200       │
// │ 1       │ 'Books'       │ 32           │ 24.50    │ 850        │
// └─────────┴───────────────┴──────────────┴──────────┴────────────┘
```

### Multi-Column `GROUP BY`

Pass multiple column names (or an array) to `.groupBy()`:

```typescript
const regionalSales = await db
  .from('orders')
  .groupBy('region', 'status')
  .select('region', 'status', 'count(*) as count', 'sum(total) as total')
  .toArray();
```

---

## 4. Filtering Groups (`.having()`)

While `.where()` filters individual rows *before* grouping, `.having()` filters the aggregated groups *after* `GROUP BY` is computed.

WebDB supports `.having()`, `.orHaving()`, `.havingNot()`, `.orHavingNot()`, `.havingNull()`, and `.havingNotNull()`:

```typescript
// Find departments with at least 5 employees AND an average salary over $100,000
const largeHighPayDepts = await db
  .from('employees')
  .where('active', '=', 1)
  .groupBy('department')
  .select(
    'department',
    'count(*) as headcount',
    'avg(salary) as avgSalary',
  )
  .having('count(*)', '>=', 5)
  .having('avg(salary)', '>', 100000)
  .orderBy('avgSalary', 'desc')
  .toArray();
```

> [!IMPORTANT]
> Aggregate functions (`count`, `sum`, `avg`, `min`, `max`) cannot be used inside `.where()`—doing so throws `AggregateNotAllowedInWhereError`. Always place aggregate conditions in `.having()`.

