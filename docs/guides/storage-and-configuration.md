# Storage Backends & Configuration

When opening a database with `WebDB.open(options)`, you pass explicit `engine` and `storage` class instances along with optional memory and coordinator settings:

```typescript
import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("app_production"),
});
```

---

## 1. Choosing a Storage Class (`storage`)

WebDB provides three built-in storage classes that share the exact same query, indexing, and transaction APIs:

| Storage Class                       | Persistence          | Best Used For                                                                    | Browser / Runtime Support                                         |
| :---------------------------------- | :------------------- | :------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| **`IdbStorage`** _(Recommended)_    | Persistent on disk   | Main-thread web apps, PWAs, mobile browsers, and cross-tab apps                  | All modern browsers (Chrome, Safari, Firefox, Edge, iOS WebViews) |
| **`OpfsStorage`**                   | Persistent on disk   | Heavy write workloads, large datasets, and dedicated Web Workers                 | Modern Chromium, Firefox, and Safari 15.2+                        |
| **`MemoryStorage`**                 | Ephemeral (RAM only) | Unit/integration tests (Vitest, Jest, Node.js), SSR, or temporary scratch tables | Universal (Browsers, Node.js, Bun, Deno, Edge Workers)            |

### IndexedDB (`IdbStorage`)

Stores 4 KB database pages and write-ahead log (WAL) frames inside browser IndexedDB object stores. It works reliably on the main UI thread as well as inside Web Workers without blocking frame rendering:

```typescript
import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("crm_client", {
    // IndexedDB transaction durability: 'relaxed' (default) | 'default' | 'strict'
    durability: "relaxed",
  }),
});
```

### Origin Private File System (`OpfsStorage`)

Stores your database directly as native binary files (`.db` and `.wal`) inside the browser's private sandboxed file system (`navigator.storage.getDirectory()`):

```typescript
import { WebDB, WasmEngine, OpfsStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new OpfsStorage("analytics_warehouse"),
});
```

### In-Memory (`MemoryStorage`)

Runs entirely in memory with zero disk I/O overhead. All data is discarded when `db.close()` is called or the page refreshes:

```typescript
import { WebDB, WasmEngine, MemoryStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new MemoryStorage(),
});
```

> [!TIP]
> **Cross-Environment Selection for Tests:** When sharing code between browser production and Node.js unit tests (like Vitest), you can pick `IdbStorage` when `indexedDB` is present and `MemoryStorage` in Node:
>
> ```typescript
> import { WebDB, WasmEngine, IdbStorage, MemoryStorage } from "@ahmadmoussawi/webdb";
>
> const db = await WebDB.open({
>   engine: new WasmEngine(),
>   storage:
>     typeof indexedDB !== "undefined"
>       ? new IdbStorage("my_app")
>       : new MemoryStorage(),
> });
> ```

---

## 2. All `WebDB.open()` Options

```typescript
export interface WebDbOptions {
  /** Execution engine instance (`new WasmEngine(opts?)` or `new JsEngine()`). */
  engine: WebDbCoreEngine;

  /** Storage backend instance (`new IdbStorage(name, opts?)`, `new OpfsStorage(name)`, `new MemoryStorage()`, or custom `IVfsAdapter`). */
  storage: IVfsAdapter;

  /**
   * Optional cross-tab Web Locks / `BroadcastChannel` identifier override.
   * Defaults to `storage.databaseName` when provided by `IdbStorage` or `OpfsStorage`.
   */
  name?: string;

  /** Pre-built binary snapshot (.webdb Uint8Array or ArrayBuffer) to seed the database on open. */
  initialData?: Uint8Array | ArrayBuffer;

  /** Number of 4 KB buffer pool cache slots kept in memory (default: 1024 slots = 4 MB). */
  slotCount?: number;

  /** Maximum memory (in bytes) for in-memory sorting (ORDER BY) and hash grouping (GROUP BY). Default: 16 MB. */
  maxQueryMemory?: number;

  /** Default query planner strategy (defaults to CostBasedPlanner). */
  planner?: QueryPlanner;

  /** Enable cross-tab synchronization via Web Locks and BroadcastChannel (default: `true`). */
  crossTabSync?: boolean;
}
```

---

## 3. Execution Engines (`WasmEngine` & `JsEngine`)

WebDB includes two identical execution engine classes implementing `WebDbCoreEngine`:

