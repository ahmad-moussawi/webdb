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

If you want to store 4 KB database pages and Write-Ahead Log (WAL) frames in a custom backend (such as Electron's native Node `fs`, React Native storage, Cloudflare KV, or a remote storage service), implement a class conforming to [`IVfsAdapter`](./src/host/storage/vfs.ts).

`IVfsAdapter` uses batch page/frame methods (`readPages`, `writePages`, `readWalFrames`, `appendWalFrames`) so implementations only need to handle arrays of pages and frames—avoiding duplicate single-item methods—while lifecycle/fsync hooks (`flush`, `flushWal`, `close`, `isSynchronous`) are optional:

```typescript
import { WebDB, type IVfsAdapter } from "@ahmadmoussawi/webdb";

class CustomVfsAdapter implements IVfsAdapter {
  readonly name = "memory" as const; // 'memory' | 'opfs' | 'idb'
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
  name: "custom_db",
  vfs: new CustomVfsAdapter(),
});
```

> [!TIP]
> **Extending `MemoryVfsAdapter`:** If you are building a read-only adapter or an in-memory adapter that periodically syncs pages to a remote backend, you can subclass `MemoryVfsAdapter` (exported from `@ahmadmoussawi/webdb`) so all WAL and page methods work out of the box, and only override the methods you need.

---

## 6. Example: HTTP Range VFS (`HttpVfsAdapter`)

Because WebDB's B+Tree engine suspends asynchronously on 4 KB page faults (`PAGE_SIZE = 4096`), you can query a large `.webdb` database hosted on **Amazon S3, Cloudflare R2, GitHub Pages, or any static CDN** using standard HTTP `Range: bytes=start-end` (`206 Partial Content`) requests—without downloading the entire database file.

When an indexed query runs, WebDB only fetches Page 1 (the system catalog), the relevant B+Tree index pages, and the matching data pages—often transferring just **12–24 KB** over the network for a point or range lookup on a multi-megabyte or multi-gigabyte dataset.

### Implementing `HttpVfsAdapter`

By extending `MemoryVfsAdapter`, your `HttpVfsAdapter` automatically caches every fetched 4 KB page in memory and even supports temporary local copy-on-write mutations in the browser session:

```typescript
import { WebDB, MemoryVfsAdapter } from "@ahmadmoussawi/webdb";

const PAGE_SIZE = 4096;

export class HttpVfsAdapter extends MemoryVfsAdapter {
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

    // 4. Cache the fetched 4 KB pages in MemoryVfsAdapter for future reads
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
  name: "remote_catalog",
  vfs: new HttpVfsAdapter("https://cdn.example.com/catalog.webdb"),
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

## 7. Closing the Database (`db.close()`)

When shutting down a component, test, or worker, call `await db.close()` to flush any dirty pages, close `BroadcastChannel` listeners, and release underlying storage handles:

```typescript
await db.close();
```
