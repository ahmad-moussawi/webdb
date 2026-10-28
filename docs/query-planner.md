# Understanding the Query Planner

A database query planner is the **brain** of a relational database engine. When you write a query using SQL or WebDB's fluent Query Builder, you describe **what** data you want, not **how** to fetch it from disk or memory. The query planner is responsible for analyzing your query and determining the most efficient execution strategy (the "physical plan") before emitting bytecode for the virtual database engine (VDBE).

This guide explains how query planning works, dives into WebDB's planner architecture, and compares WebDB's design against industry standard database engines like **SQLite**, **MySQL**, and **PostgreSQL**.

---

## 1. Why Do Databases Need a Planner?

Consider a simple relational query joining three tables:

```typescript
const rows = await db
  .from("users")
  .join("orders", "users.id", "=", "orders.user_id")
  .join("coupons", "orders.coupon_id", "=", "coupons.id")
  .where("users.country", "=", "Lebanon")
  .where("orders.total", ">", 100)
  .toArray();
```

Behind this declarative query lies a combinatorial puzzle:

1. **Join Permutations ($N!$)**:
   - For $3$ tables, there are $3! = 6$ possible join sequences (`users -> orders -> coupons`, `coupons -> orders -> users`, etc.).
   - For $6$ tables, there are $720$ sequences.
   - For $10$ tables, there are **$3,628,800$** sequences.
2. **Access Methods**:
   - Should `users` be scanned with a sequential TableScan or an IndexScan on `country`?
   - Should `orders` be joined using an Index Seek on `orders.user_id`, or scanned sequentially?
3. **Filter Placement & Pushdown**:
   - When should `users.country = 'Lebanon'` be evaluated? If evaluated *after* joining all 100,000 orders, you waste massive CPU time joining rows that will just be discarded. If evaluated *first*, you only join the few users that match!
4. **Intermediate Cardinality Explosion**:
   - A poor join sequence can create millions of intermediate candidate rows, causing queries to run in seconds or minutes instead of milliseconds.

A good query planner evaluates these trade-offs and generates an optimal execution plan in **microseconds**.

---

## 2. WebDB's Query Planner Architecture

In WebDB, query planning is handled by a unified engine that addresses two complementary dimensions: **Predicate (WHERE) Optimization** and **Join Ordering & Access Path Selection**.

```
              ┌──────────────────────────────────────┐
              │          AST / QueryPlan             │
              │  (tables, joinedTables, filters...)  │
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │      1. WHERE Predicate Optimizer    │
              │  - Contradiction detection (OP_HALT) │
              │  - Subsumption & redundancy pruning  │
              │  - CPU evaluation-cost reordering    │
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │   2. Transitive Predicate Inference  │
              │   (users.id = 1 ∧ users.id = orders. │
              │    user_id ⇒ orders.user_id = 1)     │
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │    3. Pluggable Join & Access Search │
              │   CostBased | Heuristic | CustomOrder│
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │       Optimized Execution Plan       │
              │  (Driving table, pushdowns, indices) │
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │        Bytecode Emitter (VDBE)       │
              └──────────────────────────────────────┘
```

---

## 3. Predicate (WHERE) Optimization

Before evaluating table permutations, WebDB runs semantic optimizations over the query's WHERE clauses.

### A. Contradiction Detection (Compile-Time Short-Circuiting)

If a query contains mutually exclusive predicates, the result is mathematically guaranteed to be empty. Rather than scanning tables, opening cursors, or allocating buffers, WebDB detects the contradiction at compile time and emits a **1-byte `OP_HALT`** program.

```typescript
// Contradictory equality: id cannot simultaneously be 1 and 2
const explain = await db
  .from("products")
  .where("id", "=", 1)
  .where("id", "=", 2)
  .explain();

// Bytecode size: 1 byte (OP_HALT)
// Instructions: 1
console.log(explain.instructions[0].opcode); // "OP_HALT"
```

WebDB detects contradictions across several predicate patterns:
- **Conflicting Equalities**: `x = 1 AND x = 2`.
- **Nullity Conflicts**: `x IS NULL AND x IS NOT NULL`, or `x IS NULL AND x = 5`.
- **Impossible Range Intersections**: `price > 1000 AND price < 200`.