- **`WasmEngine` (`@ahmadmoussawi/webdb/core/wasm`):** Executes page scans, B+Tree searches, sorting, and aggregations inside a compiled WebAssembly binary ({{ $sizes.wasmGzip }} gzipped / {{ $sizes.wasmRaw }} raw). Calling `new WasmEngine()` with zero arguments lazily loads the embedded base64 chunk so no external asset config is required.
- **`JsEngine` (`@ahmadmoussawi/webdb/core/js`):** Runs the exact same engine logic in pure JavaScript/TypeScript. Useful for environments with strict Content Security Policies (`CSP`) that disallow `wasm-unsafe-eval` or when stepping through engine execution in a JS debugger.

### Streaming an External `.wasm` File (`wasmUrl`)

If your bundler or CDN serves static `.wasm` assets, pass `wasmUrl` (or a pre-fetched `wasmBinary`) to `new WasmEngine(...)`. WebDB uses `WebAssembly.instantiateStreaming()` and **never loads the embedded ~70 KB base64 chunk**:

```typescript
import { WebDB, WasmEngine, OpfsStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine({
    wasmUrl: new URL("@ahmadmoussawi/webdb/wasm", import.meta.url),
  }),
  storage: new OpfsStorage("my_app"),
});
```

> [!TIP]
> **Reusing `WasmEngine` Across Multiple Databases:** A `WasmEngine` instance compiles and caches its `WebAssembly.Module` once, while each `WebDB.open()` call instantiates it with its own isolated `WebAssembly.Memory`. Share a single `WasmEngine` instance across multiple databases to avoid extra `fetch()` calls and redundant compilation:
>
> ```typescript
> import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";
>
> const engine = new WasmEngine({
>   wasmUrl: new URL("@ahmadmoussawi/webdb/wasm", import.meta.url),
> });
>
> const usersDb = await WebDB.open({ engine, storage: new IdbStorage("users") });
> const cacheDb = await WebDB.open({ engine, storage: new IdbStorage("cache") });
> ```

---

## 4. Modular Loading, Tree-Shaking & Subpath Exports

WebDB has zero hardcoded imports between `WebDB` and any specific engine or storage class, and ships as tree-shakeable ESM (`"sideEffects": false`). An app importing `WasmEngine` + `OpfsStorage` never pulls in the JS VM interpreter (`~62 KB`) or `IdbStorage` (`~11 KB`), and a `JsEngine` app never pulls in the WebAssembly runtime or embedded binary (`~79 KB`).

For **minimal static bundles**, strict CSP/no-dynamic-import environments, or direct browser ESM without a bundler, import from the granular subpath entrypoints:

```typescript
import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { IdbStorage } from "@ahmadmoussawi/webdb/storage/idb";

const db = await WebDB.open({
  engine: new WasmEngine({
    wasmUrl: new URL("@ahmadmoussawi/webdb/wasm", import.meta.url),
  }),
  storage: new IdbStorage("app_production"),
});
```

Or for a **pure-JS + OPFS** worker bundle (zero WASM runtime or binary bundled):

```typescript
import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { OpfsStorage } from "@ahmadmoussawi/webdb/storage/opfs";

const db = await WebDB.open({
  engine: new JsEngine(),
  storage: new OpfsStorage("worker_db"),
});
```

### Subpath Export Reference

| Subpath | Exports | Notes |
| :-- | :-- | :-- |
| `@ahmadmoussawi/webdb` | Full API, engine classes & storage classes | Tree-shakeable ESM (`"sideEffects": false`) + single-file UMD/CJS bundle |
| `@ahmadmoussawi/webdb/slim` | `WebDB`, `QueryBuilder`, `liveQuery`, compiler, planners, types | Zero static imports of WASM, JS VM, or storage classes (ESM) |
| `@ahmadmoussawi/webdb/core/wasm` | `WasmEngine`, `instantiateWasmCore`, `instantiateWasmCoreAsync`, `instantiateWasmCoreStreaming` | Embedded chunk lazy-loaded only when `wasmBinary` / `wasmUrl` is omitted (ESM) |
| `@ahmadmoussawi/webdb/core/js` | `JsEngine`, `vm_step`, `vm_step_raw` | Pure JS VM interpreter; zero WASM code (ESM) |
| `@ahmadmoussawi/webdb/storage/idb` | `IdbStorage`, `IdbStorageOptions`, `IdbDurability` | IndexedDB storage only (ESM) |
| `@ahmadmoussawi/webdb/storage/opfs` | `OpfsStorage` | OPFS storage only (ESM) |
| `@ahmadmoussawi/webdb/storage/memory` | `MemoryStorage` | In-memory storage only (ESM) |
| `@ahmadmoussawi/webdb/wasm` | `dist/webdb_core.wasm` | Raw WebAssembly binary for `new WasmEngine({ wasmUrl })` streaming |

