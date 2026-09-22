# Phase 4 Technical Specification: Transaction Lifecycle, ACID Rollback & WAL Checkpointing

## 1. Executive Summary

WebDB delivers full **ACID (Atomicity, Consistency, Isolation, Durability)** compliance across asynchronous browser boundaries. Because WebAssembly cannot manage asynchronous microtasks or timer events directly, the **Transaction Coordinator and Write-Ahead Log (WAL)** are orchestrated entirely by the JavaScript Host Layer, while the Engine Core provides the raw memory mutation primitives.

---

## 2. The Exclusive Transaction Lease

In modern web applications, multi-statement transactions yield control to the JavaScript event loop between `await` operations:

```typescript
await db.transaction(async (tx) => {
  await tx.insert('accounts', { id: 1, balance: 100 }); // Event loop yields here
  await tx.insert('accounts', { id: 2, balance: 200 }); // Event loop yields here
});
```

### The Problem: Interleaved Corruption
If an idle timer, a non-transaction query, or an explicit `db.checkpoint()` were dispatched into the queue between those two inserts, an uncommitted dirty slot could be flushed into the main `.db` file or read by another query, violating **Atomicity and Isolation**.

### The Solution: Exclusive Transaction Lease
```
[User invokes db.transaction()] ──► Acquires Exclusive Lease on JS Async FIFO Queue
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
     Operations from active `tx` handle              External Queries / Checkpoints
            (Dispatched immediately)                    (BLOCKED: Enqueued in FIFO)
                  │                                               │
                  ▼                                               │
         `COMMIT` or `ROLLBACK`                                   │
                  │                                               │
                  ▼                                               ▼
         Lease Released ─────────────────────────────► Unblocks queued queries
```

- While a transaction is open (`in_transaction = true`), the queue **strictly dispatches only operations belonging to that active transaction**.
- All non-transaction queries and checkpoint requests remain queued until the transaction issues `COMMIT` or `ROLLBACK`.

---

## 3. Physical WAL Binary Format Specification

WebDB enforces strict binary determinism: both the WAL file and its individual frames are rigid, 8-byte-aligned C structs stored in the `.wal` file.

```
0x0000 - 0x001F (Bytes 0..31):        WalFileHeader (32 Bytes)
0x0020 - 0x103F (Bytes 32..4159):     WAL Frame 0 [32B Frame Header + 4096B Page Data]
0x1040 - 0x205F (Bytes 4160..8287):   WAL Frame 1 [32B Frame Header + 4096B Page Data]
...
Frame i Offset = 32 + (i * 4128)
```

### 3.1 WAL File Header (Bytes 0..31)
Written once when the `.wal` file is initialized or recreated:

```c
typedef struct {
    char     magic[6];       // "WEBWAL" (0x57 0x45 0x42 0x57 0x41 0x4C) (bytes 0..5)
    uint16_t wal_version;    // WAL format version (1 for V1) (bytes 6..7)
    uint32_t page_size;      // Rigid page size: 4096 (bytes 8..11)
    uint32_t checkpoint_seq; // Monotonic checkpoint counter (bytes 12..15)
    uint32_t salt1;          // Random salt generated on checkpoint (bytes 16..19)
    uint32_t salt2;          // Random salt tie-breaker (bytes 20..23)
    uint32_t checksum;       // CRC32 over bytes 0..23 (bytes 24..27)
    uint32_t reserved;       // Zero padding (bytes 28..31)
} WalFileHeader;             // Exact size: 32 bytes
```

### 3.2 WAL Frame Header (32 Bytes)
Every WAL frame consists of a **32-byte header** followed immediately by the **4096-byte page payload** (total frame size: **4,128 bytes**):

```c
typedef struct {
    uint32_t magic;         // 0x57414C46 ("WALF" = WAL Frame) (bytes 0..3)
    uint16_t frame_type;    // 1=PAGE_DATA, 2=TX_COMMIT, 3=TX_UNCOMMITTED (bytes 4..5)
    uint16_t flags;         // Reserved flags (0x0000) (bytes 6..7)
    uint32_t tx_id;         // Monotonic transaction identifier (bytes 8..11)
    uint32_t page_id;       // Target database Page ID (1..N) (bytes 12..15)
    uint32_t db_size_pages; // Size of DB in pages after commit (bytes 16..19)
    uint32_t frame_seq;     // Monotonic frame sequence counter in WAL (bytes 20..23)
    uint32_t checksum;      // CRC32 over header bytes 0..23 + 4096 page bytes (bytes 24..27)
    uint32_t reserved;      // Zero padding for 8-byte alignment (bytes 28..31)
} WalFrameHeader;           // Exact size: 32 bytes
```

