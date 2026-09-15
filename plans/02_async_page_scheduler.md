# Phase 2: Host-Driven Async Page Scheduler and Page Store

## Goal

Introduce a host-driven asynchronous page protocol for WebAssembly. The C++ core must be able to pause an operation when a required page is absent, return the required page IDs to the JavaScript host, accept supplied 4 KiB pages, and pause again when dirty pages require durable flushing.

This milestone establishes the protocol and a deterministic test implementation. It does not make the current mock SQL engine persist table data or provide transactional recovery for in-place Phase 1 page updates.

Phase 2 coordinates page reads and page-batch flushes only. Atomic publication of master metadata and recoverable commit generations remain Phase 4 work.

## Current Starting Point

- Phase 1 provides fixed-size page formats, `IPageAccessor`, dual master-page publication, and table heaps.
- `IPageAccessor` is synchronous and returns a mutable page pointer, so it cannot be exposed directly to IndexedDB.
- `wasm/bindings.cpp` exports only `SqlEngine::executeQuery`; there is no operation registry, scheduler, or JavaScript worker.
- There is no TypeScript package or browser-storage implementation in this repository yet.

## Scope

### Included

1. A C++ scheduler state machine and operation registry.
2. A resident-page cache owned by each operation, with explicit dirty tracking.
3. A host-facing WASM API for starting, stepping, supplying pages, collecting dirty pages, completing flushes, and cancellation.
4. A TypeScript protocol contract and a worker-side scheduler adapter.
5. An in-memory asynchronous page-store implementation for deterministic native and WASM protocol tests.
6. An IndexedDB page-store implementation behind the same host protocol.

### Deferred

- Shared buffer pool, eviction, pin accounting, prefetch, and concurrent-operation request deduplication. Those belong to Phase 3.
- OPFS implementation beyond a documented adapter contract.
- Query execution, catalog persistence, structured Plan IR execution, and master-page publication.
- WAL, copy-on-write data pages, and recoverable atomic DML. Phase 1 data pages remain non-transactional.

## Design Decisions

### Operation ownership

Each operation owns its resident page map and dirty-page list in Phase 2. This keeps pause/resume behavior deterministic and prevents the scheduler API from depending on the Phase 3 buffer pool.

### Fixed page validation

Every supplied page must be exactly `PAGE_SIZE` bytes. The operation validates page IDs, rejects duplicate/unrequested pages, copies host-owned bytes into WASM-owned storage, and reports `ERROR` for malformed protocol input.

### Two pause types

- `PAGE_FAULT`: the operation needs one or more absent pages. The host must call `providePages()` before stepping again.
- `FLUSHING`: the operation has dirty pages ready for persistence. The host must persist every supplied dirty page and only then call `finishFlush(success)`.

The operation never reports `COMPLETE` while dirty pages remain unflushed.

### Cancellation

Cancellation is cooperative. `cancelOperation()` transitions an active or paused operation to `CANCELLED`. Later page or flush responses for that operation are rejected and any operation-owned page memory is released.

### Commit boundary

The scheduler reports a flush set; the host owns page-batch durability. For IndexedDB, the host writes the supplied dirty pages in one `readwrite` transaction and reports success only after `transaction.oncomplete`.

Phase 2 does not expose candidate master bytes or generation IDs. Phase 4 will extend this boundary so page writes and master metadata publication form one recoverable commit protocol.

### Resource and lifecycle limits

The first implementation must define constants for maximum operation count, plan size, pending page requests, resident pages, and dirty pages per operation. Reject requests that exceed a limit before allocating additional operation memory.

Operations remain queryable in terminal states until `release_operation()` is called. Releasing an operation drops all resident pages, dirty-page snapshots, diagnostics, and result bytes. Unknown, already-released, or terminal-operation protocol calls return `INVALID_ARGUMENT` without mutating state.

## C++ API

### New types

Place scheduler types under `src/include/storage/` and implementations under `src/storage/`.

```cpp
using operation_id_t = uint64_t;

enum class SchedulerStatus : uint8_t {
    READY,
    PAGE_FAULT,
    FLUSHING,
    COMPLETE,
    CANCELLED,
    ERROR,
};

struct PageRequest {
    page_id_t page_id;
    bool is_write;
};

struct PageData {
    page_id_t page_id;
    std::vector<uint8_t> bytes; // Always PAGE_SIZE bytes.
};
```

`PageData` owns bytes at the C++ boundary so host-provided views cannot become invalid while an operation is suspended.

### Operation API

```cpp
StorageResult start_operation(std::string_view plan_json, operation_id_t& out_operation_id);
SchedulerStatus step_operation(operation_id_t operation_id);
std::vector<PageRequest> get_pending_page_requests(operation_id_t operation_id);
StorageResult provide_pages(operation_id_t operation_id, const std::vector<PageData>& pages);
std::vector<PageData> get_dirty_pages_for_flush(operation_id_t operation_id);
StorageResult finish_flush(operation_id_t operation_id, bool success);
void cancel_operation(operation_id_t operation_id);
StorageResult release_operation(operation_id_t operation_id);
std::string get_execution_results(operation_id_t operation_id);
std::string get_execution_error(operation_id_t operation_id);
```