> [!NOTE]
> The granular subpath entrypoints (`/slim`, `/core/*`, `/storage/*`) target ESM / modern bundler environments (and Node 22+). CommonJS (`require('@ahmadmoussawi/webdb')`) and `<script>` UMD consumers use the self-contained root bundle.

---

## 5. Tuning Memory Limits (`slotCount` & `maxQueryMemory`)

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
  engine: new WasmEngine(),
  storage: new OpfsStorage("analytics_db"),
  slotCount: 2048, // 8 MB page cache
  maxQueryMemory: 64 * 1024 * 1024, // 64 MB query arena for large sorts/groupings
});
```

---

## 6. Custom Storage Adapters (`IVfsAdapter`)

If you want to store 4 KB database pages and Write-Ahead Log (WAL) frames in a custom backend (such as Electron's native Node `fs`, React Native storage, Cloudflare KV, or a remote storage service), implement a class conforming to [`IVfsAdapter`](https://github.com/ahmad-moussawi/webdb/blob/main/src/host/storage/vfs.ts).

`IVfsAdapter` uses batch page/frame methods (`readPages`, `writePages`, `readWalFrames`, `appendWalFrames`) so implementations only need to handle arrays of pages and frames—avoiding duplicate single-item methods—while lifecycle/fsync hooks (`flush`, `flushWal`, `close`, `isSynchronous`) are optional:

```typescript
import { WebDB, WasmEngine, type IVfsAdapter } from "@ahmadmoussawi/webdb";

class CustomVfsAdapter implements IVfsAdapter {
  readonly name = "custom" as const; // Unique backend identifier (avoid "memory" for persistent adapters so Web Locks stay enabled)
  readonly databaseName = "custom_db";
  readonly isSynchronous = false;

  // --- Main Database Pages (4,096 bytes each, 1-indexed pageId) ---
  async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    // Return 4096-byte Uint8Array for each pageId (or null if not yet written)
    return pageIds.map(() => null);
  }

  async writePages(
    pages: Array<{ pageId: number; data: Uint8Array }>,
  ): Promise<void> {
    // Persist each 4096-byte page at p.pageId
  }

  async truncate(pageCount: number): Promise<void> {
    // Remove any stored pages with pageId > pageCount
  }

  // --- Write-Ahead Log (32-byte header + 4,128-byte frames, 0-indexed) ---
  async readWalHeader(): Promise<Uint8Array | null> {
    // Return 32-byte WAL header, or null if WAL is empty
    return null;
  }

  async writeWalHeader(header: Uint8Array): Promise<void> {
    // Persist 32-byte WAL header
  }

  async readWalFrames(
    startFrameIndex: number,
    maxFrames?: number,
  ): Promise<Uint8Array[]> {
    // Return consecutive 4128-byte WAL frames starting from startFrameIndex
    return [];
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    // Append one or more 4128-byte WAL frames to the end of the log
  }

  async truncateWal(frameIndex: number): Promise<void> {
    // Truncate WAL to frameIndex frames (0 resets/clears the WAL after checkpoint)
  }

  async getWalFrameCount(): Promise<number> {
    // Return current number of frames in the WAL
    return 0;
  }

  // --- Optional Lifecycle & Durability Hooks ---
  async flush(): Promise<void> {
    // Optional: fsync main page storage
  }

  async flushWal(): Promise<void> {
    // Optional: fsync WAL storage on transaction commit
  }

  async close(): Promise<void> {
    // Optional: release underlying file/storage handles
  }
}

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new CustomVfsAdapter(),
  name: "custom_db",
});
```

> [!TIP]
> **Extending `MemoryStorage`:** If you are building a read-only adapter or an in-memory adapter that periodically syncs pages to a remote backend, you can subclass `MemoryStorage` (exported from `@ahmadmoussawi/webdb` and `@ahmadmoussawi/webdb/storage/memory`) so all WAL and page methods work out of the box, and only override the methods you need.

---

## 7. Example: HTTP Range Storage (`HttpVfsAdapter`)

Because WebDB's B+Tree engine suspends asynchronously on 4 KB page faults (`PAGE_SIZE = 4096`), you can query a large `.webdb` database hosted on **Amazon S3, Cloudflare R2, GitHub Pages, or any static CDN** using standard HTTP `Range: bytes=start-end` (`206 Partial Content`) requests—without downloading the entire database file.

When an indexed query runs, WebDB only fetches Page 1 (the system catalog), the relevant B+Tree index pages, and the matching data pages—often transferring just **12–24 KB** over the network for a point or range lookup on a multi-megabyte or multi-gigabyte dataset.

### Implementing `HttpVfsAdapter`

By extending `MemoryStorage`, your `HttpVfsAdapter` automatically caches every fetched 4 KB page in memory and even supports temporary local copy-on-write mutations in the browser session:

```typescript
import { WebDB, WasmEngine, MemoryStorage } from "@ahmadmoussawi/webdb";