### B. Redundancy Elimination & Range Subsumption

Developers and ORMs frequently produce redundant filters. WebDB collapses them:
- **Duplicate filters**: `category = 'Electronics' AND category = 'Electronics'` $\rightarrow$ executed once.
- **Subsumed ranges**: `age > 18 AND age > 21` $\rightarrow$ collapsed to `age > 21`.

### C. Cost-Based Short-Circuit Reordering

In computer architecture and virtual machines, evaluating conditions with short-circuiting (`&&`) is fastest when cheap, highly selective checks run before expensive operations.

WebDB assigns an intrinsic evaluation cost to each predicate type:

| Predicate Type | Relative Cost | Rationale |
| :--- | :--- | :--- |
| `IS NULL` / `IS NOT NULL` | **1** | Direct bitmask check in row null-vector |
| Integer Comparison (`=`, `<`) | **2–3** | Single 32-bit register CPU comparison |
| Float Comparison | **3–4** | Floating-point hardware comparison |
| String Comparison (`=`) | **4–6** | Byte-by-byte string comparison |
| `IN (v1, v2, v3)` | **5–10** | Small hash lookup or sequential list check |
| Substring / `LIKE '%pattern%'` | **15–25** | String search / pattern match over text |
| UDF / Complex Expression | **40+** | JavaScript call stack or expression evaluator |

When constructing the VDBE scan loop, WebDB sorts conjunctions by cost. A failing `status IS NOT NULL` will immediately skip the row before a heavy `LIKE '%search%'` is ever evaluated.

### D. Transitive Predicate Inference

When tables are joined with equality (`=`), constraints on one table logically apply to the other:

$$\text{users.id} = 42 \quad \land \quad \text{users.id} = \text{orders.user\_id} \quad \implies \quad \text{orders.user\_id} = 42$$

WebDB infers `orders.user_id = 42` and pushes it into the `orders` scan. If `orders` has an index on `user_id`, this transforms what would have been an unindexed scan into a targeted point lookup!

Furthermore, if the query already had a conflicting condition (e.g. `orders.user_id = 99`), transitive inference identifies the cross-table contradiction and short-circuits the entire query to `OP_HALT`.

---

## 4. Interesting Orders & Sort Optimization

One of the most consequential innovations in query planning is the concept of **"Interesting Orders,"** pioneered by Patricia Selinger in IBM's foundational System R paper (1979).

In relational database systems, a physical scan operator (such as a B-Tree index scan) may produce rows in a specific sorted order as a natural consequence of its underlying data structure. If that physical order happens to match the query's `ORDER BY`, `GROUP BY`, or merge-join key, the ordering is considered **"interesting"** because it can eliminate downstream sorting steps entirely.

### The Problem: In-Arena Sorter Overhead

When a database engine cannot guarantee that rows arrive pre-sorted, it must buffer every matching row into a temporary sorter structure:

1. **Memory Allocation**: Opens an in-arena sorter (`OP_SORTER_OPEN`).
2. **Buffering**: Reads all matching rows and inserts them into the sorter (`OP_SORTER_INSERT`).
3. **Sorting Algorithm**: Runs an $O(M \log M)$ sorting phase (`OP_SORTER_SORT`), materializing the entire candidate set in memory.
4. **Delayed Emission**: Emits rows only after the full sort completes (`OP_SORTER_NEXT`).

If a table contains 100,000 rows and the query asks for `ORDER BY score ASC LIMIT 5`, an unoptimized plan must scan and sort all 100,000 rows before returning the first 5!

### How WebDB Leverages B-Tree Ordering

WebDB secondary indexes are organized as sorted B+Tree leaf pages. A forward traversal (`OP_OPEN_INDEX`, `OP_INDEX_SEEK_GE`, `OP_INDEX_NEXT`) naturally visits keys in **ascending (ASC)** order with zero memory allocation.

WebDB's query planner detects when an index satisfies `plan.orderBy`:

1. **Single-Column Index Ordering**:
   An index on `score` matches `ORDER BY score ASC`. WebDB seeks directly to the first index entry and iterates forward.
2. **Indexed Range + Sort Alignment**:
   A query with `WHERE score >= 85 ORDER BY score ASC` performs an exact `OP_INDEX_SEEK_GE` at 85, streaming rows in sorted order directly to the output.