* **`frame_type` values:**
  - `0x0001 (FRAME_PAGE_DATA)`: Carries a committed 4KB page mutation for `page_id`.
  - `0x0002 (FRAME_TX_COMMIT)`: Commit marker for `tx_id`. Signals that all preceding frames for this `tx_id` are permanently committed.
  - `0x0003 (FRAME_TX_UNCOMMITTED)`: Cache spill frame under memory pressure. Ignored during recovery unless followed by a commit marker.
* **Checksum Scope:** Computed over `bytes 0..23` of `WalFrameHeader` concatenated with the entire `4096` bytes of page payload. If either the header or the page payload suffers bit rot or a torn write, the CRC32 check fails.

---

## 4. Memory Mutation, Commit & Rollback Lifecycles

### 4.1 `BEGIN` Phase
1. JS Host acquires the Exclusive Transaction Lease.
2. Snapshots the current `dirty_mask` and records the current length of the `.wal` log file.
3. Allocates a monotonic Transaction ID (`tx_id`).

### 4.2 Mutation & Cache Spilling Phase
1. When `tx.insert()` or `tx.update()` executes, the engine modifies 4KB slots in memory and sets the corresponding bits in `dirty_mask`.
2. **Uncommitted Cache Spilling (Under Cache Pressure):**
   - If memory pressure requires evicting an uncommitted dirty slot, the slot is appended to the WAL via `await vfs.appendWalFrames([uncommittedFrame])` with `frame_type = FRAME_TX_UNCOMMITTED (0x0003)`.
   - The slot is then freed for the incoming page.

### 4.3 `COMMIT` Phase
1. Host JS appends all remaining modified memory slots (`dirty_mask` bits) to the WAL as `FRAME_PAGE_DATA` frames, followed immediately by a `FRAME_TX_COMMIT` record via:
   ```typescript
   await vfs.appendWalFrames([...pageFrames, commitFrame]);
   ```
2. Calls `await vfs.flushWal()` (on OPFS, calls `walHandle.flush()`; on IDB, completes the atomic write transaction).
3. **Durable Point:** The transaction is now permanently committed. If the browser tab crashes 1 ms later, recovery will replay these frames.
4. Releases the Exclusive Transaction Lease.

### 4.4 `ROLLBACK` Phase (On Error or Abort)
1. Discards all uncommitted changes in memory by clearing the dirty bits in `dirty_mask` and resetting `slot_to_page` for those slots.
2. If uncommitted pages were spilled to the WAL during the transaction, truncates the WAL back to the snapshot frame count recorded at `BEGIN`:
   ```typescript
   await vfs.truncateWal(snapshotFrameCount);
   ```
3. Releases the Exclusive Transaction Lease.
4. **Zero Main DB Mutation:** Not a single uncommitted byte ever touches the main `.db` file or `pages` store.

---

## 4. Deduplicated Monotonic Checkpoint Specification

Without checkpointing, the WAL would grow indefinitely. The Host coordinates bounded checkpointing to sync the main `.db` file:

### 4.1 Strict Checkpoint Precondition Invariant
> **Invariant:** A checkpoint **CANNOT** run while any write transaction is in-flight (`in_transaction === true`). Because checkpointing executes strictly when no transaction is open, all resident dirty slots in memory (`dirty_mask`) are **guaranteed to be committed**. Stale or uncommitted data can never leak into the main `.db` file.

### 4.2 Checkpoint Triggers:
1. **Passive Size Trigger:** Triggered at the end of a `COMMIT` whenever the WAL file exceeds **256 pages (1 MB)** or **100 write transactions**.
2. **Idle Inactivity Trigger:** Fired after 5 seconds of total write inactivity. Paused/inhibited whenever a transaction is open.
3. **Database Close (`db.close()`):** Drains active transactions, then executes a final clean checkpoint before closing file handles.
4. **Explicit Manual Call (`await db.checkpoint()`):** Enqueues in the FIFO queue and executes once the transaction lease is released.

---

### 4.3 Checkpoint Execution Algorithm (Deduplicated Apply)

To prevent stale WAL frames from regressing newer in-memory pages or overwriting newer frames of the same page:

