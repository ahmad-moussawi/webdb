# Schema Evolution (`ALTER TABLE`)

As your application evolves, you often need to rename tables, rename columns, add new fields, or drop deprecated columns on existing user databases in the browser.

WebDB provides dedicated schema mutation methods as well as a unified [`db.alterTable()`](./src/host/api/webdb.ts#L991-L1005) API.

> [!TIP]
> Looking for how to organize and run versioned startup migrations across application releases? See the dedicated **[Database Migrations](./migrations.md)** guide.

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

// Idempotent variant (skips without error if column already exists):
await db.addColumnIfNotExists(
  "users",
  { name: "points", type: "INT32", notNull: true },
  0,
);

// Or via alterTable with addColumnIfNotExists:
await db.alterTable("users", {
  type: "addColumnIfNotExists",
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

// Idempotent variant (skips without error if column does not exist):
await db.dropColumnIfExists("users", "points");

// Or via alterTable with dropColumnIfExists:
await db.alterTable("users", {
  type: "dropColumnIfExists",
  column: "points",
});
```

> [!WARNING]
> **Guardrails on `dropColumn`:**
>
> - You cannot drop a table's `PRIMARY KEY` column (throws `CannotDropColumnError`).
> - You cannot drop the last remaining column of a table (throws `CannotDropColumnError`).

---

## Next Step: Versioned Database Migrations

To run sequential schema upgrades, data backfills, and idempotent DDL helpers safely inside ACID transactions on startup, continue to **[Database Migrations](./migrations.md)**.