3. **Composite Index Prefix Alignment**:
   For a composite index on `(tenant_id, score)`:
   ```typescript
   // tenant_id is pinned to a constant by equality:
   db.from("scores").where("tenant_id", "=", 1).orderBy("score", "asc")
   ```
   Because `tenant_id` is constant, all rows for tenant 1 are physically clustered in `score ASC` order. WebDB streams them directly!
4. **Top-K Early Termination (`LIMIT`)**:
   When `LIMIT K` is combined with an interesting order, the VDBE stream halts immediately after $K$ rows via `OP_LIMIT`. Execution time drops from $O(M \log M)$ to $O(K)$.

### Cost-Based Modeling of Sort Elimination

`CostBasedPlanner` explicitly models the cost of explicit sorting versus pre-ordered index scans:

$$\text{Sort Cost} = M \log_2(M) \times \text{COST\_ROW\_EVAL}$$

- **Unordered Plan**: $\text{Base Scan Cost} + \text{Sort Cost}$
- **Interesting Order Plan**: $\text{Index Seek Cost} + \min(K, M) \times \text{Index Next Cost}$ (No Sort Cost!)

The planner credits the avoided sorting cost (`sortCostAvoided`) and marks `isOrderSatisfied: true`. The bytecode compiler then completely bypasses `OP_SORTER_*` generation and emits a streaming index scan.

If `direction === 'desc'` or the column is unindexed, the planner recognizes that forward B-tree scanning cannot satisfy the order, and automatically falls back to the in-arena sorter.

### Phase 2: Joins with Order Preservation

In multi-table queries, sorting overhead is often the primary bottleneck because the intermediate join cardinality $M \times J$ is substantially larger than single-table row counts. WebDB extends interesting orders to nested loop joins:

#### 1. The Nested Loop Order Preservation Invariant
In a nested loop join, the outer table (**Table 0**, or the driving table) controls the iteration stream:
$$\text{Output Row Stream} = \bigcup_{i=1}^{R_0} \left( \text{Row}_0^{(i)} \bowtie \text{InnerTables}(\text{Row}_0^{(i)}) \right)$$

Because all matching inner rows for outer row $i$ are completely emitted before the engine advances to outer row $i+1$:
- If **Table 0** is scanned via an index in `ORDER BY` order,
- And all `ORDER BY` columns belong to **Table 0** and are sorted in `ASC` order,
- **Then the entire multi-table join stream is guaranteed to be emitted in sorted order!**

This holds true for both `INNER JOIN` and `LEFT JOIN` (where unmatched outer rows are immediately emitted as NULL-padded records at position $i$ before advancing to $i+1$).

#### 2. Automatic Driving Table Inversion
Consider an e-commerce query looking for top-scoring users and their orders:

```typescript
// Developer writes join starting from 'orders':
await db.from('orders')
  .join('users', 'orders.user_id', '=', 'users.id')
  .orderBy('users.score', 'asc')
  .limit(5)
  .toArray();
```

- **Unoptimized Engine**: Scans `orders`, joins `users`, generates every order/user pair into memory, runs quicksort on all records, and slices the first 5.
- **WebDB Query Planner**:
  1. Detects that `users.score` has an index `idx_user_score`.
  2. Compares permutations in Dynamic Programming: `[orders, users]` (cost includes sorting thousands of joined rows) versus `[users, orders]` (pre-sorted driving table, sort cost avoided).
  3. **Inverts the join order** so `users` becomes the driving table.
  4. Emits `OP_INDEX_SEEK_GE` and `OP_INDEX_NEXT` on `users`, joins `orders` via `idx_order_user_id`, and halts immediately after 5 rows via inline `OP_LIMIT`!

#### 3. Fallback Mechanics
If `ORDER BY` references an inner table (e.g., `orders.amount`) or requests `DESC` sorting on a forward index, the planner identifies that the join stream cannot be preserved. The VDBE safely disables inline limit termination, streams all joined rows, and passes them to JavaScript for post-aggregation sorting and pagination.

---

## 5. WebDB's Pluggable Planner Types

WebDB implements a pluggable `QueryPlanner` interface, providing specialized planners for different workloads:

