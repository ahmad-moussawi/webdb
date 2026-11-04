# Getting Started with WebDB

**WebDB** is an ultra-lightweight (`< 100 KB` bundle, `~13 KB` Wasm core), browser-native relational database engine. It gives you relational tables, secondary indexes, joins, aggregations, ACID transactions, and real-time multi-tab reactivity—without multi-megabyte Wasm bundles or complex server headers (`COOP`/`COEP`).

---

## When Should You Use WebDB?

WebDB is built for client-side and local-first web applications that outgrow `localStorage` or raw `IndexedDB` cursors:

- **Offline-First & Local-First Apps:** Persist user data locally in **IndexedDB** or **OPFS**, mutate records offline inside ACID transactions, and sync changes in the background when online.
- **Complex Client-Side Filtering, Sorting & Joins:** Replace slow in-memory array loops or awkward IndexedDB cursor code with a fluent, indexed query builder.
- **Multi-Tab Web Applications:** Coordinate reads, writes, and live UI updates across multiple open browser tabs and Web Workers automatically.
- **Instant Cold-Start Caching:** Hydrate a full relational database from a binary snapshot (`Uint8Array`) in milliseconds without parsing large JSON payloads.

---

## 1. Installation

Install `@ahmadmoussawi/webdb` using your preferred package manager:

```bash
# npm
npm install @ahmadmoussawi/webdb@alpha

# pnpm
pnpm add @ahmadmoussawi/webdb@alpha

# yarn
yarn add @ahmadmoussawi/webdb@alpha
```

> [!TIP]
> **Zero Server Configuration Required:** Unlike desktop database ports that rely on `SharedArrayBuffer` and `pthread` shims, WebDB works on any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3) without `Cross-Origin-Opener-Policy` (`COOP`) or `Cross-Origin-Embedder-Policy` (`COEP`) headers.

---

## 2. Quickstart Walkthrough

Here is a complete, runnable example showing how to open a database, define a schema, insert data, run queries, and use transactions:

```typescript
import { WebDB } from '@ahmadmoussawi/webdb';

async function main() {
  // 1. Open a persistent database (uses IndexedDB in the browser, or memory in Node/tests)
  const db = await WebDB.open({
    name: 'my_task_app',
    storage: typeof indexedDB !== 'undefined' ? 'idb' : 'memory',
  });

  // 2. Create a table with typed columns
  await db.createTable('tasks', [
    { name: 'id', type: 'UUID', primaryKey: true },
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'priority', type: 'INT32' },
    { name: 'done', type: 'INT32' }, // 0 = false, 1 = true
  ]);

  // Create an index to speed up filtering and sorting by priority
  await db.createIndex('tasks', 'priority');

  // 3. Insert single or multiple rows
  await db.insert('tasks', {
    id: crypto.randomUUID(),
    title: 'Design database schema',
    priority: 1,
    done: 1,
  });

  await db.insertMany('tasks', [
    { id: crypto.randomUUID(), title: 'Write API documentation', priority: 3, done: 0 },
    { id: crypto.randomUUID(), title: 'Add offline sync worker', priority: 2, done: 0 },
  ]);

  // 4. Query records using the fluent Query Builder
  const pendingHighPriority = await db
    .from('tasks')
    .select('id', 'title', 'priority')
    .where('done', '=', 0)
    .where('priority', '>=', 2)
    .orderBy('priority', 'desc')
    .limit(10)
    .toArray();

  console.table(pendingHighPriority);

  // 5. Update and delete records
  await db
    .from('tasks')
    .where('title', '=', 'Write API documentation')
    .update({ done: 1 });

  // 6. Wrap multi-step operations in an ACID transaction
  await db.transaction(async (tx) => {
    await tx.insert('tasks', {
      id: crypto.randomUUID(),
      title: 'Ship release v1.0',
      priority: 3,
      done: 0,
    });
    await tx.delete('tasks', { done: 1 });
  });

  // 7. Close the database connection when finished
  await db.close();
}

main();
```

---

## 3. Try WebDB Live in Your Browser

Want to experiment with queries and inspect how WebDB stores data before writing any code?

- [**Launch Studio IDE Playground →**](/playground/) — Interactive in-browser IDE with live table explorer, query editor, and query plan inspector.
- [**Run In-Browser Benchmarks →**](/benchmark/) — Compare WebDB throughput and latency against Raw JS Arrays, Native IndexedDB, and SQLite WASM on your own hardware.

---

## 4. Next Steps

Follow the guides below to explore WebDB's capabilities:

- [**Storage Backends & Configuration**](/guides/storage-and-configuration) — Choose between IndexedDB (`idb`), Origin Private File System (`opfs`), and In-Memory (`memory`) storage.
- [**Tables, Columns & Data Types**](/guides/schema-and-types) — Learn about supported column types (`UUID`, `ULID`, `INT32`, `INT64`, `FLOAT64`, `TEXT`, `BLOB`), auto-incrementing keys, and constraints.
- [**Inserting, Updating & Deleting Data**](/guides/mutations) — Perform single and bulk inserts, updates, deletes, and conflict-aware `upsert` operations.
- [**Querying Data**](/guides/querying) — Filter, search text, sort, and paginate your data with the fluent Query Builder.
- [**Reactive Live Queries (React, Vue, Angular & Plain JS)**](/guides/live-queries-and-frameworks) — Bind queries directly to your UI with automatic table dependency tracking and zero bundle bloat.
- [**Transactions, Reactivity & Offline Sync**](/offline-sync) — Subscribe to live cross-tab changes and synchronize local data with a remote backend.