For this milestone, `plan_json` uses a deliberately narrow, versioned test-operation format. It is not the Phase 7 Plan IR:

```json
{
  "version": 1,
  "reads": [2],
  "writes": [{"page_id": 2, "byte_offset": 64, "value": 42}]
}
```

- `reads` is the ordered set of page IDs required before writes execute.
- `writes` is optional; every write targets a page in `reads`, has `byte_offset < PAGE_SIZE`, and writes one byte.
- Duplicate IDs and unknown fields are rejected. The input has a strict maximum size and nesting depth.
- The operation requests one missing page per fault in Phase 2, while the vector API remains batch-capable for Phase 3.

### Embind wire API

Keep `PageData` as the C++ API, but do not expose `std::vector<PageData>` directly through Embind. The WASM boundary uses scalar page IDs plus byte vectors:

```cpp
std::vector<page_id_t> get_pending_page_ids(operation_id_t operation_id);
StorageResult provide_page(operation_id_t operation_id,
                           page_id_t page_id,
                           const std::vector<uint8_t>& bytes);
std::vector<page_id_t> get_dirty_page_ids(operation_id_t operation_id);
std::vector<uint8_t> copy_dirty_page(operation_id_t operation_id, page_id_t page_id);
```

The JavaScript wrapper converts between `Uint8Array` and Embind byte vectors. It checks every byte length before calling WASM and copies bytes on both sides of the boundary. Phase 2 must bind the `SchedulerStatus` enum and expose numeric operation IDs without converting them through JavaScript `number`; use Embind `BigInt` support or decimal-string operation IDs if the configured Emscripten version cannot round-trip `uint64_t` safely.

### State transitions

```mermaid
stateDiagram-v2
    [*] --> READY
    READY --> PAGE_FAULT: required page absent
    PAGE_FAULT --> READY: providePages succeeds
    READY --> FLUSHING: dirty pages require flush
    FLUSHING --> READY: finishFlush succeeds
    READY --> COMPLETE: result ready and no dirty pages
    PAGE_FAULT --> CANCELLED: cancel
    FLUSHING --> CANCELLED: cancel
    READY --> CANCELLED: cancel
    READY --> ERROR: protocol or execution error
    PAGE_FAULT --> ERROR: invalid supplied pages
    FLUSHING --> ERROR: flush failure
```

`step_operation()` performs at most one unit of progress: it requests one missing page, applies all validated writes, requests a flush, or completes. Invalid transitions must not mutate operation state. Examples: stepping a `PAGE_FAULT` operation before pages are supplied, supplying pages during `FLUSHING`, or finishing a flush outside `FLUSHING`.

`provide_pages()` must contain exactly the requested page IDs for the active fault. It rejects missing, extra, duplicate, wrong-sized, or negative-ID pages. `get_dirty_pages_for_flush()` returns an immutable copy of the current dirty-page snapshot; repeated calls return the same snapshot until `finish_flush()`. The operation does not allow page mutation while `FLUSHING`.

## Host Protocol

### TypeScript contract

Create a host-side package or `web/` module only after agreeing on its location. The initial public contract is:

```typescript
export interface AsyncPageStore {
  readPages(pageIds: number[]): Promise<Map<number, Uint8Array>>;
  writePages(pages: Map<number, Uint8Array>): Promise<void>;
}
```

Requirements:

- `readPages` returns independent 4096-byte page images.
- `writePages` resolves only after the backend makes the entire batch durable.
- Every input and output page is exactly 4096 bytes.
- Page IDs are signed 32-bit integers and must be non-negative when passed through JavaScript.
- The host copies page bytes before transferring them into or out of storage.

### Worker algorithm

1. Call `stepOperation()`.
2. On `PAGE_FAULT`, collect requested IDs, call `readPages`, verify every requested ID is present, then call `providePages()`.
3. On `FLUSHING`, collect the dirty-page snapshot and call `writePages()`.
4. Call `finishFlush(operationId, true)` only after `writePages()` resolves. On rejection, call `finishFlush(operationId, false)`.
5. Continue until `COMPLETE`, `CANCELLED`, or `ERROR`.

No response may be delivered after cancellation.

The coordinator must use a single in-flight host request per operation. It checks cancellation again after every `await` and before `provide_page()` or `finish_flush()`. Storage exceptions are translated to `finish_flush(id, false)` for flushes; read exceptions set the operation to `ERROR` through a dedicated `fail_operation(id, message)` API.

## Build and Test Tooling