```typescript
export interface QueryPlanner {
  readonly name: string;
  optimize(plan: QueryPlan): OptimizedPlanResult;
}
```

### 1. `CostBasedPlanner` (Default)

The `CostBasedPlanner` uses **System-R / Selinger-style Dynamic Programming (DP)**.

- **How it works**: It explores permutations across subsets of tables using bitmasks ($2^N$ states). For each subset, it calculates the minimum cumulative cost to join that subset with any remaining table.
- **Cost Model**:
  $$\text{Total Cost} = \sum (\text{Seek Cost} + \text{Next Cost} + \text{Row Evaluation Cost})$$
  - `COST_INDEX_SEEK = 0.5`
  - `COST_INDEX_NEXT = 0.05`
  - `COST_ROW_EVAL   = 0.02`
- **Global Optimality**: Because it explores the full subset graph, it avoids the "greedy trap" where an early cheap step creates massive intermediate row amplification later.
- **Best for**: Standard queries ($\le 8$–$10$ tables), complex join graphs, and queries with selective filters where join order is critical.

### 2. `HeuristicPlanner`

The `HeuristicPlanner` uses a **Greedy Nearest-Neighbor search** running in $O(N^2)$ time.

- **How it works**:
  1. Computes the base cardinality of each table with its pushed-down single-table filters.
  2. Selects the single best driving table (lowest row count, preferring indexed access).
  3. At each step, greedily joins the connected table that has the lowest immediate step cost (strongly preferring available index seeks).
- **Best for**:
  - High-throughput micro-queries where query compilation overhead must be sub-millisecond.
  - Large join graphs ($N > 10$ tables) where dynamic programming search space ($2^N$) would cause compilation latency.
  - Star schemas where a central fact table joins to dimension tables via primary keys (where the greedy path is already optimal).

### 3. `NoOpPlanner`

The `NoOpPlanner` implements **Straight Query Execution**.

- **How it works**: It preserves the exact table order written by the developer without reordering tables or pruning contradictions at compile time.
- **Best for**:
  - Benchmarking raw engine execution without optimizer interference.
  - Query debugging to compare performance against the cost optimizer.
  - Scenarios where the developer wants absolute, deterministic control over the exact loop nesting.

### 4. `CustomOrderPlanner`

Allows explicit specification of the join order via an array of table names or a custom comparator function:

```typescript
// Explicit order
const planner = new CustomOrderPlanner(['badges', 'users', 'logs']);

// Or custom comparator
const planner = new CustomOrderPlanner((a, b) => a.name.localeCompare(b.name));
```

WebDB automatically reconstructs join conditions, projections, and index seeks to conform to your specified order.

### 5. `CustomPlanner`

Allows defining custom optimization passes using a simple callback function:

```typescript
const customPlanner = new CustomPlanner((plan) => {
  // Inspect or transform AST plan...
  return new CostBasedPlanner().optimize(plan);
});
```

---

## 6. Case Study: The "Greedy Trap"

To understand why `CostBasedPlanner` is the default, consider the **Greedy Trap**:

Suppose we have 3 tables:
- `users`: 10 rows matching `where('status', '=', 'active')`.
- `sessions`: 1,000 rows (has an index on `user_id`).
- `devices`: 50 rows (no index, small lookup table).

```
                     ┌───────────────┐
                     │  users (10)   │
                     └───────┬───────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   Path A (Index Scan)               Path B (Table Scan)
   sessions (idx on user_id)         devices (no index, 50 rows)
   Immediate step cost: Low          Immediate step cost: Medium
   Yields: 1,000 rows!               Yields: 10 rows!
```

### What `HeuristicPlanner` does:
1. Starts at `users` (10 rows).
2. Looks at candidates connected to `users`: `sessions` has an index on `user_id`. Since an index seek appears cheap, it greedily picks `sessions`.
3. Now it must join `devices`. Because there are 1,000 intermediate rows from `sessions` and no index on `devices`, it must run 1,000 full table scans of `devices` ($1,000 \times 50 = \mathbf{50,000\text{ comparisons}}$).

### What `CostBasedPlanner` does:
1. Evaluates all subset combinations in its dynamic programming table:
   - `users -> sessions -> devices`: Cost $\approx 50,500$
   - `devices -> sessions -> users`: Cost $\approx 120$
