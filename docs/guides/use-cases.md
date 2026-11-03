# Common Use Cases & Recipes

This page provides complete, copy-pasteable patterns for integrating WebDB into modern frontend frameworks and real-world architectures.

---

## Recipe 1: Reactive React Hook (`useWebDBQuery`)

Combine [`db.subscribe()`](./src/host/api/webdb.ts#L1733-L1752) with React's `useEffect` and `useState` so your UI components automatically re-render whenever a watched table is mutated—whether in the current component, a background sync loop, or another open browser tab.

```tsx
import { useEffect, useState } from "react";
import type { WebDB, DbRow } from "@ahmadmoussawi/webdb";

export function useWebDBQuery<T = DbRow>(
  db: WebDB | null,
  watchedTables: string[] | "*",
  queryFn: (db: WebDB) => Promise<T[]>,
  deps: any[] = [],
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!db) return;
    let cancelled = false;

    const runQuery = async () => {
      try {
        const rows = await queryFn(db);
        if (!cancelled) {
          setData(rows);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    };

    // Initial fetch
    void runQuery();

    // Re-fetch automatically when watched tables change (locally or across tabs)
    const unsubscribe = db.subscribe(watchedTables, () => {
      void runQuery();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [db, ...deps]);

  return { data, loading, error };
}
```

### Usage in a Component

```tsx
function TodoList({ db, filterStatus }: { db: WebDB; filterStatus: number }) {
  const { data: todos, loading } = useWebDBQuery(
    db,
    ["todos"],
    (db) =>
      db
        .from("todos")
        .where("done", "=", filterStatus)
        .orderBy("priority", "desc")
        .toArray(),
    [filterStatus],
  );

  if (loading) return <p>Loading...</p>;

  return (
    <ul>
      {todos.map((t) => (
        <li key={String(t.id)}>{String(t.title)}</li>
      ))}
    </ul>
  );
}
```

---

## Recipe 2: Instant E-Commerce Product Catalog & Faceted Search

For e-commerce storefronts, documentation portals, or B2B inventory tools with thousands of items, querying a local WebDB catalog delivers `< 1 ms` filtering, multi-column sorting, and category counts without hitting your backend on every keystroke.

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

// 1. Open and seed from a pre-built binary snapshot (or create schema)
const db = await WebDB.open({
  name: "storefront_catalog",
  storage: "idb",
});

await db.createTable("products", [
  { name: "id", type: "UUID", primaryKey: true },
  { name: "title", type: "TEXT", notNull: true },
  { name: "brand", type: "TEXT", notNull: true },
  { name: "category", type: "TEXT", notNull: true },
  { name: "price", type: "FLOAT64", notNull: true },
  { name: "rating", type: "FLOAT64", notNull: true },
  { name: "in_stock", type: "INT32", notNull: true },
]);

// Create composite index for fast category + price filtering
await db.createIndex("products", ["category", "price"]);

// 2. Run faceted search & category counts in parallel
export async function searchCatalog(filters: {
  category?: string;
  brands?: string[];
  minPrice?: number;
  maxPrice?: number;
  searchQuery?: string;
  page: number;
}) {
  let query = db.from("products").where("in_stock", "=", 1);

  if (filters.category) {
    query = query.where("category", "=", filters.category);
  }
  if (filters.brands && filters.brands.length > 0) {
    query = query.whereIn("brand", filters.brands);
  }
  if (filters.minPrice !== undefined) {
    query = query.where("price", ">=", filters.minPrice);
  }
  if (filters.maxPrice !== undefined) {
    query = query.where("price", "<=", filters.maxPrice);
  }
  if (filters.searchQuery) {
    query = query.whereContains("title", filters.searchQuery);
  }

  // Fetch matching page
  const items = await query
    .orderBy("rating", "desc")
    .limit(24)
    .offset((filters.page - 1) * 24)
    .toArray();

  // Compute live facet counts by brand
  const brandFacets = await db
    .from("products")
    .where("in_stock", "=", 1)
    .groupBy("brand")
    .select("brand", "count(*) as count")
    .orderBy("count", "desc")
    .toArray();

  return { items, brandFacets };
}
```

---

## Recipe 3: Offline Telemetry & Event Log Buffering

Mobile and desktop web apps often lose analytics or audit events when users go offline or navigate away. With WebDB, you can buffer events reliably in IndexedDB, query local metrics, and flush them in batches when online.

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({ name: "telemetry_buffer", storage: "idb" });

await db.createTable("events", [
  { name: "id", type: "ULID", primaryKey: true }, // Chronologically sortable 16-byte ID
  { name: "event_name", type: "TEXT", notNull: true },
  { name: "duration_ms", type: "INT32" },
  { name: "payload_json", type: "TEXT" },
  { name: "recorded_at", type: "INT64", notNull: true },
]);

// 1. Record an event locally (persists even if offline)
export async function trackEvent(
  id: string,
  eventName: string,
  durationMs: number,
  payload: Record<string, unknown>,
) {
  await db.insert("events", {
    id,
    event_name: eventName,
    duration_ms: durationMs,
    payload_json: JSON.stringify(payload),
    recorded_at: BigInt(Date.now()),
  });
}

// 2. Compute client-side performance summary before uploading
export async function getLocalPerformanceSummary() {
  return db
    .from("events")
    .groupBy("event_name")
    .select(
      "event_name",
      "count(*) as occurrences",
      "avg(duration_ms) as avgDurationMs",
      "max(duration_ms) as peakDurationMs",
    )
    .orderBy("occurrences", "desc")
    .toArray();
}
```

---

## Recipe 4: Running WebDB Inside a Dedicated Web Worker (`OPFS`)

For applications that import tens of thousands of rows or run heavy background syncs, running WebDB inside a Dedicated Web Worker with `storage: 'opfs'` keeps the main UI thread 100% free for 60 FPS animations.

```typescript
// db.worker.ts
import { WebDB } from "@ahmadmoussawi/webdb";

let dbPromise: Promise<WebDB> | null = null;

function getDb(): Promise<WebDB> {
  if (!dbPromise) {
    dbPromise = WebDB.open({
      name: "worker_warehouse",
      storage: "opfs", // High-speed Origin Private File System inside Worker
      core: "wasm",
    });
  }
  return dbPromise;
}

self.onmessage = async (event: MessageEvent) => {
  const { id, action, payload } = event.data;
  try {
    const db = await getDb();

    if (action === "bulkImport") {
      await db.insertMany("records", payload.rows);
      self.postMessage({ id, ok: true });
    } else if (action === "queryRecent") {
      const rows = await db
        .from("records")
        .orderBy("created_at", "desc")
        .limit(payload.limit ?? 50)
        .toArray();
      self.postMessage({ id, ok: true, rows });
    }
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
```