```
Step 1: Scan committed WAL frames chronologically via vfs.readWalFrames()
        wal_index.set(page_id, latest_frame_data)
                               │
Step 2: Inspect resident dirty slots in wasmMemory (dirty_mask)
        memory_override.set(page_id, slot_idx)
                               │
Step 3: Apply union of unique page_ids to main .db file:
        pages_to_write = []
        For each page_id:
          If in memory_override:
            pages_to_write.push({ pageId: page_id, data: memory_slot })
            Clear dirty_mask bit
          Else:
            pages_to_write.push({ pageId: page_id, data: wal_index.get(page_id) })
        await vfs.writePages(pages_to_write)
                               │
Step 4: await vfs.flush() (All pages durably committed to main disk)
                               │
Step 5: await vfs.truncateWal(0) (Reset WAL to 0 bytes / empty store)
```

- **Guarantee:** Every page is written to disk exactly **once** with its latest committed bytes. Older WAL copies of the same page are deduplicated and skipped.

---

## 5. Master Page (Page 1) Failover & Crash Resilience via WAL

Rather than requiring complex ping-pong pages or separate shadow metadata structures, WebDB protects **Page 1 (Database Header & Binary Schema Catalog)** by treating it **uniformly as a regular page (`page_id = 1`) under the WAL protocol**.

### 5.1 Invariants Protecting Page 1
1. **Uniform WAL Write-Ahead:**
   - Any schema mutation (`CREATE TABLE`), allocation change (`total_pages`, `free_page_head`), or transaction counter increment (`change_counter`) mutates Page 1 in memory and appends a 4KB frame to the WAL on commit via `vfs.appendWalFrames()`.
   - Page 1 in the main `.db` file is **never modified during an active transaction**.
2. **Two-Phase Checkpoint Ordering Invariant:**
   - During checkpointing, Page 1 is written to `.db` along with data pages via `vfs.writePages()`, followed immediately by `await vfs.flush()`.
   - **`await vfs.truncateWal(0)` is executed strictly AFTER `await vfs.flush()` returns successfully.** The WAL acts as the durable failover copy throughout the checkpoint write.
3. **Startup WAL-First Priority:**
   - On `WebDB.open()`, the engine scans and replays the WAL **before reading or validating Page 1 from the main `.db` file**.

### 5.2 Failure Analysis Matrix: Crash at Any Point

| Crash Point | State of `.db` | State of `.wal` | Recovery on Startup |
| :--- | :--- | :--- | :--- |
| **Mid-transaction (before commit)** | Untouched (valid previous state) | Incomplete frame (no `TX_COMMIT` marker) | Recovery scanner detects missing `TX_COMMIT`; discards incomplete frames. Page 1 and data pages in `.db` remain 100% clean and valid. |
| **After commit, before checkpoint** | Older committed state | Contains committed frames (with Page 1 and `TX_COMMIT`) | Recovery replays committed WAL frames into `.db` via `vfs.writePages()`, calls `await vfs.flush()`, and truncates the WAL cleanly via `await vfs.truncateWal(0)`. |
| **Mid-checkpoint (torn write to Page 1 or data in `.db`)** | **Torn / Corrupted** (detected by CRC32 mismatch) | **Intact committed frames** (WAL not yet truncated) | Recovery runs *before* trusting `.db`. CRC32 verifies intact WAL frames and replays Page 1 and data pages cleanly into `.db`, healing the torn page. |
| **After checkpoint `flush()`, during WAL truncate** | **Valid & Durably Synced** | Partially truncated or empty | Since `flush()` already succeeded, `.db` contains the latest valid data. Startup cleanly resets any trailing WAL bytes and opens immediately. |
| **After full checkpoint completion** | Valid & Durably Synced | Truncated (0 bytes) | Fast-path startup: WAL is clean, DB opens directly from `.db`. |

---

## 6. Crash Recovery Protocol & Truncated Frame Scanner Algorithm

