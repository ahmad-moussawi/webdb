# Binary Snapshots, Import & Export

WebDB databases are stored as contiguous 4 KB pages with IEEE 802.3 CRC32 integrity checksums. You can export an entire database (tables, schemas, rows, and B+Tree indexes) into a single `Uint8Array` binary snapshot and restore it anywhere in milliseconds.

---

## Common Use Cases for Snapshots

1. **Fast Cold-Start Seeding:** Ship a pre-built `.webdb` binary file from a CDN or API endpoint so new users hydrate thousands of catalog rows in `< 5 ms` without parsing JSON or building indexes on the client.
2. **User Data Backups:** Let users download a `.webdb` backup file of their local workspace and restore it later via file upload.
3. **Testing Fixtures:** Build a seeded database once in a test suite `beforeAll` hook, call `exportBinary()`, and restore it before each test.

---

## 1. Exporting a Database Snapshot (`db.exportBinary`)

Call `await db.exportBinary()` to receive a self-contained `Uint8Array` containing all pages of your database with verified CRC32 checksums:

```typescript
const snapshotBytes: Uint8Array = await db.exportBinary();

console.log(`Exported snapshot size: ${snapshotBytes.byteLength} bytes`);
```

### Triggering a Browser File Download

```typescript
async function downloadDatabaseBackup(db: WebDB, filename = 'backup.webdb') {
  const bytes = await db.exportBinary();
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}
```

---

## 2. Seeding a Database on Open (`initialData`)

Pass `initialData` to `WebDB.open()` to initialize the database from a binary snapshot:

```typescript
const response = await fetch('/assets/starter-catalog.webdb');
const snapshotBuffer = await response.arrayBuffer();

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage('catalog_db'),
  initialData: snapshotBuffer, // Accepts Uint8Array or ArrayBuffer
});

// Ready to query immediately!
const products = await db.from('products').limit(20).toArray();
```

---

## 3. Importing / Restoring at Runtime (`db.importBinary`)

To replace the contents of an already-open `WebDB` instance at runtime (for example, when a user uploads a backup file), call `await db.importBinary(data)`.

WebDB validates the file header, format version, page count, and **every page's CRC32 checksum** before replacing storage. If any byte is corrupted, `importBinary()` rejects with `InvalidDatabaseError` or `CorruptPageError` and leaves your existing database untouched.

```typescript
async function restoreFromFileInput(db: WebDB, file: File) {
  const buffer = await file.arrayBuffer();

  // Atomically validates checksums and replaces all tables, rows, and indexes
  await db.importBinary(buffer);

  console.log('Database restored successfully!');
}
```

> [!WARNING]
> `db.importBinary()` cannot be called *inside* an active `db.transaction()` block. Call it directly on the top-level `db` instance.

---

## 4. Compacting & Reclaiming Space (`db.compact`)

Over time, bulk `delete()` calls, dropped tables (`dropTable`), dropped indexes, or heavy row updates leave behind `FREE` pages, sparse `LEAF_DATA` / `INDEX_LEAF` pages, and intra-page fragmentation. Calling `await db.compact()` performs a SQLite `VACUUM`-style rebuild into densely packed 4 KB pages while preserving all schemas, rows, `0x0E` overflow payloads, secondary indexes (including `UNIQUE` constraints and sort directions), `autoIncNext` counters, and `schemaVersion`:

```typescript
// 1. Preview fragmentation and exact compacted size without mutating storage
//    (allowed even on read-only databases)
const preview = await db.compact({ dryRun: true });
console.log(
  `Can reclaim ${preview.pagesReclaimed} pages (${preview.bytesReclaimed} bytes), ` +
    `${preview.freePagesBefore} free, ${preview.unreferencedPagesBefore} unreferenced, ` +
    `${preview.fragmentedBytesBefore} fragmented cell bytes`,
);

// 2. Compact only if at least 16 pages (64 KB) will be reclaimed
const maybeCompacted = await db.compact({ minReclaimPages: 16 });
if (maybeCompacted.compacted) {
  console.log(`Shrank DB to ${maybeCompacted.pagesAfter} pages`);
}

// 3. Always run full compaction (increments changeCounter by 1 and emits origin: "compact")
const result = await db.compact();
```

### `CompactOptions` & `CompactResult`

| Option / Field | Type | Description |
| :--- | :--- | :--- |
| **`dryRun`** | `boolean` | When `true`, analyzes fragmentation and builds the compacted layout without modifying storage (`compacted` is `false`). Allowed on read-only databases. |
| **`minReclaimPages`** | `number` | Skips rewriting storage and returns `compacted: false` if `pagesReclaimed < minReclaimPages`. |
| **`batchSize`** | `number` | Rows inserted per `insertMany` batch during rebuild (default: `500`). |
| **`compacted`** | `boolean` | Whether live storage was replaced (`false` on `dryRun` or when skipped by `minReclaimPages`). |
| **`pagesBefore` / `pagesAfter`** | `number` | Total 4 KB page count before and after compaction. |
| **`bytesBefore` / `bytesAfter`** | `number` | Total database byte size before and after compaction. |
| **`pagesReclaimed` / `bytesReclaimed`** | `number` | Number of 4 KB pages and bytes reclaimed (`before - after`). |
| **`freePagesBefore`** | `number` | Count of `FREE` (`0x00`) pages present before compaction. |
| **`unreferencedPagesBefore`** | `number` | Count of orphaned/unreferenced non-free pages present before compaction. |
| **`fragmentedBytesBefore`** | `number` | Cumulative fragmented free bytes recorded inside leaf/index pages before compaction. |
| **`tablesCompacted` / `indexesRebuilt` / `rowsCopied`** | `number` | Verification counts of tables, secondary indexes, and rows rebuilt. |

> [!WARNING]
> `db.compact()` cannot be called *inside* an active `db.transaction()` block, and requires writable storage unless `{ dryRun: true }` is passed.

---

## 5. Opening Remote & Compressed (`.webdb.gz`) Snapshots in WebDB Studio

The [**WebDB Studio Playground**](https://studio.webdb.dev/) natively supports exporting and importing both raw `.webdb` images and gzip-compressed `.webdb.gz` snapshots (which typically compress 4 KB slotted pages by **70–90%** using the browser's native `CompressionStream` / `DecompressionStream`).

You can also create **shareable external links** that directly open a remote `.webdb` or `.webdb.gz` file inside the Studio IDE via URL query parameters:

```
https://studio.webdb.dev/?core=wasm&db=https://example.com/files/db.webdb.gz&storage=memory
```

| URL Parameter | Values | Description |
| :--- | :--- | :--- |
| **`db`** | `https://...` | Direct URL to a CORS-enabled `.webdb` or `.webdb.gz` binary snapshot. |
| **`core`** | `wasm` \| `js` | Execution engine mode (defaults to `wasm`). |
| **`storage`** | `memory` \| `idb` \| `opfs` | Storage backend where the remote snapshot should be mounted. |
| **`name`** | `string` | Optional local database name override. |


