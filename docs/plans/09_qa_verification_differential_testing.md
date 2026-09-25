# Phase 9 Technical Specification: Quality Assurance, Verification & Differential Testing

## 1. Executive Summary & Testing Philosophy

To guarantee database reliability, WebDB utilizes a **Three-Tier Verification Pyramid**:
1. **Differential Testing (V1 JS $\leftrightarrow$ V2 C/Wasm):** Automatically validates that the JavaScript Reference Engine and the C/Wasm Drop-in Engine produce 100% bitwise identical binary pages and results.
2. **Native C Sanitizer Testing (ASan / UBSan):** Compiles the C core natively on host architectures with AddressSanitizer and UndefinedBehaviorSanitizer to catch memory bounds violations, use-after-free, and unaligned access.
3. **Real-Browser E2E Multi-Process Testing (Playwright):** Exercises real browser storage engines (OPFS sync handles, IndexedDB, SharedWorker, and Web Locks leader failover) across Chromium, Firefox, and WebKit / Safari.

---

## 2. Differential Testing Architecture (V1 $\leftrightarrow$ V2)

Because both engines adhere to the identical memory contract:

```
                  ┌─────────────────────────────────────────┐
                  │           Test Case Definition          │
                  │   (e.g., Insert 1,000 rows + Split)     │
                  └────────────────────┬────────────────────┘
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
         ┌─────────────────────────┐       ┌─────────────────────────┐
         │   V1 Reference Engine   │       │   V2 C / Wasm Engine    │
         │  (ArrayBuffer / JS VM)  │       │  (Wasm Memory / C VM)   │
         └────────────┬────────────┘       └────────────┬────────────┘
                      │                                 │
                      ▼                                 ▼
             Binary Memory State               Binary Memory State
                      │                                 │
                      └────────────────┬────────────────┘
                                       │
                                       ▼
                     [Bitwise Memory Comparator Assertions]
                     1. Slotted Page bytes match bit-for-bit
                     2. B+Tree split keys and root pages match
                     3. Output Result Buffer chunks match
                     4. VmStatus yield instruction points match
```

---

## 3. C Engine Unit Testing: Framework & Tooling