2. It detects that driving through `devices` first or avoiding intermediate cardinality expansion yields an execution plan that is **~400x faster**.

---

## 7. How WebDB Compares to SQLite, MySQL, and PostgreSQL

Different database engines make distinct architectural trade-offs based on their execution environments (embedded, client-server, or analytics warehouse).

| Dimension | WebDB | SQLite | MySQL (InnoDB) | PostgreSQL |
| :--- | :--- | :--- | :--- | :--- |
| **Execution Environment** | Browser / Web Workers / Node.js | Embedded C process | Client-Server RDBMS | Advanced Object-Relational RDBMS |
| **Join Strategy** | System-R DP or Greedy Nearest-Neighbor | Greedy search with 3-way nested loop heuristic | Dynamic Programming with `optimizer_search_depth` | System-R DP for small joins; Genetic Optimizer (**GEQO**) for large joins |
| **Join Reorder Limit** | DP up to 16 cursors; or instant $O(N^2)$ greedy | Up to 64 tables (heuristic pruning) | Configurable (default depth 62, typically 7–10) | DP up to `geqo_threshold` (default 12), then Genetic algorithm |
| **Statistics** | Row count estimates + Index metadata | `ANALYZE` (sqlite_stat1, stat4 histograms) | Index dives + persistent stats tables (`mysql.innodb_table_stats`) | Rich statistical engine (`pg_statistic`, MCV lists, histograms, correlation) |
| **WHERE Optimization** | Compile-time short-circuit (`OP_HALT`), bound subsumption, transitive inference | Constant folding, term equalization, indexable WHERE terms | Range analysis, condition pushdown, ICP (Index Condition Pushdown) | Complex expression simplification, boolean normalization, partition pruning |
| **Memory / CPU Budget** | Microsecond compile budget (< 0.1ms) | Microsecond budget in embedded C | Millisecond budget | Multi-millisecond budget for complex planning |
| **Custom Overrides** | Pluggable classes (`NoOp`, `CustomOrder`, `.withPlanner()`) | `CROSS JOIN` operator forces join order | Optimizer hints (`STRAIGHT_JOIN`, `JOIN_ORDER`) | Hints via extensions (`pg_hint_plan`), `SET enable_*` flags |

### Detailed Comparison

### 1. WebDB vs. SQLite
- **Architecture**: WebDB's VDBE bytecode design is directly inspired by SQLite. Both databases compile declarative queries into bytecode executed by a register-based virtual machine.
- **Planning Approach**: SQLite primarily uses a greedy heuristic for join ordering (evaluating up to a small number of candidate tables at each step) unless you use the `CROSS JOIN` syntax to disable reordering. WebDB provides full **System-R dynamic programming** as its default, ensuring global join optimality for queries up to WebDB's 16-cursor limit, while offering a pluggable greedy alternative (`HeuristicPlanner`).
- **Statistics**: SQLite uses an optional `ANALYZE` command that stores statistics in `sqlite_stat1` and `sqlite_stat4`. WebDB relies on schema-tracked row count estimates and index descriptors, eliminating the need for periodic offline maintenance in browser storage.

### 2. WebDB vs. MySQL
- **Architecture**: MySQL uses a client-server architecture with server-side query caching and thread pools.
- **Join Optimization**: MySQL's optimizer uses dynamic programming up to a parameter called `optimizer_search_depth`. If the number of tables exceeds this depth, MySQL switches to a greedy search. WebDB provides this distinction explicitly through distinct, swappable planner classes (`CostBasedPlanner` vs `HeuristicPlanner`).
- **Hints**: In MySQL, you can force join order using `SELECT STRAIGHT_JOIN ...`. In WebDB, you achieve the same clean control with `NoOpPlanner` or `CustomOrderPlanner`.

### 3. WebDB vs. PostgreSQL
- **Architecture**: PostgreSQL has one of the most advanced cost-based optimizers in the database industry.
- **The Genetic Algorithm (GEQO)**: For queries joining more than 12 tables (`geqo_threshold`), Postgres switches from dynamic programming to a **Genetic Query Optimizer** that treats join orders as chromosomes and mutates them to converge on a good plan without exploring all $N!$ states.
- **Statistics & Costs**: Postgres models disk I/O costs (`random_page_cost`, `seq_page_cost`) vs CPU costs (`cpu_tuple_cost`, `cpu_operator_cost`). Because WebDB runs inside the browser with memory or IndexedDB 4KB slotted pages, its cost model focuses directly on **B-Tree index seek overhead** vs **linear page iteration** and **CPU evaluation cost**.

