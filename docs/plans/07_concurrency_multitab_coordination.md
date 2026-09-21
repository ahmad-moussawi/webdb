# Phase 7 Technical Specification: Concurrency, Multi-Tab & Multi-Worker Coordination

## 1. Executive Summary & The Multi-Tab Problem

In a browser environment, multiple open tabs or Web Workers within the same origin frequently access the same database simultaneously. This creates two catastrophic failure modes if not properly architected:

1. **The OPFS Lock Exclusivity Invariant:** Calling `createSyncAccessHandle()` locks the underlying file exclusively to a single Web Worker. If Tab A and Tab B attempt to open the same OPFS file, the browser immediately throws `NoModificationAllowedError`.
2. **Cache Incoherence & Split-Brain Memory:** Each browser tab has an entirely separate JavaScript heap and `WebAssembly.Memory`. If two tabs open the same database independently (even under IndexedDB), Tab A's in-memory 4MB page cache has zero visibility into Tab B's uncommitted or newly committed pages, leading to lost updates and severe database corruption.

---

## 2. The Core Architecture: Single Active Engine Server + Thin Client Proxy

To guarantee absolute memory coherence and satisfy storage lock invariants, **exactly one active instance of the WebDB engine (holding the 4MB page cache, `WebAssembly.Memory`, and storage handles) runs per database origin**:

```
[Browser Tab 1] ──(WebDBClient Proxy)──┐
                                       ├──► [RPC / MessagePort] ──► [Single Active WebDBServer]
[Browser Tab 2] ──(WebDBClient Proxy)──┤                             ├── 4MB Shared Page Cache
                                       │                             ├── Single JS Async FIFO Queue
[Dedicated Web Worker] ────────────────┘                             └── Exclusive IVfsAdapter (OPFS / IDB)
```

WebDB transparently coordinates this using a **Two-Tier Architecture**:

```
                              ┌─────────────────────────────────────────┐
                              │           WebDB.open(options)           │
                              └────────────────────┬────────────────────┘
                                                   │
                                    Does runtime support SharedWorker?
                                                   │
                              ┌────────────────────┴────────────────────┐
                             YES                                       NO
                              │                                         │
                 ┌────────────▼────────────┐              ┌─────────────▼────────────┐
                 │   Tier 1: SharedWorker  │              │    Tier 2: Web Locks     │
                 │       Coordinator       │              │     Leader Election      │
                 └─────────────────────────┘              └──────────────────────────┘
```

---

## 3. Tier 1: `SharedWorker` Coordinator (Preferred / Evergreen)

Supported natively in desktop Chrome, Firefox, Safari (macOS 16+), and Edge:

1. **Connection:** When `WebDB.open()` is called, the client connects to a background `SharedWorker`:
   ```typescript
   const worker = new SharedWorker(new URL('./webdb-worker.js', import.meta.url), { name: `webdb_${dbName}` });
   const client = new WebDBClient(worker.port);
   ```
2. **Unified State:** The `SharedWorker` hosts the sole instance of `WebDBServer`, holding:
   - The 4MB in-memory slotted page cache.
   - The single active `VmContext`.
   - The exclusive OPFS `FileSystemSyncAccessHandle` or IndexedDB connection.
3. **RPC Communication:** Client tabs serialize query ASTs and parameters across `MessagePort`. The server executes queries through its single async FIFO queue and streams hydrated row chunks back to the client port.
4. **Zero Contention & Automatic Lifecycle:** No locking is required. The `SharedWorker` lives as long as at least one tab is open and is cleanly reaped by the browser when all tabs close.

---

## 4. Tier 2: `navigator.locks` Leader Election (Universal Fallback)

For environments where `SharedWorker` is unsupported or restricted (e.g. Safari on iOS, Android Chrome, third-party iframes, or non-worker main threads), WebDB implements **Web Locks API Leader Election**:

### 4.1 Leader Lock Acquisition Flow
When any tab calls `WebDB.open({ name: 'app_db' })`:
```typescript
navigator.locks.request(`webdb_leader_${dbName}`, async (lock) => {
  // 1. This tab is elected as the LEADER!
  const server = new WebDBServer(dbName, options);
  await server.start(); // Opens OPFS/IDB, mounts 4MB cache & VM

  // 2. Listen for RPC requests from follower tabs
  const channel = new BroadcastChannel(`webdb_rpc_${dbName}`);
  server.bindChannel(channel);

  // 3. Hold the lock until the tab unloads or closes
  await server.keepAlivePromise;
});
```

### 4.2 Follower Tab Behavior
- Follower tabs query `navigator.locks.query()`. If the leader lock is held, follower tabs instantiate `WebDBClient` and communicate via `BroadcastChannel` or `MessageChannel`.
- Follower tabs expose the identical `db.from(...).where(...)` Fluent API, awaiting results seamlessly.

### 4.3 Sub-5ms Instant Leader Failover
1. If the user closes, refreshes, or navigates away from the Leader tab:
   - The browser runtime **automatically and atomically releases the Web Lock in under 5 milliseconds**.
2. The next waiting follower tab in `navigator.locks.request` is instantly granted the lock and promoted to **Leader**.
3. The new Leader tab:
   - Opens the storage handles.
   - Replays the `.wal` log to ensure crash consistency.
   - Binds the `BroadcastChannel` RPC server.
   - Broadcasts a `LEADER_CHANGED` announcement to all remaining follower tabs.
4. Follower tabs resend any unacknowledged in-flight queries to the new Leader without application-level exceptions or dropped connections.

---

## 5. Cross-Tab ACID Transaction Guarantees

When a tab executes `await db.transaction(async (tx) => { ... })`:
1. The transaction request is enqueued in the Leader/SharedWorker’s Async FIFO Queue.
2. The coordinator assigns the **Exclusive Transaction Lease** to that transaction channel.
3. All queries from other tabs wait non-blocking in the FIFO queue until the transaction issues `COMMIT` or `ROLLBACK`.
4. This delivers **Global ACID Serializability** across all open tabs simultaneously.

---

## 6. Exhaustive Edge Cases & Failure Modes

* [ ] **Sudden Leader Tab Crash Mid-Transaction:** If the leader tab closes during an uncommitted transaction:
  - The new leader detects incomplete WAL frames on boot, triggers atomic rollback, restores database consistency, and notifies follower tabs.
* [ ] **Partition Split-Brain Guard:** Web Locks guarantee that at most **one** tab can hold `webdb_leader_${dbName}` at any given microsecond, preventing split-brain memory.
* [ ] **Stale Follower Query Retries:** In-flight queries interrupted by leader promotion must automatically retry on the new leader up to 3 times before throwing.

---

## 7. Verification & Test Suite (`tests/multitab_coordination.test.ts`)

1. **SharedWorker RPC Protocol:** Test client-to-server query compilation and streaming row delivery over `MessagePort`.
2. **Web Locks Election:** Simulate 3 concurrent browser contexts; assert 1 context acquires Leader and 2 operate as Followers.
3. **Chaos Failover Simulation:** Abruptly terminate the Leader context; assert next context is promoted in $< 10$ ms and completes pending follower queries.
