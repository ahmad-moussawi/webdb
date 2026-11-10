# Locking & Cross-Tab Coordination

WebDB is engineered from the ground up for multi-tab browser environments. When users open multiple tabs, windows, or Web Workers pointing to the same database on the same origin, WebDB guarantees strict **ACID isolation**, **cache coherency**, and **sub-5ms crash recovery** without requiring a central server or polling.

---

## 1. The Multi-Tab Browser Challenge

Running a relational database inside a browser introduces fundamental concurrency challenges that traditional server-side databases (like PostgreSQL or MySQL) do not face:

<div class="diagram-container" style="margin: 24px 0; overflow-x: auto;">
<svg viewBox="0 0 800 380" width="100%" height="100%" style="max-width: 800px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display: block; margin: 0 auto;" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--vp-c-brand-1, #3b82f6)"/>
    </marker>
    <marker id="arrow-g" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--vp-c-green-1, #10b981)"/>
    </marker>
  </defs>

  <!-- Tab A Subgraph -->
  <rect x="20" y="20" width="240" height="210" rx="12" fill="var(--vp-c-bg-soft, #f8fafc)" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <text x="35" y="45" font-weight="700" font-size="13" fill="var(--vp-c-text-1, #0f172a)">Browser Tab A (Writer)</text>
  <rect x="35" y="60" width="210" height="42" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="140" y="86" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-text-1, #1e293b)">WebDB Instance A</text>
  <rect x="35" y="112" width="210" height="42" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="140" y="132" text-anchor="middle" font-size="12" font-weight="500" fill="var(--vp-c-text-1, #1e293b)">Buffer Pool A</text>
  <text x="140" y="146" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">1024 Page Slots (4 MB)</text>
  <rect x="35" y="164" width="210" height="42" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="140" y="184" text-anchor="middle" font-size="12" font-weight="500" fill="var(--vp-c-text-1, #1e293b)">Catalog Cache A</text>
  <text x="140" y="198" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">Table &amp; Index Metadata</text>

  <!-- Tab B Subgraph -->
  <rect x="540" y="20" width="240" height="210" rx="12" fill="var(--vp-c-bg-soft, #f8fafc)" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <text x="555" y="45" font-weight="700" font-size="13" fill="var(--vp-c-text-1, #0f172a)">Browser Tab B (Reader / UI)</text>
  <rect x="555" y="60" width="210" height="42" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="660" y="86" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-text-1, #1e293b)">WebDB Instance B</text>
  <rect x="555" y="112" width="210" height="42" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="660" y="132" text-anchor="middle" font-size="12" font-weight="500" fill="var(--vp-c-text-1, #1e293b)">Buffer Pool B</text>
  <text x="660" y="146" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">1024 Page Slots (4 MB)</text>
  <rect x="555" y="164" width="210" height="42" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="660" y="184" text-anchor="middle" font-size="12" font-weight="500" fill="var(--vp-c-text-1, #1e293b)">Catalog Cache B</text>
  <text x="660" y="198" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">Table &amp; Index Metadata</text>

  <!-- Broadcast Channel in the Middle -->
  <rect x="285" y="60" width="230" height="55" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-green-1, #10b981)" stroke-width="1.5" />
  <text x="400" y="83" text-anchor="middle" font-size="13" font-weight="700" fill="var(--vp-c-green-1, #10b981)">BroadcastChannel</text>
  <text x="400" y="101" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">webdb_sync_${vfs}_${db}</text>

  <!-- Broadcast arrows -->
  <line x1="245" y1="87" x2="277" y2="87" stroke="var(--vp-c-green-1, #10b981)" stroke-width="1.5" marker-end="url(#arrow-g)" />
  <line x1="515" y1="87" x2="547" y2="87" stroke="var(--vp-c-green-1, #10b981)" stroke-width="1.5" marker-end="url(#arrow-g)" />

  <!-- Shared Origin Storage Subgraph -->
  <rect x="170" y="270" width="460" height="95" rx="12" fill="var(--vp-c-bg-soft, #f8fafc)" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <text x="400" y="292" text-anchor="middle" font-weight="700" font-size="13" fill="var(--vp-c-text-1, #0f172a)">Shared Origin Storage (IndexedDB / OPFS)</text>
  <rect x="190" y="305" width="200" height="45" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-indigo-1, #6366f1)" stroke-width="1.5" />
  <text x="290" y="325" text-anchor="middle" font-size="12" font-weight="500" fill="var(--vp-c-text-1, #1e293b)">Database Pages</text>
  <text x="290" y="340" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">Page 1 (Catalog) .. Page N</text>

  <rect x="410" y="305" width="200" height="45" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-indigo-1, #6366f1)" stroke-width="1.5" />
  <text x="510" y="325" text-anchor="middle" font-size="12" font-weight="500" fill="var(--vp-c-text-1, #1e293b)">Write-Ahead Log (.wal)</text>
  <text x="510" y="340" text-anchor="middle" font-size="11" fill="var(--vp-c-text-2, #64748b)">CRC32 Atomic Commit Frames</text>

  <!-- Web Locks Coordinator lines -->
  <path d="M 140 230 L 140 327 L 182 327" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" fill="none" marker-end="url(#arrow)" />
  <path d="M 660 230 L 660 327 L 618 327" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" fill="none" marker-end="url(#arrow)" />

  <!-- Lock Label in Center -->
  <rect x="290" y="200" width="220" height="34" rx="6" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.2" />
  <text x="400" y="222" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-brand-1, #2563eb)">navigator.locks (Exclusive)</text>
</svg>
</div>

1. **Independent Memory Heaps & Buffer Pools**:
   Each browser tab possesses its own isolated JavaScript heap and `WebAssembly.Memory`. If Tab A commits an update that alters Page 4, Tab B's in-memory buffer pool will still hold the stale image of Page 4 unless an active invalidation protocol exists.
2. **Storage Lock Invariants (OPFS & IndexedDB)**:
   In the Origin Private File System (OPFS), opening a `FileSystemSyncAccessHandle` claims an exclusive file lock; attempting to open it concurrently from another context throws `NoModificationAllowedError`. In IndexedDB, uncoordinated concurrent read-modify-write cycles can overwrite each other's binary chunks.
3. **Abrupt Tab Termination**:
   Users can close, kill, or refresh tabs at any point in time—including halfway through writing a slotted page or committing a WAL transaction. The locking mechanism must **never leave orphaned deadlocks**.

---

## 2. The Two-Tier Concurrency Architecture

To resolve these challenges, WebDB implements a coordinated two-tier concurrency engine:

| Tier | Component | Scope | Responsibility |
| :--- | :--- | :--- | :--- |
| **Tier 1 (Intra-Tab)** | `ExclusiveLeaseQueue` | Single Tab / Worker | Serializes local async operations in FIFO order; coordinates explicit `db.transaction()` leases with autocommit queries. |
| **Tier 2 (Cross-Tab)** | Web Locks (`navigator.locks`) | All Tabs across Origin | Ensures only one tab touches the shared storage and WAL at any given instant. |

---

## 3. Tier 1: Local Intra-Tab Concurrency (`ExclusiveLeaseQueue`)

Within a single tab, JavaScript is single-threaded, but concurrent asynchronous calls (`Promise.all()`, unawaited queries, UI events) can initiate overlapping storage operations.

The `ExclusiveLeaseQueue` coordinates local tasks via two pathways:

### Autocommit Queries
Single reads and writes (e.g. `db.insert()`, `db.from().toArray()`) pass through `leaseQueue.enqueue()`. If no transaction is active, they execute immediately. If multiple autocommit tasks arrive together, they queue in strict FIFO order.

### Explicit Transactions (`TransactionLease`)
When you call `db.transaction(async (tx) => ...)`:
1. The coordinator requests an **Exclusive Transaction Lease** (`acquireExclusiveLease()`).
2. It waits for any in-flight autocommit queries to drain.
3. It assigns a unique `leaseId` and `txId`.
4. All database operations performed using the `tx` object bypass the queue and dispatch immediately.
5. Any operations called on the outer `db` instance during this window are queued behind the transaction lease until `commit()` or `rollback()` completes.

---

## 4. Tier 2: Cross-Tab Coordination via the Web Locks API

For coordinating across different tabs, windows, and Web Workers, WebDB relies on the native **Web Locks API** (`navigator.locks`).

### Lock Naming & Acquisition
WebDB scopes locks per storage adapter and database name:
```
webdb_lock_${vfs.name}_${dbName}
```
*(For example: `webdb_lock_idb_my_app` or `webdb_lock_opfs_analytics`)*

Whenever a tab needs to perform an exclusive operation (such as flushing WAL frames, committing transactions, or running migrations), it requests an exclusive Web Lock:

```ts
await navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
  // 1. Sync cross-tab state (detect if other tabs wrote new pages)
  await syncCrossTabState();

  // 2. Perform transactional read/write operations
  await executeTask();

  // 3. Flush changes and broadcast update
  await broadcastChanges();
});
```

### Sub-5ms Instant Failover on Tab Close
Unlike manual lock flags stored in `localStorage` (which permanently deadlock if a tab is killed before clearing the flag), **Web Locks are operating-system-level browser primitives**.

If a tab crashes or the user terminates the browser tab:
* The browser runtime **automatically and atomically releases the Web Lock within 5 milliseconds**.
* The next queued tab in `navigator.locks.request` is instantly granted the lock.
* The newly scheduled tab immediately inspects the WAL, rolls back any incomplete writes from the dead tab, and resumes normal execution with zero downtime.

---

## 5. Cache Coherency & State Synchronization

When Tab A commits a change, Tab B must invalidate its in-memory buffer pool before executing its next read. WebDB achieves this with a zero-copy version check.

### Page 1 Header Flags
Page 1 contains two monotonic 32-bit integers in its system header:
* **`changeCounter`** (`HEADER_OFFSET_CHANGE_COUNTER`): Incremented on every committed write transaction.
* **`schemaVersion`** (`HEADER_OFFSET_SCHEMA_VERSION`): Incremented on every DDL change (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`).

### The Synchronization Protocol (`syncCrossTabState`)
Whenever a tab acquires the cross-tab lock lease (or receives an invalidation notification):
1. **WAL Salt & Frame Verification**:
   The tab compares the `.wal` header salt and frame count against its local sequence. If another tab appended frames, it invokes `recoverFromWal()` to replay committed frames into Page 1..N and discard any orphaned frames.
2. **Header Comparison**:
   The tab reads Page 1's header bytes:
   * If `changeCounter` changed: it invalidates all cached pages in buffer pool slots $1 \dots N$. Future reads will re-fetch fresh page bytes from storage.
   * If `schemaVersion` changed: it clears the internal table metadata cache (`tableMetaCache`), table tail pointers, and index tail pointers, re-parsing catalog definitions from Page 1.

---

## 6. Reactive Cross-Tab Invalidation (`BroadcastChannel`)

WebDB uses `BroadcastChannel` to propagate mutations across tabs in real time:
```
webdb_sync_${vfs.name}_${dbName}
```

<div class="diagram-container" style="margin: 24px 0; overflow-x: auto;">
<svg viewBox="0 0 800 460" width="100%" height="100%" style="max-width: 800px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display: block; margin: 0 auto;" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="seq-arrow-brand" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--vp-c-brand-1, #3b82f6)"/>
    </marker>
    <marker id="seq-arrow-green" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--vp-c-green-1, #10b981)"/>
    </marker>
  </defs>

  <!-- Lifelines -->
  <line x1="90" y1="65" x2="90" y2="430" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <line x1="245" y1="65" x2="245" y2="430" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <line x1="400" y1="65" x2="400" y2="430" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <line x1="555" y1="65" x2="555" y2="430" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />
  <line x1="710" y1="65" x2="710" y2="430" stroke="var(--vp-c-divider, #cbd5e1)" stroke-width="1.5" stroke-dasharray="4 4" />

  <!-- Participant Cards -->
  <rect x="20" y="20" width="140" height="44" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="90" y="47" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">Tab A (Writer)</text>

  <rect x="175" y="20" width="140" height="44" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="245" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">Web Locks</text>
  <text x="245" y="55" text-anchor="middle" font-size="10" fill="var(--vp-c-text-2, #64748b)">navigator.locks</text>

  <rect x="330" y="20" width="140" height="44" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="400" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">Storage</text>
  <text x="400" y="55" text-anchor="middle" font-size="10" fill="var(--vp-c-text-2, #64748b)">IDB / OPFS</text>

  <rect x="485" y="20" width="140" height="44" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-green-1, #10b981)" stroke-width="1.5" />
  <text x="555" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-green-1, #10b981)">BroadcastChannel</text>
  <text x="555" y="55" text-anchor="middle" font-size="10" fill="var(--vp-c-text-2, #64748b)">webdb_sync_*</text>

  <rect x="640" y="20" width="140" height="44" rx="8" fill="var(--vp-c-bg-elv, #ffffff)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="710" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">Tab B (Reader)</text>
  <text x="710" y="55" text-anchor="middle" font-size="10" fill="var(--vp-c-text-2, #64748b)">UI &amp; Live Queries</text>

  <!-- Step 1: Acquire Lock -->
  <line x1="90" y1="110" x2="241" y2="110" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2" marker-end="url(#seq-arrow-brand)" />
  <text x="167" y="102" text-anchor="middle" font-size="11" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">1. Acquire exclusive lock</text>

  <!-- Step 2: Write to Disk -->
  <line x1="90" y1="165" x2="396" y2="165" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2" marker-end="url(#seq-arrow-brand)" />
  <text x="245" y="157" text-anchor="middle" font-size="11" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">2. Write WAL frames &amp; commit</text>

  <!-- Step 3: Release Lock -->
  <line x1="90" y1="220" x2="241" y2="220" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2" stroke-dasharray="4 4" marker-end="url(#seq-arrow-brand)" />
  <text x="167" y="212" text-anchor="middle" font-size="11" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">3. Release lock</text>

  <!-- Step 4: Broadcast -->
  <line x1="90" y1="275" x2="551" y2="275" stroke="var(--vp-c-green-1, #10b981)" stroke-width="2" marker-end="url(#seq-arrow-green)" />
  <text x="322" y="267" text-anchor="middle" font-size="11" font-weight="600" fill="var(--vp-c-green-1, #10b981)">4. postMessage({ tables: ['todos'], changeCounter: 42 })</text>

  <!-- Step 5: Notify Tab B -->
  <line x1="555" y1="330" x2="706" y2="330" stroke="var(--vp-c-green-1, #10b981)" stroke-width="2" marker-end="url(#seq-arrow-green)" />
  <text x="632" y="322" text-anchor="middle" font-size="11" font-weight="600" fill="var(--vp-c-green-1, #10b981)">5. onmessage(event)</text>

  <!-- Step 6 & 7: Tab B Invalidation & UI Update -->
  <rect x="615" y="360" width="170" height="60" rx="8" fill="var(--vp-c-bg-soft, #f8fafc)" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="1.5" />
  <text x="700" y="380" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">6. Invalidate buffer slots</text>
  <text x="700" y="396" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--vp-c-text-1, #0f172a)">7. notifySubscriptions()</text>
  <text x="700" y="411" text-anchor="middle" font-size="9.5" fill="var(--vp-c-brand-1, #3b82f6)">useLiveQuery re-evaluates</text>
</svg>
</div>

1. **Broadcast Message**:
   Upon committing, Tab A broadcasts:
   ```json
   {
     "senderId": "tab_x89a",
     "tables": ["todos"],
     "changeCounter": 42,
     "schemaVersion": 3,
     "origin": "local"
   }
   ```
2. **Selective Live Query Re-Execution**:
   Tab B receives the message, ignores it if `senderId === this.instanceId`, and notifies its reactive subscriptions.
   Only the live queries observing the modified tables (`todos`) re-run. Queries observing unaffected tables (`settings`, `users`) do not re-run, conserving battery and CPU.

---

## 7. Schema Upgrades Across Tabs Running Different App Versions

In real-world web apps, a user may have Tab B open on an older release while Tab A loads a newly deployed version that triggers schema migrations:

### How WebDB Handles Version Drift:
1. **Additive Changes (`ADD COLUMN`)**:
   WebDB's slotted page record serializer encodes variable-length offset tables and null bitmaps. If Tab A adds a column and writes new rows, Tab B (reading with the old column schema) cleanly reads the known columns and ignores trailing payload bytes.
2. **Backward Compatibility for Existing Rows**:
   Rows stored on disk before a new column was added evaluate to `NULL` (or their default values) without requiring an immediate, expensive whole-table rewrite.
3. **In-Flight Isolation**:
   When Tab A runs `Migrator.up()`, the entire migration executes inside an exclusive transaction protected by the cross-tab lock. Tab B cannot read half-migrated tables or broken indexes.

### Detecting Migrations in the Application Layer
You can listen to cross-tab schema sync events on the `WebDB` instance to prompt the user to refresh the older tab:

```ts
const db = await WebDB.open({ name: 'myapp', storage: 'idb' });

// Track the schema version when this tab loaded
const initialSchemaVersion = db.getSyncState().schemaVersion;

// Listen for cross-tab updates
db.onSync((event) => {
  if (event.schemaVersion > initialSchemaVersion) {
    showBanner('A new app version was deployed in another tab. Click to refresh.', {
      onClick: () => window.location.reload(),
    });
  }
});
```

---

## 8. WebDB vs. Native IndexedDB: Multi-Tab Comparison

Developers frequently ask how WebDB's multi-tab coordination compares to the browser's native IndexedDB API. While both operate within browser constraints, their internal models and developer ergonomics differ fundamentally:

| Feature | Native IndexedDB | WebDB |
| :--- | :--- | :--- |
| **Execution Architecture** | Managed by browser's background storage daemon (LevelDB/SQLite via IPC) | Embedded C/Wasm engine inside each tab sharing disk storage |
| **Locking Mechanism** | Internal engine locks on object stores (`readonly` vs `readwrite`) | Browser `navigator.locks` API coordinated across tabs |
| **Write Concurrency** | Queued per object store across tabs by browser process | Single exclusive write lock during WAL commit; zero IPC overhead during reads |
| **Cross-Tab Reactivity** | ❌ **None**. Tab B has no native way to know Tab A modified data | ✅ **Built-in**. `BroadcastChannel` invalidates buffer cache & auto-triggers `useLiveQuery` |
| **Schema Upgrades** | ⚠️ `versionchange` locks and **blocks** until all other tabs call `db.close()` | ✅ DDL is a regular atomic WAL transaction; other tabs reload catalog on the fly |
| **In-Memory Caching** | Managed inside browser process; structured-clone IPC overhead per read | In-tab buffer pool (4 MB) for zero-copy C/Wasm reads; evicted via invalidation messages |
| **Tab Crash Recovery** | Handled by browser storage process | Lock released immediately by browser; WAL recovered automatically by next reader/writer |

### 1. Schema Upgrades: The "Blocked Tab" Trap
In native IndexedDB, upgrading a database schema requires calling `indexedDB.open(dbName, newVersion)`. When this happens:
- The browser fires a `versionchange` event on every other open connection in other tabs.
- The upgrade transaction in the upgrading tab is **completely blocked** until all other tabs either invoke `db.close()` or close their window.
- If a dormant or background tab fails to handle `versionchange`, the upgrading tab fires an `onblocked` event and hangs indefinitely.

In WebDB, schema alterations (`createTable`, `alterTable`, `createIndex`) are **standard atomic transactions** executed under the Web Locks API:
- The migrating tab acquires the exclusive write lock, writes the new catalog page / WAL frame, increments the monotonic `schemaVersion`, and releases the lock.
- It broadcasts `{ schemaVersion: N, tables: [...] }` over `BroadcastChannel`.
- Other tabs receive the message, invalidate their in-memory catalog cache, and reload the schema on their next query. **No tab ever has to close, and user workflows are never blocked.**

### 2. Cross-Tab Reactivity & Live Queries
- **Native IndexedDB**: Does not offer mutation streams or reactive query invalidation across tabs. If Tab A inserts a record, Tab B continues to show stale UI until the user reloads the page or the developer builds custom pub/sub plumbing using `BroadcastChannel` or `localStorage`.
- **WebDB**: Reactivity is built directly into the engine. Every committed transaction broadcasts affected table names and monotonic counters. Reactive hooks like `useLiveQuery("SELECT * FROM todos")` running in Tab B detect that `todos` changed, evict dirty pages from their local buffer pool, and re-execute immediately.

### 3. In-Memory Cache Coherence
- **Native IndexedDB**: Queries must deserialize data structures via structured cloning across the browser's process boundary, adding latency on every read.
- **WebDB**: Executes queries directly against an in-tab C/Wasm buffer pool (1024 slots / 4 MB) with microsecond response times. Cache coherence is maintained across tabs by evicting buffer slots when a remote `changeCounter` invalidation is received.

### 4. Crash Resilience & Stale Locks
- **Native IndexedDB**: Transactions are coordinated within the browser binary. If a tab crashes, the browser process aborts its active transaction.
- **WebDB**: Relies on the W3C standard **Web Locks API** (`navigator.locks`). If a writing tab crashes or is closed mid-transaction, the browser's lock manager **instantly drops the lock reservation**. The next tab opening a connection verifies the WAL header on disk, rolling forward or truncating uncommitted frames automatically.

---

## 9. Summary of Guarantees

| Requirement | WebDB Mechanism | Guarantee |
| :--- | :--- | :--- |
| **Write Serialization** | `navigator.locks` | No concurrent writes can corrupt pages or WAL frames. |
| **Deadlock Immunity** | OS-level browser Web Locks | If a tab crashes or is closed, lock releases within 5ms. |
| **Cache Invalidation** | Page 1 `changeCounter` + slot reset | Stale page data is never read across tab boundaries. |
| **Reactive Sync** | `BroadcastChannel` | Multi-tab UI state updates automatically in sub-millisecond time. |
| **Schema Isolation** | Page 1 `schemaVersion` + catalog reload | DDL upgrades invalidate catalog caches safely across tabs. |

