# Database Migrations

In a local-first web application, each user's browser stores its own persistent copy of the database in IndexedDB or OPFS. While one user might open your app every day (upgrading incrementally from `v1` ➔ `v2` ➔ `v3`), another user might return after three months and jump directly from `v1` ➔ `v8`.

WebDB makes browser-side schema and data migrations safe and deterministic because **DDL operations (`createTable`, `addColumn`, `renameColumn`, `dropColumn`, `createIndex`) and DML operations (`insert`, `update`, `delete`) can run together inside a single ACID `db.transaction()`**. If any step in a migration fails, WebDB rolls back the entire transaction—including allocated catalog pages and B+Tree indexes—leaving the user's database untouched.

---

## 1. Designing a Versioned Migration Runner

A clean, zero-dependency pattern is to store applied migrations in a dedicated `_migrations` table and run pending migrations sequentially inside `db.transaction()` during app initialization:

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

export interface Migration {
  version: number;
  name: string;
  up: (tx: WebDB) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_create_catalog_tables",
    async up(tx) {
      await tx.createTable("categories", [
        { name: "id", type: "UUID", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      await tx.createTable("items", [
        { name: "id", type: "UUID", primaryKey: true },
        { name: "category_id", type: "UUID", notNull: true },
        { name: "sku", type: "TEXT", notNull: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "price_cents", type: "INT32", notNull: true },
      ]);

      await tx.createIndex("items", ["category_id"], {
        name: "idx_items_category_id",
      });
      await tx.createIndex("items", ["sku"], {
        name: "idx_items_sku",
        unique: true,
      });
    },
  },
  {
    version: 2,
    name: "002_add_item_barcode_and_active_flag",
    async up(tx) {
      await tx.addColumn("items", { name: "barcode", type: "TEXT" });
      await tx.addColumn(
        "items",
        { name: "is_active", type: "INT32", notNull: true },
        1, // Default value populated for all existing rows
      );

      await tx.createIndex("items", ["barcode"], {
        name: "idx_items_barcode",
      });
    },
  },
  {
    version: 3,
    name: "003_create_orders_and_payments",
    async up(tx) {
      await tx.createTable("orders", [
        { name: "id", type: "UUID", primaryKey: true },
        { name: "status", type: "TEXT", notNull: true },
        { name: "total_cents", type: "INT32", notNull: true },
        { name: "created_at", type: "INT64", notNull: true },
      ]);

      await tx.createIndex("orders", ["status", "created_at"], {
        name: "idx_orders_status_created",
      });
    },
  },
];
```

### Running Pending Migrations on Startup

```typescript
export async function runMigrations(
  db: WebDB,
  migrations: Migration[] = MIGRATIONS,
): Promise<void> {
  // 1. Ensure the _migrations tracking table exists idempotently
  await db.createTableIfNotExists("_migrations", [
    { name: "version", type: "INT32", primaryKey: true },
    { name: "name", type: "TEXT", notNull: true },
    { name: "applied_at", type: "INT64", notNull: true },
  ]);

  // 2. Read already-applied versions
  const appliedRows = await db
    .from("_migrations")
    .select("version")
    .orderBy("version", "asc")
    .toArray();
  const appliedVersions = new Set(appliedRows.map((r) => Number(r.version)));

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const pending = sorted.filter((m) => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    return;
  }

  // 3. Execute each pending migration atomically inside its own transaction
  //    (or wrap the entire loop in a single db.transaction for all-or-nothing upgrades)
  for (const migration of pending) {
    await db.transaction(async (tx) => {
      await migration.up(tx);
      await tx.insert("_migrations", {
        version: migration.version,
        name: migration.name,
        applied_at: Date.now(),
      });
    });
  }
}
```

---

## 2. Built-in Idempotent DDL & Schema Inspection

WebDB provides first-class idempotent DDL methods and schema inspection APIs directly on `db` (and inside transactions via `tx`), removing the need for custom userland wrapper helpers:

```typescript
// --- Idempotent Tables ---
// Creates table if missing; returns existing TableMeta without error if it already exists
await tx.createTableIfNotExists("users", [
  { name: "id", type: "UUID", primaryKey: true },
  { name: "email", type: "TEXT", notNull: true },
]);

// Drops table if present; returns false without throwing if table doesn't exist
const dropped = await tx.dropTableIfExists("deprecated_table");

// --- Idempotent Columns ---
// Safely adds column if missing; no-op if column already exists
await tx.addColumnIfNotExists(
  "users",
  { name: "is_active", type: "INT32", notNull: true },
  1, // defaultValue applied to all existing rows
);

// Safely drops column if present; no-op if already dropped
await tx.dropColumnIfExists("users", "legacy_status");

// --- Idempotent Indexes ---
// Safely creates index if missing; no-op if index with same name or columns exists
await tx.createIndexIfNotExists("users", ["email"], {
  name: "idx_users_email",
  unique: true,
});

// Safely drops index; returns false without throwing if index is not found
await tx.dropIndexIfExists("idx_users_old_index");
```

### Inspecting Schemas Before Running DDL

You can also inspect database schema and table metadata directly:

```typescript
// Fast table & column checks on db / tx:
if (!(await tx.hasTable("orders"))) {
  // table does not exist
}

if (!(await tx.hasColumn("users", "phone"))) {
  await tx.addColumn("users", { name: "phone", type: "TEXT" });
}

if (!(await tx.hasIndex("users", "idx_users_phone"))) {
  await tx.createIndex("users", "phone", { name: "idx_users_phone" });
}

// Inspect table metadata and columns:
const meta = await tx.getTable("users");
if (meta.hasColumn("phone")) {
  const col = meta.getColumn("phone");
  console.log(`Column ${col?.name} has type ${col?.type}`);
}

if (meta.hasIndex("idx_users_phone") || meta.hasIndex(["phone"])) {
  console.log("Index is active on users(phone)");
}
```

---

## 3. Data Backfills & Column Transformations

Sometimes a schema migration requires computing values from existing columns (for example, splitting a `full_name` column or computing `normalized_email` before adding a unique index).

Because `tx` inside `db.transaction()` supports both DDL and DML, you can add a nullable column, backfill rows, and then index the column atomically:

```typescript
const backfillCustomerEmailsMigration: Migration = {
  version: 4,
  name: "004_backfill_normalized_customer_email",
  async up(tx) {
    // 1. Add the new column
    await tx.addColumn("customers", {
      name: "email_normalized",
      type: "TEXT",
    });

    // 2. Read existing rows and backfill computed values inside the same transaction
    const customers = await tx
      .from("customers")
      .select("id", "email")
      .toArray();

    for (const c of customers) {
      const normalized = String(c.email ?? "")
        .trim()
        .toLowerCase();
      await tx.update("customers", c.id as string, {
        email_normalized: normalized,
      });
    }

    // 3. Build a unique B+Tree index on the newly populated column
    await tx.createIndex("customers", ["email_normalized"], {
      name: "idx_customers_email_norm",
      unique: true,
    });
  },
};
```

> [!TIP]
> **Automatic Index Backfill:** Whenever you call `tx.createIndex(tableName, columns)` on a table that already contains rows, WebDB automatically scans all existing rows and populates the new B+Tree index—and verifies uniqueness if `unique: true` is set.

---

## 4. Multi-Tab Safety During Migrations

Users frequently open multiple browser tabs of the same web application simultaneously. WebDB handles concurrent startup migrations automatically:

1. **Cross-Tab Write Serialization (`navigator.locks`):** Only one tab can execute a write `db.transaction()` at a time. If Tab A and Tab B both boot simultaneously, Tab A acquires the exclusive transaction lock, runs the pending migrations, and updates `_migrations`.
2. **Automatic Catalog Reload (`BroadcastChannel`):** When Tab A commits the migration transaction, WebDB increments the database's schema epoch and broadcasts a commit notification. Before Tab B executes its next query or transaction, it automatically reloads Page 1, pins any newly allocated catalog or overflow pages, and sees that `_migrations` is already up to date.

> [!IMPORTANT]
> **Re-check `_migrations` Inside the Transaction When Multi-Tab Races Are Possible:**
> If two tabs boot at the exact same millisecond, checking `_migrations` *inside* `db.transaction()` guarantees the second tab sees the version committed by the first tab:
>
> ```typescript
> await db.transaction(async (tx) => {
>   const applied = await tx.from("_migrations").select("version").toArray();
>   const appliedSet = new Set(applied.map((r) => Number(r.version)));
>
>   for (const m of MIGRATIONS) {
>     if (!appliedSet.has(m.version)) {
>       await m.up(tx);
>       await tx.insert("_migrations", {
>         version: m.version,
>         name: m.name,
>         applied_at: Date.now(),
>       });
>     }
>   }
> });
> ```

---

## Related Guides

- **[ALTER TABLE (`rename`, `addColumn`, `dropColumn`)](./migrations-and-alter-table.md):** Detailed reference for individual table and column modification APIs.
- **[Transactions & Savepoints](./transactions.md):** Learn how nested `tx.transaction()` savepoints and WAL crash recovery work.

