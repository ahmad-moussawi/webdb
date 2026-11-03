# Storage Backends & Configuration

When opening a database with `WebDB.open(options)`, you can choose how and where WebDB persists your data, which execution core to use, and how much memory to allocate for cache and analytical queries.

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  name: "app_production",
  storage: "idb",
  core: "wasm",
});
```

---

## 1. Choosing a Storage Backend (`storage`)

WebDB provides three built-in storage backends that share the exact same query, indexing, and transaction APIs:

| Storage Option              | Persistence          | Best Used For                                                                    | Browser / Runtime Support                                         |
| :-------------------------- | :------------------- | :------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| **`'idb'`** _(Recommended)_ | Persistent on disk   | Main-thread web apps, PWAs, mobile browsers, and cross-tab apps                  | All modern browsers (Chrome, Safari, Firefox, Edge, iOS WebViews) |
| **`'opfs'`**                | Persistent on disk   | Heavy write workloads, large datasets, and dedicated Web Workers                 | Modern Chromium, Firefox, and Safari 15.2+                        |
| **`'memory'`** _(Default)_  | Ephemeral (RAM only) | Unit/integration tests (Vitest, Jest, Node.js), SSR, or temporary scratch tables | Universal (Browsers, Node.js, Bun, Deno, Edge Workers)            |

### IndexedDB (`storage: 'idb'`)

Stores 4 KB database pages and write-ahead log (WAL) frames inside browser IndexedDB object stores. It works reliably on the main UI thread as well as inside Web Workers without blocking frame rendering.

```typescript
const db = await WebDB.open({
  name: "crm_client",
  storage: "idb",
});
```

### Origin Private File System (`storage: 'opfs'`)

Stores your database directly as native binary files (`.db` and `.wal`) inside the browser's private sandboxed file system (`navigator.storage.getDirectory()`).

```typescript
const db = await WebDB.open({
  name: "analytics_warehouse",
  storage: "opfs",
});
```

### In-Memory (`storage: 'memory'`)

Runs entirely in memory with zero disk I/O overhead. All data is discarded when `db.close()` is called or the page refreshes.

```typescript
const db = await WebDB.open({
  name: "unit_test_db",
  storage: "memory",
});
```

> [!TIP]
> **Automatic Environment Fallback for Tests:** When sharing code between browser production and Node.js unit tests (like Vitest), you can select `'idb'` when `indexedDB` is present and fall back to `'memory'` in Node:
>
> ```typescript
> const db = await WebDB.open({
>   name: "my_app",
>   storage: typeof indexedDB !== "undefined" ? "idb" : "memory",
> });
> ```

---

## 2. All `WebDB.open()` Options

```typescript
export interface WebDbOptions {
  /** Unique database name (used to namespace IndexedDB stores, OPFS files, and multi-tab locks). */
  name: string;

  /** Built-in storage adapter: 'memory' (default) | 'idb' | 'opfs'. */
  storage?: "memory" | "idb" | "opfs";

  /** Execution core: 'wasm' (~13 KB WebAssembly binary) | 'js' (pure JS fallback). */
  core?: "wasm" | "js";

  /** Pre-built binary snapshot (.webdb Uint8Array or ArrayBuffer) to seed the database on open. */
  initialData?: Uint8Array | ArrayBuffer;

  /** Number of 4 KB buffer pool cache slots kept in memory (default: 1024 slots = 4 MB). */
  slotCount?: number;

  /** Maximum memory (in bytes) for in-memory sorting (ORDER BY) and hash grouping (GROUP BY). Default: 16 MB. */
  maxQueryMemory?: number;

  /** Default query planner strategy (defaults to CostBasedPlanner). */
  planner?: QueryPlanner;

  /** Custom Virtual File System adapter implementing IVfsAdapter (overrides `storage`). */
  vfs?: IVfsAdapter;

  /** Optional custom WebAssembly binary buffer if hosting the .wasm file externally. */
  wasmBinary?: ArrayBuffer | Uint8Array;
}
```

---

## 3. Execution Core (`core: 'wasm' | 'js'`)

WebDB includes two identical execution engines:

- **`'wasm'`:** Executes page scans, B+Tree searches, sorting, and aggregations inside a compiled WebAssembly binary (~13 KB embedded directly in the package—no external `.wasm` fetch or Vite asset plugin needed).
- **`'js'`:** Runs the exact same engine logic in pure JavaScript/TypeScript. Useful for environments with strict Content Security Policies (`CSP`) that disallow `wasm-unsafe-eval` or when stepping through engine execution in a JS debugger.

```typescript
const db = await WebDB.open({
  name: "my_app",
  storage: "idb",
  core: "wasm",
});
```

---

## 4. Tuning Memory Limits (`slotCount` & `maxQueryMemory`)

WebDB uses bounded, predictable memory buffers so a heavy query never crashes a mobile browser tab:

### Buffer Pool Cache (`slotCount`)

Controls how many 4 KB database pages stay cached in memory before unpinned pages are evicted to disk.

- **Default:** `1024` slots (`4 MB`).
- Increase `slotCount` if your application frequently queries a working set larger than 4 MB.

### Query Arena Ceiling (`maxQueryMemory`)

Controls the maximum transient memory available for unindexed `ORDER BY` sorting and `GROUP BY` hash aggregations.

- **Default:** `16 MB` (`16 * 1024 * 1024` bytes).
- If a query exceeds this limit, WebDB fails fast and throws `QueryArenaExhaustedError` rather than freezing the browser tab.
- For heavy analytical dashboards processing hundreds of thousands of rows, you can raise this limit:

```typescript
const db = await WebDB.open({
  name: "analytics_db",
  storage: "opfs",
  slotCount: 2048, // 8 MB page cache
  maxQueryMemory: 64 * 1024 * 1024, // 64 MB query arena for large sorts/groupings
});
```

---

## 5. Custom VFS Adapters (`vfs`)

If you want to store 4 KB pages in a custom backend (such as Electron's native Node `fs`, React Native storage, Cloudflare KV, or a remote HTTP CDN), you can pass a custom object implementing [`IVfsAdapter`](./src/host/storage/vfs.ts):

```typescript
import { WebDB, type IVfsAdapter } from "@ahmadmoussawi/webdb";

const customVfs: IVfsAdapter = {
  name: "custom-storage",
  async readPage(pageId: number): Promise<Uint8Array | null> {
    // Return 4096-byte Uint8Array for pageId, or null if not yet written
    return null;
  },
  async writePage(pageId: number, data: Uint8Array): Promise<void> {
    // Persist 4096-byte page
  },
  async writePages(
    pages: Array<{ pageId: number; data: Uint8Array }>,
  ): Promise<void> {
    for (const p of pages) {
      await this.writePage(p.pageId, p.data);
    }
  },
  async flush(): Promise<void> {},
  async close(): Promise<void> {},
};

const db = await WebDB.open({
  name: "custom_db",
  vfs: customVfs,
});
```

---

## 6. Closing the Database (`db.close()`)

When shutting down a component, test, or worker, call `await db.close()` to flush any dirty pages, close `BroadcastChannel` listeners, and release underlying storage handles:

```typescript
await db.close();
```
