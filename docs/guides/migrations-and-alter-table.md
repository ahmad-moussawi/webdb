# Schema Evolution & Migrations (`ALTER TABLE`)

As your application evolves, you often need to rename tables, rename columns, add new fields, or drop deprecated columns on existing user databases in the browser.

WebDB provides dedicated schema mutation methods as well as a unified [`db.alterTable()`](./src/host/api/webdb.ts#L991-L1005) API.

---

## 1. Renaming a Table (`db.renameTable`)

Renames an existing table instantaneously without rewriting any data or index pages. Any auto-named indexes on the table (such as `pk_<old>` or `idx_<old>_<col>`) are automatically updated to match the new table name.

```typescript
// Dedicated method
await db.renameTable("users", "accounts");

// Or via alterTable:
await db.alterTable("accounts", {
  type: "renameTable",
  newName: "members",
});
```

---

## 2. Renaming a Column (`db.renameColumn`)

Renames a column in place while preserving all existing data and secondary B+Tree indexes referencing that column:

```typescript
// Dedicated method
await db.renameColumn("users", "name", "full_name");

// Or via alterTable:
await db.alterTable("users", {
  type: "renameColumn",
  from: "full_name",
  to: "display_name",
});
```

---

## 3. Adding a Column (`db.addColumn`)

Adds a new column to an existing table and populates all existing rows with `defaultValue` (or `null` if omitted).

```typescript
// Add a nullable column (existing rows receive null)
await db.addColumn("users", {
  name: "bio",
  type: "TEXT",
});

// Add a NOT NULL column with a default value for existing rows
await db.addColumn(
  "users",
  { name: "role", type: "TEXT", notNull: true },
  "member", // defaultValue applied to all existing rows
);

// Or via alterTable:
await db.alterTable("users", {
  type: "addColumn",
  column: { name: "points", type: "INT32", notNull: true },
  defaultValue: 0,
});
```

> [!IMPORTANT]
>
> - If you add a column with `notNull: true` to a table that already contains rows, you **must** provide a non-null `defaultValue`, otherwise WebDB throws `NotNullConstraintError`.
> - Adding a second `primaryKey: true` column to a table that already has a primary key is not allowed.

---

## 4. Dropping a Column (`db.dropColumn`)

Removes a column from an existing table and reclaims the space from every row. Any secondary index referencing the dropped column is automatically dropped as well, while all other indexes on the table are preserved.

```typescript
// Dedicated method
await db.dropColumn("users", "bio");

// Or via alterTable:
await db.alterTable("users", {
  type: "dropColumn",
  column: "points",
});
```

> [!WARNING]
> **Guardrails on `dropColumn`:**
>
> - You cannot drop a table's `PRIMARY KEY` column (throws `CannotDropColumnError`).
> - You cannot drop the last remaining column of a table (throws `CannotDropColumnError`).

---

## 5. Running Versioned App Migrations

When shipping updates to a local-first web app, a clean pattern is to store a schema version in a `_meta` table and run migrations inside a single `db.transaction()` on startup. If any step fails, the entire migration rolls back safely:

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

const MIGRATIONS: Array<(tx: WebDB) => Promise<void>> = [
  // Version 1: Initial schema
  async (tx) => {
    await tx.createTable("todos", [
      { name: "id", type: "UUID", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "done", type: "INT32", notNull: true },
    ]);
  },

  // Version 2: Add priority column and index it
  async (tx) => {
    await tx.addColumn(
      "todos",
      { name: "priority", type: "INT32", notNull: true },
      1,
    );
    await tx.createIndex("todos", "priority");
  },

  // Version 3: Rename 'title' to 'task_name'
  async (tx) => {
    await tx.renameColumn("todos", "title", "task_name");
  },
];

export async function openAndMigrateDatabase(): Promise<WebDB> {
  const db = await WebDB.open({ name: "todo_app", storage: "idb" });

  const tables = await db.listTables();
  if (!tables.some((t) => t.name === "_migrations")) {
    await db.createTable("_migrations", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "version", type: "INT32", notNull: true },
    ]);
    await db.insert("_migrations", { id: 1, version: 0 });
  }

  const state = await db.from("_migrations").where("id", "=", 1).first();
  const currentVersion = (state?.version as number) ?? 0;

  if (currentVersion < MIGRATIONS.length) {
    await db.transaction(async (tx) => {
      for (let v = currentVersion; v < MIGRATIONS.length; v++) {
        await MIGRATIONS[v](tx);
      }
      await tx.update("_migrations", 1, { version: MIGRATIONS.length });
    });
  }

  return db;
}
```