- **Framework:** **Unity** ([ThrowTheSwitch/Unity](https://github.com/ThrowTheSwitch/Unity)), the industry-standard zero-dependency unit testing framework for freestanding C.
- **Native Host Execution with Sanitizers:** C test suites compile and execute natively on macOS/Linux using Clang with **AddressSanitizer (ASan)** and **UndefinedBehaviorSanitizer (UBSan)**:
  ```bash
  clang -fsanitize=address,undefined -g tests/c/test_btree.c src/c/*.c \
    -Isrc/c -o build/c_test_runner && ./build/c_test_runner
  ```
- **Guarantees:** Catches off-by-one errors, buffer overruns in slotted pages, memory leaks in the query arena, and unaligned pointer casting instantly.

---

## 4. Exhaustive C Engine Edge Cases Checklist

### A. Slotted Page & Row Format
* [ ] **Exact 2048-Byte Boundary:** Inserting a row of exactly 2048 bytes succeeds; inserting 2049 bytes throws `RowSizeLimitExceededError`.
* [ ] **Zero-Byte Page Saturation:** Inserting rows until contiguous free space between slot directory and row data reaches exactly 0 bytes remaining.
* [ ] **Slot Defragmentation / Compaction:** Deleting alternating rows to fragment page space; inserting a new row that fits only after compacting the page.
* [ ] **Dynamic Null-Bitmap Scaling:** Verify bitwise null-checking for tables with 1, 8, 9, 16, 64, 100, and 256 columns (rejecting > 256 with `TooManyColumnsError`) without offset drift.
* [ ] **Corrupted Slot Directory:** Rejecting corrupt slot offsets pointing outside page boundaries.

### B. B+Tree Structure & Splitting
* [ ] **Sequential Ascending Insertions:** Insert keys `1..1000` (stresses right-leaning B-tree splits).
* [ ] **Sequential Descending Insertions:** Insert keys `1000..1` (stresses left-leaning B-tree splits).
* [ ] **Random/Hashed Keys:** Insert 5,000 pseudo-random keys (stresses balanced median page splits).
* [ ] **Root Page Splitting:** Verify root page split increments B-tree height (level 1 to 2, 2 to 3) and updates `TableDescriptor.root_page_id`.
* [ ] **Key Deletion & Underflow:** Deleting keys causing page underflow; verify sibling key borrowing and page merging.
* [ ] **Deep Cursor Traversal:** Iterative cursor descending 4 levels and traversing forward and backward across leaf sibling pointers.

### C. State Machine & Resumability (Page Faults & Chunking)
* [ ] **Interrupted Index Seek:** Trigger `STATUS_PAGE_FAULT` midway through traversing child pages; save `VmContext`; inject page into slot; verify `vm_step()` resumes at exact position without restarting the seek.
* [ ] **Interrupted Nested Loop Join:** Trigger `STATUS_PAGE_FAULT` during inner table scan; verify outer loop cursor maintains row position upon resume.
* [ ] **Result Buffer Chunking:** Emit 5,000 rows through a 64KB buffer; verify `STATUS_BUFFER_FULL` yields cleanly, JS drains chunk, resets buffer offset, and resume produces remaining rows with zero duplicates.

### D. Transient Query Arena & Growable Hash Table
* [ ] **Dynamic Hash Table Doubling:** Insert unique group keys past the 70% load factor threshold; verify table cleanly doubles capacity and re-hashes without corrupting existing entries.
* [ ] **Arena OOM Ceiling (Fail-Fast):** Pathological `GROUP BY` exceeding the 16 MB arena ceiling cleanly halts and yields `STATUS_ERR_ARENA_EXHAUSTED` (zero silent truncation).
* [ ] **Zero-Leak Arena Reset:** Assert `arena_offset = 0` reclaims 100% of transient allocations under ASan.

### E. Datatypes & SQLite-Compatible NULL Semantics
* [ ] **Standard Comparisons Yield Unknown:** Verify `SELECT WHERE col = NULL` and `WHERE col != NULL` match 0 rows under 3VL logic.
* [ ] **`NULL = NULL` Inequality in Filters & Joins:** Assert joining or filtering on `a.col = b.col` skips rows where both values are `NULL`.
* [ ] **`IS NULL` and `IS NOT NULL` Selectivity:** Verify `OP_IS_NULL` and `OP_IS_NOT_NULL` accurately filter nullable rows based on the Page Null-Bitmap.
* [ ] **SQLite `IS` Distinctness Match:** Assert `a IS b` evaluates to true when both values are `NULL`, and false when only one is `NULL`.
* [ ] **B-Tree NULL Ordering Precedence:** Verify index traversal and `ORDER BY col ASC` returns `NULL` keys before all numeric, text, and blob values (`ORDER BY col DESC` returns `NULL`s last).
* [ ] **Multiple NULLs in UNIQUE Indexes:** Insert multiple records with `NULL` in a unique column; assert all succeed without uniqueness violations.
* [ ] **`NOT NULL` Constraint Violation:** Attempt to insert `NULL` into a column flagged with `0x02` (`NOT NULL`); assert immediate fail-fast `NotNullConstraintError`.
* [ ] **Aggregate NULL Elimination:** Verify `COUNT(*)` counts all rows while `COUNT(col)` excludes nulls; verify `SUM(col)` on an all-null group returns `NULL`.
* [ ] **Zero-Payload NULL Storage Verification:** Inspect raw page byte slices to confirm null columns occupy zero bytes in the data section.

---

## 5. JavaScript Host Integration Testing (`Vitest`)

- **Framework:** **Vitest** for blazing-fast TypeScript unit and integration testing.
- **Coverage Areas:**
  - Fluent Builder $\to$ Bytecode Compiler opcode validation.
  - Binary Master Table encoding/decoding onto Page 1.
  - Unified `IVfsAdapter` contract suite across OPFS and `fake-indexeddb`.
  - Cache Controller pinning invariant (asserting live cursor slots are never evicted).
  - Deduplicated WAL checkpoint apply algorithm.
  - Synchronous UDF invocation and error propagation.

---

## 6. Real-Browser End-to-End Testing (`Playwright`)

- **Framework:** **Playwright** automated across Chromium, Firefox, and WebKit / Safari.
- **Critical Test Scenarios:**
  1. **OPFS Worker Persistence:** Spawn worker, insert 10,000 rows, close, kill worker, reopen in new worker, assert all data intact.
  2. **IndexedDB First-Class Parity:** 10,000-row inserts, multi-statement transaction rollback, batched atomic page writes, and WAL compaction in IndexedDB.
  3. **Multi-Tab Chaos Failover:** Spawn 3 concurrent tabs; fire concurrent interleaved transactions; abruptly close the Leader tab mid-write; assert follower tab promotes to Leader in $< 10$ ms and completes all queries without data corruption.
  4. **High-Throughput Concurrency:** `Promise.all([ ...500 concurrent queries... ])` ensuring zero race conditions or deadlocks.
  5. **Dirty Termination & WAL Crash Recovery:** Abruptly terminate worker before `COMMIT`; reopen; assert uncommitted frames cleanly discarded and main DB remains consistent.

---

## 7. CI/CD Automated Regression Gates

Every Pull Request must pass three automated pipeline gates before merging:
1. `npm test` (All Vitest unit & integration suites pass).
2. `npm run test:c` (Native Clang ASan/UBSan suites pass with 0 errors and 0 memory leaks).
3. `npm run test:e2e` (Playwright browser suites pass across Chromium, Firefox, and WebKit).