const PAGE_SIZE = 4096;

export class HttpVfsAdapter extends MemoryStorage {
  /** Tracks 1-based pageIds already requested from the remote server */
  private fetchedPages = new Set<number>();

  constructor(
    private readonly url: string,
    private readonly requestInit?: RequestInit,
  ) {
    super();
  }

  override async readPages(
    pageIds: number[],
  ): Promise<Array<Uint8Array | null>> {
    // 1. Check which pages are already resident in memory
    const cached = await super.readPages(pageIds);
    const missingIds = Array.from(
      new Set(
        pageIds.filter(
          (pageId, idx) =>
            cached[idx] === null && !this.fetchedPages.has(pageId),
        ),
      ),
    ).sort((a, b) => a - b);

    if (missingIds.length === 0) {
      return cached;
    }

    // 2. Coalesce contiguous 4 KB page IDs into single HTTP Range spans
    const spans: Array<{ startPageId: number; count: number }> = [];
    for (const pageId of missingIds) {
      const last = spans[spans.length - 1];
      if (last && last.startPageId + last.count === pageId) {
        last.count++;
      } else {
        spans.push({ startPageId: pageId, count: 1 });
      }
    }

    // 3. Fetch each byte range in parallel via HTTP Range: bytes=start-end
    const newlyLoaded: Array<{ pageId: number; data: Uint8Array }> = [];

    await Promise.all(
      spans.map(async ({ startPageId, count }) => {
        const startByte = (startPageId - 1) * PAGE_SIZE;
        const endByte = startByte + count * PAGE_SIZE - 1;

        const response = await fetch(this.url, {
          ...this.requestInit,
          headers: {
            ...this.requestInit?.headers,
            Range: `bytes=${startByte}-${endByte}`,
          },
        });

        // 416 Range Not Satisfiable / 404 means the page is beyond EOF
        if (response.status === 416 || response.status === 404) {
          for (let i = 0; i < count; i++) {
            this.fetchedPages.add(startPageId + i);
          }
          return;
        }

        if (!response.ok && response.status !== 206) {
          throw new Error(
            `HttpVfsAdapter failed to fetch range ${startByte}-${endByte}: HTTP ${response.status}`,
          );
        }

        const buffer = new Uint8Array(await response.arrayBuffer());
        const pagesReturned = Math.floor(buffer.byteLength / PAGE_SIZE);

        for (let i = 0; i < count; i++) {
          const pageId = startPageId + i;
          this.fetchedPages.add(pageId);
          if (i < pagesReturned) {
            const offset = i * PAGE_SIZE;
            newlyLoaded.push({
              pageId,
              data: buffer.subarray(offset, offset + PAGE_SIZE),
            });
          }
        }
      }),
    );

    // 4. Cache the fetched 4 KB pages in MemoryStorage for future reads
    if (newlyLoaded.length > 0) {
      await super.writePages(newlyLoaded);
    }

    return super.readPages(pageIds);
  }
}
```

### Querying a Remote `.webdb` File

1. Export a pre-indexed `.webdb` binary snapshot during your build/CI pipeline using `const bytes = await db.exportBinary()` and upload `catalog.webdb` to S3, Cloudflare R2, or your static CDN.
2. Open the database in the browser with `HttpVfsAdapter`:

```typescript
const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new HttpVfsAdapter("https://cdn.example.com/catalog.webdb"),
  name: "remote_catalog",
});

// Traverses the B+Tree index over 4 KB HTTP Range requests
// without downloading the entire database file!
const products = await db
  .from("products")
  .where("category", "=", "Electronics")
  .where("in_stock", "=", 1)
  .orderBy("rating", "desc")
  .limit(10)
  .toArray();
```

> [!IMPORTANT]
> **CORS & Static Host Requirements for HTTP Range Requests:**
> When hosting `.webdb` files on a different origin (such as S3 or Cloudflare R2), ensure your bucket/CDN CORS policy allows the `Range` request header and exposes `Content-Range` and `Content-Length`:
>
> - `Accept-Ranges: bytes`
> - `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
> - `Access-Control-Allow-Headers: Range`
> - `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`

---

## 8. Closing the Database (`db.close()`)

When shutting down a component, test, or worker, call `await db.close()` to flush any dirty pages, close `BroadcastChannel` listeners, and release underlying storage handles:

```typescript
await db.close();
```
