# WebDB Internals Handbook: Architectural Guide

Welcome to the **WebDB Internals Handbook**. This collection of guides explains the architecture, design decisions, algorithms, and binary formats powering WebDB—a relational database engine compiled to WebAssembly to run high-performance, persistent SQL directly inside web browsers.

---

## The Core Vision: Why Build WebDB?

For decades, web applications have relied on remote servers (PostgreSQL, MySQL) for relational data, using client-side storage (IndexedDB, LocalStorage) only for simple caching or key-value blobs.

However, modern web applications (local-first apps, collaborative editors, offline-first tools, embedded analytics) need:
1. **Full Relational Queries (SQL)**: Joins, aggregations, secondary indexes, and structured query planning.
2. **Deterministic Durability**: Transactions that survive tab crashes, device sleep, and battery failure.
3. **Zero-Latency Local Execution**: Instant reads and writes without waiting for network round-trips.

WebDB brings full relational database capabilities to the client by combining:
- A high-performance **C++20 core storage and query engine**.
- **WebAssembly (WASM)** compilation for near-native execution speed.
- **Asynchronous Host-Driven I/O** bridging WebAssembly with browser storage engines (**IndexedDB** and **OPFS**).

---

## Phase-by-Phase Roadmap

WebDB is built in iterative, testable milestones. This handbook covers the first three foundational phases:

```
+-------------------------------------------------------------------------+
|                               WebDB Architecture                        |
+-------------------------------------------------------------------------+
| Phase 7: Structured Plan IR & Fluent TypeScript SDK                     |
| Phase 6: Catalog & Schema Management                                    |
| Phase 5: B+ Tree Indexing (Point Lookups & Range Scans)                 |
| Phase 4: ACID Transactions & Dual-Generation Commit Protocol            |
+-------------------------------------------------------------------------+
| Phase 3: Shared Buffer Pool Manager with Clock Eviction                 |
|          [Read Guide: docs/phase3_buffer_pool_guide.md]                 |
+-------------------------------------------------------------------------+
| Phase 2: Host-Driven Asynchronous Page Scheduler                        |
|          [Read Guide: docs/phase2_async_scheduler_guide.md]             |
+-------------------------------------------------------------------------+
| Phase 1: Binary Storage Format, Dual Master Pages & Slotted Pages       |
|          [Read Guide: docs/phase1_storage_format_guide.md]              |
+-------------------------------------------------------------------------+
```

---

## Table of Contents & Summaries

### [Chapter 1: Binary Storage Format & Slotted Pages](phase1_storage_format_guide.md)
* **The Core Problem:** How do you organize structured tables, variable-length rows, and system settings into fixed 4,096-byte blocks of raw bytes without wasting space or risking hardware alignment crashes?
* **Key Topics Covered:**
  - Why fixed 4 KiB pages?
  - Little-Endian byte ordering and safe unaligned reads with `std::memcpy`.
  - CRC-32 IEEE 802.3 checksums for bit-rot and corruption detection.
  - **Dual Master Pages (Ping-Pong)**: Achieving atomic metadata updates without a Write-Ahead Log.
  - **Slotted Pages**: Two-way growth layout, Record IDs (`RID`), deletions, and in-page compaction.
  - **Tuples**: Binary serialization for `INT`, `DOUBLE`, `TEXT`, and `NULL` bitmasks.
  - **Table Heap**: Chaining pages into doubly-linked lists with anti-cycle traversal guards.

---

### [Chapter 2: Host-Driven Asynchronous Scheduler](phase2_async_scheduler_guide.md)
* **The Core Problem:** Traditional C++ databases use synchronous blocking I/O (`read()`, `write()`). But in a web browser, JavaScript is single-threaded and storage (IndexedDB/OPFS) is asynchronous (`Promise`/`await`). If C++ blocks waiting for disk, the browser tab freezes and deadlocks!
* **Key Topics Covered:**
  - The browser event loop constraint and why WASM cannot block.
  - **The Cooperative State Machine**: The 6 operational states (`READY`, `PAGE_FAULT`, `FLUSHING`, `COMPLETE`, `CANCELLED`, `ERROR`).
  - Choreography between TypeScript and C++: Pausing on page faults, fetching asynchronously, and resuming.
  - Cooperative cancellation: Protecting against zombie callbacks and race conditions.
  - Clean architectural decoupling: Pure C++20 core vs. Embind bridge vs. TypeScript driver.

---

### [Chapter 3: Buffer Pool Manager with Async I/O Awareness](phase3_buffer_pool_guide.md)
* **The Core Problem:** In Phase 2, each query maintained its own private copy of pages in RAM, wasting memory and causing memory leaks on large table scans. How do we build a bounded, shared cache with safe concurrent access across asynchronous pauses?
* **Key Topics Covered:**
  - The Hotel Room metaphor (Pages vs. Frames).
  - The 5 Frame States: `ABSENT`, `LOADING`, `RESIDENT`, `DIRTY`, `FLUSHING`.
  - **Pinning and Unique Pin Tokens**: Preventing active pages from being evicted mid-query.
  - **The Clock Algorithm (Second-Chance Eviction)**: Scan-resistant cache replacement.
  - **Request Deduplication**: Sharing a single host read across multiple concurrent queries.
  - **Dirty Page Tracking & Generation Counters**: Preventing data loss when pages are modified during active flushes.
  - **Implementation Review Findings**: Crucial fixes and edge cases identified prior to implementation.

---

## Architectural Principles of WebDB

When reading these guides or contributing to the codebase, keep these four governing principles in mind:

1. **Deterministic State Transitions**:
   Every database action is an explicit transition in a state machine. WebDB avoids hidden background threads or unbounded recursion.
2. **Strict Memory Boundedness**:
   Every buffer, frame count, slot array, and queue has a hardcoded, validated maximum limit. A hostile or malfunctioning host script can never cause WebDB to consume unbounded WASM memory.
3. **Pointers Never Escape Their Lifetime**:
   Pointers to frame memory are protected by pin accounting and reference tokens. When an operation pauses across an asynchronous host I/O yield, its pinned frames are guaranteed never to be repurposed or corrupted.
4. **Clean Boundary Decoupling**:
   The database engine core in `src/` has **zero dependencies** on WebAssembly, Emscripten, or JavaScript. It can be compiled with standard GCC, Clang, or MSVC and run as a standalone native database on any operating system.
