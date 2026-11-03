# Inserting, Updating & Deleting Data

WebDB provides clean, ergonomic methods for inserting single or bulk records, updating rows, deleting rows, and performing conflict-aware upserts (`INSERT ... ON CONFLICT`).

---

## 1. Inserting Rows (`insert` & `insertMany`)

### Single Row Insert (`db.insert`)

Inserts a single record into a table. Any column omitted from the object defaults to `null` (or the next sequence number if the column has `autoInc: true`).

```typescript
await db.insert('users', {
  id: crypto.randomUUID(),
  name: 'Alice Chen',
  age: 29,
  role: 'admin',
});
```

### Bulk Insert (`db.insertMany`)

When inserting multiple records (such as seeding data or importing a batch from an API), **always prefer `db.insertMany()`** over calling `db.insert()` in a loop. `insertMany()` batches all row writes and index updates inside a single transaction pass.

```typescript
await db.insertMany('users', [
  { id: crypto.randomUUID(), name: 'Bob Smith', age: 24, role: 'member' },
  { id: crypto.randomUUID(), name: 'Charlie Kim', age: 35, role: 'editor' },
  { id: crypto.randomUUID(), name: 'Diana Prince', age: 31, role: 'admin' },
]);
```

---

## 2. Updating Rows (`update`)

WebDB supports three ways to update rows, and all three return the **number of rows updated** (`Promise<number>`):

### A. Update by Primary Key

Pass the primary key value as the second argument and the partial column changes as the third argument:

```typescript
const updatedCount = await db.update('users', userId, {
  role: 'superadmin',
  age: 30,
});
```

### B. Update by Filter Object

Pass an equality filter object as the second argument to update all matching rows:

```typescript
// Set role = 'member' for all rows where role === 'guest' AND age >= 18
const count = await db.update(
  'users',
  { role: 'guest' },
  { role: 'member' },
);
```

### C. Fluent `QueryBuilder.update()`

For range conditions, `IN` lists, `OR` clauses, or text matching, chain `.update(patch)` onto any `db.from(table).where(...)` query:

```typescript
const markedOverdue = await db
  .from('tasks')
  .where('done', '=', 0)
  .where('due_at', '<', BigInt(Date.now()))
  .update({ status: 'overdue' });
```

---

## 3. Deleting Rows (`delete`)

Like `update`, you can delete rows in three ways, returning the **number of rows deleted** (`Promise<number>`):

### A. Delete by Primary Key

```typescript
await db.delete('users', userId);
```

### B. Delete by Filter Object

```typescript
// Delete all completed tasks in project 10
await db.delete('tasks', { project_id: 10, done: 1 });
```

### C. Fluent `QueryBuilder.delete()`

```typescript
const purgedCount = await db
  .from('logs')
  .whereIn('level', ['debug', 'trace'])
  .where('created_at', '<', BigInt(Date.now() - 7 * 86_400_000))
  .delete();
```

---

## 4. Upserting Rows (`upsert` & `upsertMany`)

When syncing data from a server, handling webhooks, or saving user settings, you often want to **insert a row if it doesn't exist, or update it if it does**.

- `db.upsert(tableName, row, options?)` returns `'inserted' | 'updated' | 'ignored'`.
- `db.upsertMany(tableName, rows, options?)` processes an entire array in one atomic transaction and returns `{ inserted: number, updated: number, ignored: number }`.

### Basic Upsert (Merge by Primary Key)

By default, `upsert` checks the table's primary key (`conflictTarget`) and merges the provided fields (`mode: 'merge'`):

```typescript
const outcome = await db.upsert('settings', {
  key: 'theme',
  value: 'dark',
});
// outcome: 'inserted' (first call) or 'updated' (subsequent calls)
```

### Conflict Resolution Modes (`mode`)

You can customize how conflicts are handled via `UpsertOptions`:

| Mode | Behavior when a matching row already exists |
| :--- | :--- |
| **`'merge'`** *(Default)* | Updates only the columns present in the incoming object; preserves existing values for omitted columns. |
| **`'replace'`** | Overwrites the entire row, setting any omitted non-primary-key columns to `null`. |
| **`'ignore'`** | Leaves the existing row untouched and counts the operation as `'ignored'`. |

```typescript
// Insert if missing, but do nothing if the email already exists (INSERT OR IGNORE)
await db.upsert(
  'users',
  { id: crypto.randomUUID(), email: 'alice@example.com', name: 'Alice' },
  {
    conflictTarget: 'email', // Can be primary key or any indexed/unique column(s)
    mode: 'ignore',
  },
);
```

### Conditional Upserts (Last-Write-Wins Predicate)

Pass a `where: (existingRow, incomingRow) => boolean` function to decide dynamically whether an incoming row should overwrite the existing row. If `where` returns `false`, the update is skipped (`'ignored'`).

```typescript
// Only apply incoming server records if their timestamp is newer than local data
const stats = await db.upsertMany('notes', incomingServerNotes, {
  conflictTarget: 'id',
  mode: 'merge',
  where: (existing, incoming) =>
    (incoming.updated_at as bigint) > (existing.updated_at as bigint),
});

console.log(stats);
// { inserted: 15, updated: 4, ignored: 2 }
```

