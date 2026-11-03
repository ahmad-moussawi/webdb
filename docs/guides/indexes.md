# Indexes & Unique Constraints

Without an index, WebDB must scan every row in a table (`TableScan`) to find matching records or sort results. Creating B+Tree secondary indexes with [`db.createIndex()`](./src/host/api/webdb.ts#L1152-L1163) turns slow linear scans into fast logarithmic (`IndexScan`) lookups and allows WebDB to stream pre-sorted results without sorting in memory.

---

## 1. Creating an Index (`db.createIndex`)

### Single-Column Index

Pass the table name and column name to `db.createIndex()`. If the table already has rows, WebDB automatically backfills the index for all existing records:

```typescript
// Creates index named "idx_users_age"
await db.createIndex("users", "age");

// Or specify a custom index name:
await db.createIndex("users", "age", { name: "users_age_idx" });
```

### Unique Index (`{ unique: true }`)

To enforce that no two rows have the same value (for example, an `email` or `username` column), pass `{ unique: true }`:

```typescript
await db.createIndex("users", "email", {
  unique: true,
  name: "uq_users_email",
});
```

If an `insert()`, `update()`, or `createIndex()` encounters a duplicate non-null value on a unique index, WebDB throws `UniqueConstraintViolationError`. (Just like standard SQL, multiple `NULL` values are permitted in a unique index unless the column is also marked `notNull: true`).

---

## 2. Composite (Multi-Column) Indexes

You can index up to **8 columns** together in a single composite index by passing an array of column names:

```typescript
await db.createIndex("orders", ["customer_id", "status", "created_at"], {
  name: "idx_orders_cust_status_date",
});
```

### How Composite Index Prefixes Work

A composite index on `['customer_id', 'status', 'created_at']` speeds up queries that filter by a **left-most prefix** of the indexed columns:

- **Uses the index:**
  - `.where('customer_id', '=', 42)`
  - `.where('customer_id', '=', 42).where('status', '=', 'paid')`
  - `.where('customer_id', '=', 42).where('status', '=', 'paid').orderBy('created_at', 'asc')`
- **Does NOT use the index** (because the leading column `customer_id` is omitted):
  - `.where('status', '=', 'paid')`

---

## 3. Listing & Dropping Indexes

### List Indexes (`db.listIndexes`)

Inspect all indexes in the database or filter by a specific table name:

```typescript
// All indexes in the database
const allIndexes = await db.listIndexes();

// Only indexes on the 'orders' table
const orderIndexes = await db.listIndexes("orders");
console.table(orderIndexes);
```

### Drop an Index (`db.dropIndex`)

Remove a secondary index and free its pages when it is no longer needed:

```typescript
await db.dropIndex("idx_orders_cust_status_date");
```

> [!NOTE]
> Primary key indexes (`pk_<table>`) are created automatically when a table defines a `primaryKey: true` column and cannot be dropped independently of the table.

---

## 4. Which Columns Should You Index?

1. **Primary Keys (Automatic):** Marking a column `primaryKey: true` in `createTable()` automatically creates a unique B+Tree index (`pk_<table>`). You do not need to call `createIndex` on primary key columns.
2. **Foreign Keys Used in `.join()`:** When joining two tables (e.g. `db.from('users').join('orders', 'users.id', '=', 'orders.user_id')`), always index `orders.user_id` so WebDB can seek directly to matching orders instead of scanning the entire `orders` table for every user.
3. **High-Selectivity `WHERE` Columns:** Columns frequently filtered with `=`, `>`, `>=`, `<`, `<=`, or `whereIn` (such as `status`, `category`, `tenant_id`, or `email`).
4. **`ORDER BY ... LIMIT` Columns:** If you frequently query the top $K$ rows in ascending order (e.g. `.orderBy('created_at', 'asc').limit(20)`), an index on `created_at` lets WebDB read just the first 20 entries and stop immediately without sorting the table.
