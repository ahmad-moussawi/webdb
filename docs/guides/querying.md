# Querying Data (`SELECT`, `WHERE`, `ORDER BY`, Pagination)

Start any query by calling `db.from(tableName)`. This returns a fluent [`QueryBuilder`](./src/host/api/query_builder.ts#L340-L365) instance that compiles your query directly into compact engine instructions when you call `.toArray()` or `.first()`.

---

## 1. Selecting & Aliasing Columns (`.select()`)

If you omit `.select()`, WebDB returns all columns from the table (`SELECT *`). To project specific columns, rename fields, or compute expressions, use `.select()`:

```typescript
// 1. Select specific columns by name
const users = await db.from("users").select("id", "name", "email").toArray();

// 2. Rename columns using SQL "AS" strings
const renamed = await db
  .from("users")
  .select("id", "name as fullName", "salary * 12 as annualPay")
  .toArray();

// 3. Rename columns using a key-value map ({ sourceColumn: 'targetAlias' })
const mapped = await db
  .from("users")
  .select({
    id: "userId",
    name: "displayName",
    role: "jobTitle",
  })
  .toArray();

// 4. Rename columns using explicit { col, as } objects
const explicit = await db
  .from("users")
  .select(["id", { col: "name", as: "fullName" }])
  .toArray();
```

---

## 2. Filtering Rows (`WHERE`)

### Standard Comparisons (`.where()`)

Chain multiple `.where(column, operator, value)` calls to combine conditions with `AND`. Supported comparison operators are `'='`, `'!='`, `'<'`, `'<='`, `'>'`, and `'>='`:

```typescript
const activeAdults = await db
  .from("users")
  .where("status", "=", "active")
  .where("age", ">=", 18)
  .toArray();
```

You can also pass a SQL expression string directly to `.where()`:

```typescript
const highValue = await db
  .from("orders")
  .where("price * quantity >= 500")
  .toArray();
```

### `OR` & `NOT` Conditions (`.orWhere()`, `.whereNot()`, `.orWhereNot()`)

```typescript
// WHERE role = 'admin' OR role = 'owner'
const admins = await db
  .from("users")
  .where("role", "=", "admin")
  .orWhere("role", "=", "owner")
  .toArray();

// WHERE status != 'banned'
const allowed = await db
  .from("users")
  .whereNot("status", "=", "banned")
  .toArray();
```

### Nested Parenthetical Groups (`where(qb => ...)`)

To group conditions with parentheses (e.g. `WHERE active = 1 AND (role = 'admin' OR score >= 90)`), pass a callback to `.where()` or `.orWhere()`:

```typescript
const results = await db
  .from("users")
  .where("active", "=", 1)
  .where((sub) => {
    sub.where("role", "=", "admin").orWhere("score", ">=", 90);
  })
  .toArray();
```

---

## 3. Set Membership & Null Checks

### `IN` and `NOT IN` (`.whereIn()`, `.whereNotIn()`, `.orWhereIn()`, `.orWhereNotIn()`)

Match a column against an array of values (up to 10,000 items) or a `QueryBuilder` subquery:

```typescript
const teamMembers = await db
  .from("users")
  .whereIn("department", ["Engineering", "Design", "Product"])
  .whereNotIn("status", ["suspended", "deleted"])
  .toArray();
```

> [!TIP]
> Passing an empty array `whereIn('id', [])` safely short-circuits at compile time and returns `[]` immediately without scanning the table.

### `NULL` Checks (`.whereNull()`, `.whereNotNull()`, `.orWhereNull()`, `.orWhereNotNull()`)

In SQL, `NULL` cannot be compared with `= null`. Always use `.whereNull()` and `.whereNotNull()`:

```typescript
const unpublishedPosts = await db
  .from("posts")
  .whereNull("published_at")
  .whereNotNull("author_id")
  .toArray();
```

---

## 4. Text Search & Pattern Matching

WebDB provides dedicated string matching methods for both SQL `LIKE` wildcards (`%` and `_`) and exact prefix/suffix/substring checks:

| Method                          | `OR` Variant           | Description                                | Example                               |
| :------------------------------ | :--------------------- | :----------------------------------------- | :------------------------------------ |
| `.whereLike(col, pattern)`      | `.orWhereLike()`       | SQL `LIKE` (`%` = any chars, `_` = 1 char) | `.whereLike('email', '%@gmail.com')`  |
| `.whereNotLike(col, pattern)`   | `.orWhereNotLike()`    | Negated SQL `NOT LIKE`                     | `.whereNotLike('name', 'Test%')`      |
| `.whereStartsWith(col, prefix)` | `.orWhereStartsWith()` | Fast prefix match                          | `.whereStartsWith('sku', 'PRO-')`     |
| `.whereEndsWith(col, suffix)`   | `.orWhereEndsWith()`   | Fast suffix match                          | `.whereEndsWith('file', '.pdf')`      |
| `.whereContains(col, substr)`   | `.orWhereContains()`   | Fast substring match                       | `.whereContains('bio', 'TypeScript')` |

```typescript
const searchResults = await db
  .from("products")
  .whereContains("title", "Wireless")
  .whereStartsWith("sku", "AUDIO-")
  .toArray();
```

---

## 5. Sorting Results (`.orderBy()`)

Sort query results by one or up to **8 columns**, with optional control over `NULL` placement (`'nulls_first'` or `'nulls_last'`):

```typescript
// 1. Single column sort
const topUsers = await db.from("users").orderBy("score", "desc").toArray();

// 2. Explicit NULL ordering
const tasksByDueDate = await db
  .from("tasks")
  .orderBy("due_at", "asc", "nulls_last")
  .toArray();

// 3. Multi-column sort by chaining .orderBy()
const sortedEmployees = await db
  .from("employees")
  .orderBy("department", "asc")
  .orderBy("salary", "desc")
  .toArray();
```

---

## 6. Pagination & Terminal Execution (`.limit()`, `.offset()`, `.toArray()`, `.first()`)

A `QueryBuilder` is lazy—it does not touch the database until you await a terminal method:

- **`.toArray()`:** Executes the query and resolves to an array of row objects (`Promise<DbRow[]>`).
- **`.first()`:** Automatically applies `.limit(1)` and resolves to the first matching row or `null` (`Promise<DbRow | null>`).

```typescript
// Fetch page 2 (rows 21..40)
const pageSize = 20;
const pageNumber = 2;

const pageRows = await db
  .from("articles")
  .where("published", "=", 1)
  .orderBy("created_at", "desc")
  .limit(pageSize)
  .offset((pageNumber - 1) * pageSize)
  .toArray();

// Fetch a single record (or null if not found)
const user = await db
  .from("users")
  .where("email", "=", "alice@example.com")
  .first();
```

---

## 7. Subqueries & Nested Queries (`FROM`, `WHERE`, `SELECT`)

WebDB supports nested `QueryBuilder` subqueries across `FROM`, `WHERE`, `HAVING`, and `SELECT` clauses (up to a maximum nesting depth of **7 levels**).

### A. Derived Tables in `FROM` (`db.from(subquery)`)

Pass a `QueryBuilder` instance directly to `db.from()` to query the output of another query:

```typescript
// 1. Simple derived table (automatically flattened into a single-pass table scan)
const activeSub = db
  .from("employees")
  .select(["id", "upper(name) as upper_name", "floor(salary / 1000) as sal_k"])
  .where("active", "=", 1);

const results = await db
  .from(activeSub)
  .select(["id", "upper_name", "sal_k * 2 as double_sal_k"])
  .where("sal_k", ">=", 80)
  .toArray();

// 2. Aggregated derived table (materialized before outer filtering/sorting)
const deptStats = db
  .from("employees")
  .groupBy("dept")
  .select(["dept", "count(*) as headcount", "avg(salary) as avg_sal"]);

const topDepts = await db
  .from(deptStats)
  .where("avg_sal", ">", 75000)
  .orderBy("avg_sal", "desc")
  .toArray();
```

### B. Subqueries in `WHERE` (`whereIn`, `whereExists`, Scalar Comparisons)

Use a subquery inside `.whereIn()`, `.whereNotIn()`, `.whereExists()`, `.whereNotExists()`, or standard comparison operators (`.where(col, op, subquery)`):

```typescript
import { col } from "webdb";

// 1. Set membership: WHERE id IN (SELECT emp_id FROM orders WHERE amount >= 1000)
const bigBuyers = db
  .from("orders")
  .where("amount", ">=", 1000)
  .select("emp_id");
const vipEmployees = await db
  .from("employees")
  .whereIn("id", bigBuyers)
  .toArray();

// 2. Uncorrelated scalar subquery: WHERE salary > (SELECT avg(salary) FROM employees)
const companyAvg = db.from("employees").select("avg(salary)");
const aboveCompanyAvg = await db
  .from("employees")
  .where("salary", ">", companyAvg)
  .toArray();

// 3. Correlated scalar subquery: earn more than their own department's average
const deptAvg = db
  .from("employees")
  .select("avg(salary)")
  .where("dept", "=", col("employees.dept"));

const topInDept = await db
  .from("employees")
  .where("salary", ">", deptAvg)
  .toArray();

// 4. Correlated EXISTS / NOT EXISTS
const hasCompletedOrder = db
  .from("orders")
  .where("orders.emp_id", "=", col("employees.id"))
  .where("status", "=", "completed");

const activeSellers = await db
  .from("employees")
  .whereExists(hasCompletedOrder)
  .toArray();
```

### C. Scalar Subqueries in `SELECT` (`subquery.as('alias')`)

Include uncorrelated or correlated scalar subqueries in `.select()` using `.as(alias)` or a key-value map `{ alias: subquery }`:

```typescript
import { col } from "webdb";

const orderCountSub = db
  .from("orders")
  .where("emp_id", "=", col("employees.id"))
  .select("count(*)")
  .as("order_count");

const maxOrderSub = db
  .from("orders")
  .where("emp_id", "=", col("employees.id"))
  .select("max(amount)");

const rows = await db
  .from("employees")
  .select("id", "name", orderCountSub, {
    biggest_order: maxOrderSub,
  })
  .toArray();
```
