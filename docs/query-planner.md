# Query Performance, Planners & `.explain()`

When you write a query with WebDB's Query Builder, you describe **what** data you want, and WebDB's query planner automatically determines the fastest way to execute it—choosing which indexes to use, which table to scan first in a join, and which filters to evaluate first.

This guide shows how to inspect query execution plans with `.explain()`, optimize slow queries with indexes, and configure WebDB's query planner when needed.

---

## 1. Inspecting Queries with `.explain()`

Append `.explain()` instead of `.toArray()` to any query to inspect its execution plan without modifying data:

```typescript
const explanation = await db
  .from('users')
  .join('orders', 'users.id', '=', 'orders.user_id')
  .where('users.country', '=', 'US')
  .where('orders.total', '>', 100)
  .explain();

console.log(explanation.plan);
```

### Understanding `explanation.plan`

The `plan` object gives you immediate answers about how your query will run:

| Property | Type | What to Look For |
| :--- | :--- | :--- |
| **`scanType`** | `'IndexScan' \| 'TableScan'` | `'IndexScan'` means WebDB is using a B+Tree index on the driving table; `'TableScan'` means it is scanning every row. |
| **`indexName`** | `string \| undefined` | The name of the index selected for the driving table (e.g. `'idx_users_country'`). |
| **`joinOrder`** | `string[] \| undefined` | The exact order in which joined tables will be traversed (e.g. `['users', 'orders']`). |
| **`joins`** | `JoinClause[] \| undefined` | Shows `scanType` and `indexName` for each joined inner table. |
| **`isOrderSatisfied`** | `boolean \| undefined` | `true` when `ORDER BY` is satisfied directly by an index scan without needing an in-memory sort! |
| **`estimatedCost`** | `number \| undefined` | Relative cost score calculated by the optimizer. |
| **`estimatedRows`** | `number \| undefined` | Estimated number of output rows. |

You can also print `explanation.assembly` to view the human-readable bytecode disassembly:

```typescript
console.log(explanation.assembly);
/*
================== QUERY PLAN ==================
Table:        users (Root Page: 2)
Scan Type:    IndexScan (idx_users_country)
Join Order:   users -> orders
Bytecode Size: 84 bytes
...
*/
```

---

## 2. How WebDB Optimizes Your Queries Automatically

### A. Automatic Index Selection (Single & Composite)

When a column in your `.where()` clause has an index, WebDB automatically switches from a full `TableScan` to an `IndexScan`:

- **Equality (`=`) & `whereIn`:** Seeks directly to the matching key(s).
- **Ranges (`>`, `>=`, `<`, `<=`):** Seeks to the lower bound and scans forward until the upper bound.
- **Composite Index Prefixes:** An index on `['tenant_id', 'created_at']` accelerates queries filtering on `tenant_id` alone or on both `tenant_id` and `created_at`.

### B. Zero-Sort `ORDER BY ... LIMIT` via Indexes

Normally, `ORDER BY score ASC LIMIT 10` on a 50,000-row table requires scanning and sorting all 50,000 rows before returning 10.

If you create an index on `score` (`await db.createIndex('users', 'score')`), WebDB detects that the B+Tree index is already sorted in ascending order:
1. It skips the in-memory sorter completely (`isOrderSatisfied: true`).
2. It reads the first 10 entries from the index leaf page and halts immediately!

This optimization also works on composite indexes when leading columns are pinned by equality:

```typescript
await db.createIndex('scores', ['tenant_id', 'score']);

// Streams the top 5 rows directly from the index with zero sorting!
const topScores = await db
  .from('scores')
  .where('tenant_id', '=', 1)
  .orderBy('score', 'asc')
  .limit(5)
  .toArray();
```

### C. Predicate Pushdown & Short-Circuiting

- **Cheap Checks First:** WebDB automatically reorders `AND` filters so fast checks (`IS NOT NULL`, integer comparisons) run before expensive checks (`LIKE '%pattern%'` or custom UDFs).
- **Transitive Join Inference:** In `.join('orders', 'users.id', '=', 'orders.user_id').where('users.id', '=', 42)`, WebDB automatically infers `orders.user_id = 42` and uses an index seek on both tables.
- **Contradiction Short-Circuiting:** If dynamic UI filters produce an impossible condition (such as `where('id', '=', 1).where('id', '=', 2)` or `whereIn('status', [])`), WebDB detects the contradiction at compile time and returns `[]` in 1 instruction with zero page reads.

---

## 3. Configuring or Overriding the Query Planner

By default, WebDB uses **`CostBasedPlanner`**, which explores join permutations using dynamic programming to find the globally cheapest execution plan.

For specialized workloads, you can swap or override the planner at the database level or per query:

| Planner Class | How It Works | When to Use It |
| :--- | :--- | :--- |
| **`CostBasedPlanner`** *(Default)* | Explores table subsets via dynamic programming to minimize total I/O and CPU cost. | Best for 99% of application queries and complex multi-table joins. |
| **`HeuristicPlanner`** | Fast greedy search that picks the smallest/indexed table at each step. | Queries joining 10+ tables where compilation speed is critical. |
| **`CustomOrderPlanner`** | Locks the join order to an explicit array of table names you provide. | When you want to force a specific join sequence manually. |
| **`NoOpPlanner`** | Executes tables in the exact syntactic order written in `.from().join()`. | Benchmarking or debugging raw query execution without optimizer reordering. |

### Per-Query Planner Override (`.withPlanner()`)

Force a specific join order or planner strategy for a single query:

```typescript
import { CustomOrderPlanner } from '@ahmadmoussawi/webdb';

const rows = await db
  .from('users')
  .join('orders', 'users.id', '=', 'orders.user_id')
  .join('badges', 'users.id', '=', 'badges.user_id')
  .withPlanner(new CustomOrderPlanner(['badges', 'users', 'orders']))
  .toArray();
```

### Database-Wide Default Planner

Set the default planner when opening the database or change it at runtime with `db.setPlanner()`:

```typescript
import { WebDB, HeuristicPlanner, CostBasedPlanner } from '@ahmadmoussawi/webdb';

const db = await WebDB.open({
  name: 'analytics_db',
  storage: 'idb',
  planner: new HeuristicPlanner(),
});

// Switch back to the default cost-based planner at runtime
db.setPlanner(new CostBasedPlanner());
```