---

## 8. How to Use and Configure Planners in WebDB

### Database-Level Default Planner

Set the default planner for all queries executed on the database instance:

```typescript
import { WebDB, HeuristicPlanner } from "@webdb/core";

const db = await WebDB.open({
  name: "analytics_db",
  storage: "memory",
  planner: new HeuristicPlanner(), // Use greedy planner globally
});

console.log(db.getPlanner().name); // "heuristic"
```

### Changing the Planner Dynamically

You can switch the database planner at runtime:

```typescript
import { CostBasedPlanner, NoOpPlanner } from "@webdb/core";

// Switch to straight-join execution
db.setPlanner(new NoOpPlanner());

// Switch back to cost-based dynamic programming
db.setPlanner(new CostBasedPlanner());
```

### Per-Query Planner Override

Override the planner for an individual critical query using `.withPlanner()`:

```typescript
import { CostBasedPlanner, CustomOrderPlanner } from "@webdb/core";

// Force a specific join sequence for this single query
const results = await db
  .from("users")
  .join("orders", "users.id", "=", "orders.user_id")
  .join("badges", "users.id", "=", "badges.user_id")
  .withPlanner(new CustomOrderPlanner(["badges", "orders", "users"]))
  .toArray();
```

---

## 9. Inspecting Plans with `.explain()`

WebDB provides complete visibility into optimizer decisions via `.explain()`:

```typescript
const explanation = await db
  .from("users")
  .join("orders", "users.id", "=", "orders.user_id")
  .where("users.country", "=", "Lebanon")
  .where("users.age", ">", 18)
  .explain();

console.log("Optimal Join Order:", explanation.plan.joinOrder);
console.log("Total Estimated Cost:", explanation.plan.estimatedCost);
console.log("Estimated Result Rows:", explanation.plan.estimatedRows);

// View full disassembled VDBE bytecode
console.log(explanation.assembly);
```

Sample output:
```text
================== QUERY PLAN ==================
Table:        users (Root Page: 2)
Scan Type:    TableScan
Join Order:   users -> orders
Bytecode Size: 84 bytes

========= VDBE BYTECODE DISASSEMBLY (EXPLAIN) =========
ADDR     OPCODE             P1           P2                   P3         COMMENT
-----------------------------------------------------------------------------------------------
0x0000   OP_LOAD_TEXT       r[3]         'Lebanon'                       Load literal text into r[3]
0x0006   OP_LOAD_INT        r[4]         18                              Load literal int into r[4]
0x000c   OP_OPEN_CURSOR     c[0]         page=2                          Open cursor 0 on 'users'
0x0012   OP_OPEN_CURSOR     c[1]         page=4                          Open cursor 1 on 'orders'
0x0018   OP_OPEN_INDEX      c[2]         page=6                          Open index cursor 2 on 'orders_user_id'
0x001e   OP_REWIND          c[0]         0x0050                          Rewind cursor 0; jump if empty
...
```

---

## 10. Developer Best Practices & Summary

1. **Let `CostBasedPlanner` do the heavy lifting**: The default planner guarantees optimal join order and transitive inference for general application queries.
2. **Index foreign keys**: When joining `users.id = orders.user_id`, make sure `orders.user_id` has an index. Both the cost-based and heuristic planners detect single-column and composite indices to switch from full loops to direct $O(\log N)$ seeks.
3. **Use `HeuristicPlanner` for microsecond latency**: If you run hundreds of small queries per second or have queries with $> 10$ joins, instantiate `HeuristicPlanner` to eliminate planning overhead.
4. **Use `.explain()` to verify index usage**: Check whether `scanType` is `IndexScan` or `TableScan`. If you see unexpected table scans, inspect the join column types and filter predicates.
5. **Take advantage of compile-time short-circuiting**: Avoid unnecessary `if` checks in application code—if your query filters are contradictory (e.g. dynamic filters from a search UI), WebDB halts immediately with zero page I/O.
