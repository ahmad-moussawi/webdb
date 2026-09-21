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

## 3. Memory Mutation, Commit & Rollback Lifecycles

### 3.1 `BEGIN` Phase
1. JS Host acquires the Exclusive Transaction Lease.
2. Snapshots the current `dirty_mask` and records the current length of the `.wal` log file.
3. Allocates a monotonic Transaction ID (`tx_id`).

### 3.2 Mutation & Cache Spilling Phase
1. When `tx.insert()` or `tx.update()` executes, the engine modifies 4KB slots in memory and sets the corresponding bits in `dirty_mask`.
2. **Uncommitted Cache Spilling (Under Cache Pressure):**
   - If memory pressure requires evicting an uncommitted dirty slot, the slot is written to the `.wal` file with a header marked `TX_UNCOMMITTED`.
   - The slot is then freed for the incoming page.

### 3.3 `COMMIT` Phase
1. Host JS appends all remaining modified memory slots (`dirty_mask` bits) to the `.wal` file.
2. Writes a synchronous `TX_COMMIT` record to the WAL containing `tx_id` and a monotonic Log Sequence Number (LSN).
3. Calls `walSyncHandle.flush()` (or commits IDB transaction).
4. **Durable Point:** The transaction is now permanently committed. If the browser tab crashes 1 ms later, recovery will replay these frames.
5. Releases the Exclusive Transaction Lease.

### 3.4 `ROLLBACK` Phase (On Error or Abort)
1. Discards all uncommitted changes in memory by clearing the dirty bits in `dirty_mask` and resetting `slot_to_page` for those slots.
2. If uncommitted pages were spilled to the WAL during the transaction, truncates the WAL file back to the snapshot offset recorded at `BEGIN`.
3. Releases the Exclusive Transaction Lease.
4. **Zero Main DB Mutation:** Not a single uncommitted byte ever touches the main `.db` file.

---

## 4. Deduplicated Monotonic Checkpoint Specification

Without checkpointing, the `.wal` file would grow indefinitely. The Host coordinates bounded checkpointing to sync the main `.db` file:

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
Step 1: Scan committed WAL frames chronologically
        wal_index.set(page_id, latest_frame_offset)
                               │
Step 2: Inspect resident dirty slots in wasmMemory (dirty_mask)
        memory_override.set(page_id, slot_idx)
                               │
Step 3: Apply union of unique page_ids to main .db file:
        For each page_id:
          If in memory_override:
            Write directly from memory slot to db_offset (page_id * 4096)
            Clear dirty_mask bit
          Else:
            Read 4KB from wal_index offset -> Write to db_offset (page_id * 4096)
                               │
Step 4: dbSyncHandle.flush() (All pages durably committed to main disk)
                               │
Step 5: walSyncHandle.truncate(0) (Reset WAL to 0 bytes)
```

- **Guarantee:** Every page is written to disk exactly **once** with its latest committed bytes. Older WAL copies of the same page are deduplicated and skipped.

---

## 5. Crash Recovery Protocol (On Startup)

When opening a database (`WebDB.open()`):
1. JS opens `.db` and `.wal` files.
2. If `.wal` file size is `0`, database is clean; startup completes immediately.
3. If `.wal` contains frames:
   - Host scans the WAL from beginning to end, grouping frames by `tx_id`.
   - Scans for matching `TX_COMMIT` markers.
   - Any transaction lacking a `TX_COMMIT` marker (e.g. from an abrupt tab crash mid-transaction) is declared **ABORTED**; its frames are discarded.
   - All committed frames are applied to the main `.db` file in chronological order using the Deduplicated Apply algorithm.
   - Calls `dbSyncHandle.flush()` and truncates the WAL to 0 bytes.
   - **Result:** Complete crash recovery in < 10 ms.

---

## 6. Exhaustive Edge Cases & Failure Modes

* [ ] **Mid-Transaction Checkpoint Leak Prevention:** Assert that calling `db.checkpoint()` while inside `db.transaction()` does not execute until `COMMIT` or `ROLLBACK`.
* [ ] **Stale Frame Regression Guard:** Assert that if page 2 was modified, spilled to WAL as frame 1, modified again in memory, and checkpoint runs, page 2 on disk receives the in-memory version (not frame 1).
* [ ] **Partial WAL Frame Crash:** If the browser terminates midway through writing a 4KB WAL frame, the recovery scanner must detect the truncated frame via CRC32 checksum, discard it, and recover preceding committed transactions cleanly.
* [ ] **Double Rollback Safety:** Calling `ROLLBACK` multiple times or after an error must be idempotent and safe.

---

## 7. Verification & Test Suite (`tests/transactions_wal.test.ts`)

1. **Atomic Rollback:** Insert 50 rows; throw an intentional error; assert 0 rows exist in the table.
2. **Deduplicated Checkpoint Verification:** Modify page 5 ten times in separate transactions; trigger checkpoint; assert page 5 is written to `.db` exactly once with final values.
3. **Crash Recovery Simulation:** Construct a `.wal` file with 2 committed transactions and 1 uncommitted transaction; open DB; assert only the 2 committed transactions are applied.