- Add scheduler sources to `webdb_core` so native unit tests and the WASM module use identical C++ code.
- Add a native CTest executable for scheduler and in-memory async-store tests.
- Create `web/` with `package.json`, `tsconfig.json`, and a browser-capable test runner before adding the IndexedDB adapter. Use fake IndexedDB only for unit-level transaction failure tests; run at least one integration test in a real browser engine.
- Add Make targets for the browser test command only after the JavaScript package exists. Keep `make test` as the native-only suite until then.
- Pin the Emscripten and Node.js versions used for WASM and browser tests in project documentation or CI configuration.

## Implementation Sequence

1. Add scheduler enums, protocol data types, and error/result contracts.
2. Add `OperationScheduler` with operation lookup, state-transition validation, cancellation, and operation memory cleanup.
3. Add a minimal per-operation resident page cache with page request, page supply, writable-page tracking, and dirty-page collection.
4. Add a deterministic in-memory async page store for native tests. It must model a durable image separately from supplied page buffers and support a fresh reader over the durable image.
5. Add Embind bindings for scalar state APIs and page transfer. Use typed arrays or byte vectors without exposing raw C++ pointers.
6. Create the `web/` TypeScript package, worker coordinator, and an in-memory `AsyncPageStore` implementation.
7. Implement the IndexedDB `webdb_pages` store. Persist each flush batch in one `readwrite` transaction and wait for completion. Reserve `webdb_meta` and atomic master publication for Phase 4.
8. Add browser integration tests for IndexedDB transaction completion, read failures, cancellation, and flush error propagation.

## Test Plan

### C++ unit tests

- Valid state transitions for each scheduler status.
- Invalid transitions preserve state and return a deterministic error.
- Missing-page request deduplication within one operation.
- Reject wrong-sized pages, unexpected IDs, duplicate IDs, and null/empty page batches.
- Supplied pages are copied; mutating the host buffer after supply does not change the resident page.
- Dirty-page collection contains each dirty page once, returns a stable snapshot, and does not clear it before successful `finishFlush`.
- Failed flush transitions to `ERROR` and does not claim completion.
- Cancellation works from `READY`, `PAGE_FAULT`, and `FLUSHING`; late host responses are rejected.
- Operation IDs remain unique and unknown IDs return `INVALID_ARGUMENT`.
- Releasing terminal operations frees their state; releasing nonterminal operations is rejected or explicitly defined as cancellation followed by release.
- Embind page-transfer tests reject IDs outside the signed 32-bit range and byte arrays whose length differs from `PAGE_SIZE`.

### Durability simulation tests

Use the test-only async page store with separate volatile and durable images:

- A successful flush persists every dirty page to the durable image.
- A rejected flush leaves the durable image unchanged.
- A fresh store instance reads only the durable image.
- Page values supplied to, or returned from, the store cannot mutate the durable image by aliasing.

These tests establish host page-flush behavior only. They must not claim atomic multi-page recovery or recovery of torn Phase 1 data-page writes.

### Browser tests

- IndexedDB `readPages` returns exact 4096-byte copies.
- `writePages` resolves only after `oncomplete`.
- Transaction abort rejects the operation and leaves the prior page values readable.
- Worker cancellation drops late read/commit responses.
- A real browser test verifies that `Uint8Array` pages are copied rather than retained as aliases across the WASM and IndexedDB boundaries.

## Acceptance Criteria

Phase 2 is complete when:

1. Native tests cover scheduler state transitions, invalid protocol inputs, cancellation, and durable-image recovery behavior.
2. The WASM module exports the scheduler operations and can complete a page fault/flush/resume flow with a test host.
3. The worker host can read and flush page batches through IndexedDB, awaiting transaction completion.
4. A failed IndexedDB transaction is surfaced as `ERROR` and does not alter the test store's durable image.
5. Every operation is explicitly released after observing its terminal result or error.
6. Documentation states clearly that Phase 2 does not make Phase 1 in-place data-page mutations recoverable; Phase 4 provides that stronger guarantee.

## Open Decisions for Review

1. Should Phase 2 include a minimal executable operation format, or should the scheduler remain a standalone test API until the Phase 7 Plan IR exists?
Answer: Use the versioned read/write test-operation format defined above. It proves the full fault, supply, mutation, and flush flow without becoming a premature query language.

2. Should the browser host live in this repository under `web/`, or in a separate `@webdb/client` repository/package?
Answer: for now inside a `web/` folder

3. Should an operation request pages one at a time initially, or should the C++ API permit multi-page faults from day one?
Answer: Keep the vector-based API from day one, but issue one page request per fault initially. Phase 3 can add multi-page faults and prefetching without breaking the protocol.


4. Does Phase 2 need to expose candidate master-page bytes explicitly, or should master publication remain a scheduler-private operation until catalog support exists?
Answer: Defer candidate master bytes and all master metadata publication to Phase 4. Phase 2 flushes page batches only.
