# Tables, Columns & Data Types

WebDB is a schema-enforced relational database. Before inserting records, you define your tables and column types using [`db.createTable()`](./src/host/api/webdb.ts#L402-L410). Schemas are persisted inside the database file itself, so your tables automatically reload when reopening a persistent database.

---

## 1. Creating a Table (`db.createTable`)

Pass the table name and an array of column definitions to `db.createTable()`:

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({ name: "shop_db", storage: "idb" });

await db.createTable("users", [
  { name: "id", type: "UUID", primaryKey: true },
  { name: "email", type: "TEXT", notNull: true, indexed: true },
  { name: "age", type: "INT32" },
  { name: "balance", type: "FLOAT64" },
  { name: "created_at", type: "INT64", notNull: true },
]);
```

> [!NOTE]
> **Top-Level vs. `flags` Shorthand:** You can specify column constraints directly on the column object (`{ name: 'id', type: 'INT32', primaryKey: true, autoInc: true }`) or nested inside a `flags` property (`{ name: 'id', type: 'INT32', flags: { primaryKey: true, autoInc: true } }`). Both syntaxes are supported identically.

---

## 2. Supported Data Types

WebDB supports 7 native binary column types. You can specify the type as a string (`'INT32'`, `'TEXT'`, etc.) or using the `DataType` enum (`DataType.INT32`, `DataType.TEXT`, etc.).

| Column Type     | JS Type                          | Binary Size      | Description & Best Use Cases                                                                                                                                                                               |
| :-------------- | :------------------------------- | :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`'INT32'`**   | `number`                         | 4 bytes          | 32-bit signed integer (`-2,147,483,648` to `2,147,483,647`). Ideal for counts, statuses, ages, and boolean flags (`0` / `1`).                                                                              |
| **`'INT64'`**   | `bigint` (or `number` on insert) | 8 bytes          | 64-bit signed integer. Ideal for millisecond timestamps (`BigInt(Date.now())`), large counters, and financial cents. Returned as `bigint` in query results.                                                |
| **`'FLOAT64'`** | `number`                         | 8 bytes          | 64-bit IEEE 754 floating-point number. Ideal for prices, scores, coordinates, and scientific measurements.                                                                                                 |
| **`'TEXT'`**    | `string`                         | 2B + UTF-8 bytes | Variable-length UTF-8 text string. Ideal for names, emails, descriptions, ISO dates, or serialized JSON.                                                                                                   |
| **`'BLOB'`**    | `Uint8Array`                     | 2B + raw bytes   | Raw binary byte array. Ideal for encrypted payloads, hashes, small thumbnails, or binary tokens.                                                                                                           |
| **`'UUID'`**    | `string`                         | 16 bytes         | Standard 36-char UUID string (e.g. `crypto.randomUUID()`). Automatically packed into 16 raw bytes on disk (saving 55% space over `TEXT`) and formatted back to a hyphenated lowercase string when queried. |
| **`'ULID'`**    | `string`                         | 16 bytes         | 26-char lexicographically sortable Crockford Base32 ULID string (e.g. `'01ARZ3NDEKTSV4RRFFQ69G5FAV'`). Packed into 16 raw bytes on disk while preserving chronological sort order.                         |

### How to Store Common Application Types

Because WebDB keeps its core engine compact, it maps common application types cleanly onto the 7 native types above:

| Application Type        | Recommended Column Type  | Example Value                                                                   |
| :---------------------- | :----------------------- | :------------------------------------------------------------------------------ |
| **Boolean**             | `'INT32'`                | Store `1` for `true` and `0` for `false`                                        |
| **Timestamp / Date**    | `'INT64'` or `'TEXT'`    | `BigInt(Date.now())` (`INT64`) or `new Date().toISOString()` (`TEXT`)           |
| **Currency / Money**    | `'INT64'` or `'FLOAT64'` | Store integer cents (`1999n` for `$19.99`) in `'INT64'` to avoid float rounding |
| **JSON Object / Array** | `'TEXT'`                 | `JSON.stringify(data)` on insert, `JSON.parse(row.data)` on read                |

---

## 3. Column Constraints & Flags

Each column definition in `createTable()` accepts the following boolean flags:

| Flag                                             | Description                                                                                                                                                                                           |
| :----------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`primaryKey: true`**                           | Marks the column as the table's Primary Key. Enforces `NOT NULL` and uniqueness (`UniqueConstraintViolationError` on duplicate), and automatically creates a B+Tree primary key index (`pk_<table>`). |
| **`notNull: true`**                              | Rejects `null` or `undefined` values on insert and update, throwing `NotNullConstraintError`.                                                                                                         |
| **`autoInc: true`** _(or `autoIncrement: true`)_ | Automatically generates a monotonically increasing integer (`1, 2, 3, ...`) when the column is omitted or `null` during `insert()`. Supported on `INT32` and `INT64` primary keys.                    |
| **`indexed: true`**                              | Marks the column as indexed in the column metadata. _(Tip: Call `await db.createIndex(table, col)` to build a secondary B+Tree index for fast lookups and range scans)._                              |

### Example: Auto-Incrementing Primary Key

```typescript
await db.createTable("logs", [
  { name: "id", type: "INT32", primaryKey: true, autoInc: true },
  { name: "level", type: "TEXT", notNull: true },
  { name: "message", type: "TEXT", notNull: true },
]);

// Omit `id` — WebDB assigns 1, 2, 3 automatically
await db.insert("logs", { level: "info", message: "Server started" });
await db.insert("logs", { level: "warn", message: "High memory usage" });

const rows = await db.from("logs").toArray();
// [{ id: 1, level: 'info', ... }, { id: 2, level: 'warn', ... }]
```

---

## 4. Inspecting & Dropping Tables

### Get Metadata for a Single Table (`db.getTable`)

Returns the [`TableMeta`](./src/types/index.ts#L203-L216) descriptor including column definitions, primary key, row count estimate, and attached indexes. Throws `TableNotFoundError` if the table does not exist.

```typescript
const meta = await db.getTable("users");
console.log(meta.name); // 'users'
console.log(meta.columns); // [{ name: 'id', type: 6, ... }, ...]
console.log(meta.rowCountEstimate); // 42
```

### List All Tables (`db.listTables`)

Returns an array of `TableMeta` objects for all tables currently in the database. This is also a convenient way to check if a table already exists when initializing your app:

```typescript
const tables = await db.listTables();
const existingNames = new Set(tables.map((t) => t.name));

if (!existingNames.has("users")) {
  await db.createTable("users", [
    { name: "id", type: "UUID", primaryKey: true },
    { name: "name", type: "TEXT", notNull: true },
  ]);
}
```

### Drop a Table (`db.dropTable`)

Deletes the table, frees all of its data pages, and removes all associated indexes:

```typescript
await db.dropTable("logs");
```