When opening a database (`WebDB.open()`):
1. JS initializes `vfs = await createVfsAdapter(...)`.
2. Inspects `const frameCount = await vfs.getWalFrameCount()`. If `frameCount === 0`, database is clean; startup completes immediately.
3. If WAL contains frames:
   - **Step 1: Validate WAL File Header:** Calls `await vfs.readWalHeader()`. Verifies `magic == "WEBWAL"` and validates `checksum`. If corrupted, throws `CorruptWalHeaderError`.
   - **Step 2: Linear Frame Iteration:** Reads frames via `await vfs.readWalFrames(0, frameCount)` in chunks of **4,128 bytes**:
     - **Truncated Tail Detection:** If remaining bytes $< 4128$, an abrupt crash interrupted frame writing $\to$ **halt scanning immediately** and discard trailing bytes.
     - **Magic Verification:** Assert `header.magic == 0x57414C46 ("WALF")`. If mismatched, halt scanning.
     - **CRC32 Torn Frame Verification:** Compute CRC32 across `header[0..23]` concatenated with the `4096` page payload bytes. If `computed !== header.checksum`, a torn write occurred $\to$ **halt scanning immediately** and ignore the corrupted frame and any subsequent bytes.
     - **Record Valid Frame:** Store valid frame in `wal_index` grouped by `tx_id`.
   - **Step 3: Transaction Commit Filter:**
     - For each transaction group `tx_id`, check if a frame with `frame_type == 0x0002 (FRAME_TX_COMMIT)` was recorded.
     - Any transaction group lacking `FRAME_TX_COMMIT` (e.g. from a mid-transaction crash) is marked **ABORTED**; all its frames are discarded.
   - **Step 4: Deduplicated Apply:**
     - All frames from **COMMITTED** transactions are replayed into the main storage using `await vfs.writePages(...)` (including Page 1).
   - **Step 5: Flush & Truncate:**
     - Calls `await vfs.flush()` to guarantee all replayed pages are durably written to disk.
     - Calls `await vfs.truncateWal(0)` to reset the WAL log to 0 bytes / clear stores.
   - **Result:** Complete crash recovery in < 10 ms with 100% immunity to torn tail writes.

---

## 7. Exhaustive Edge Cases & Failure Modes

* [ ] **Mid-Transaction Checkpoint Leak Prevention:** Assert that calling `db.checkpoint()` while inside `db.transaction()` does not execute until `COMMIT` or `ROLLBACK`.
* [ ] **Stale Frame Regression Guard:** Assert that if page 2 was modified, spilled to WAL as frame 1, modified again in memory, and checkpoint runs, page 2 on disk receives the in-memory version (not frame 1).
* [ ] **WAL Tail Truncation Detection:** Verify that if the `.wal` file has trailing bytes $< 4128$ bytes, recovery halts cleanly and ignores the partial tail without throwing.
* [ ] **Bit-Rot & Torn Frame CRC32 Check:** Corrupting 1 bit in a WAL frame header or payload causes CRC32 mismatch, causing scanner to stop cleanly at that point.
* [ ] **Uncommitted Transaction Discard:** Verify that frames for transactions lacking `FRAME_TX_COMMIT` are never applied to the main `.db` file.
* [ ] **Torn Master Page Self-Healing:** Simulate crash during checkpoint while writing Page 1 to disk; verify startup recovery replays intact Page 1 from WAL and clears corruption.
* [ ] **WAL Flush Precedence:** Assert that `walSyncHandle.truncate(0)` is strictly never called if `dbSyncHandle.flush()` fails or is aborted.
* [ ] **Double Rollback Safety:** Calling `ROLLBACK` multiple times or after an error must be idempotent and safe.

---

## 8. Verification & Test Suite (`tests/transactions_wal.test.ts`)

1. **Atomic Rollback:** Insert 50 rows; throw an intentional error; assert 0 rows exist in the table.
2. **Deduplicated Checkpoint Verification:** Modify page 5 ten times in separate transactions; trigger checkpoint; assert page 5 is written to `.db` exactly once with final values.
3. **Crash Recovery Simulation:** Construct a `.wal` file with 2 committed transactions and 1 uncommitted transaction; open DB; assert only the 2 committed transactions are applied.
4. **Master Page Torn-Write Healing:** Simulate a half-written/corrupt Page 1 in `.db` alongside an intact committed Page 1 in `.wal`; open DB; assert Page 1 is restored with valid CRC32, schema catalog, and change counter.
5. **Truncated Tail Frame Recovery:** Write 1 committed transaction (2 frames) and a half-written 3rd frame (2000 bytes truncated); open DB; assert the committed transaction is applied, the partial frame is ignored, and DB is clean.
6. **Torn WAL Frame Rejection:** Flip a bit in the CRC32 or payload of a WAL frame; verify recovery rejects the torn frame and avoids corrupting `.db`.
