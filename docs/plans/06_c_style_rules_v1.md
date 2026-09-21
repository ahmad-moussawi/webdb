# Phase 6 Technical Specification: Strict C-Style Rules for the JS Engine (V1)

## 1. Executive Summary & Core Philosophy

To guarantee that **Version 1 (JavaScript/TypeScript Reference Engine)** can be replaced by **Version 2 (Compiled C/WebAssembly)** as a seamless drop-in swap with **zero architectural friction**, all code inside `src/engine/` must strictly adhere to **C-Style Semantics**.

Writing V1 in C-style JS delivers three enormous advantages:
1. **1:1 Porting Parity:** Porting from V1 JS to V2 C is a mechanical, line-by-line syntax translation (from `view.getInt32(ptr, true)` to `*(int32_t*)ptr`).
2. **Zero Garbage Collection (GC) Jitter:** Banning dynamic object creation in the execution loop completely eliminates V8 GC pauses, providing microsecond-level query latencies.
3. **Bit-for-Bit Differential Testing:** Both engines operate on identical byte patterns in shared memory, allowing the differential test runner to assert bitwise identical slotted pages.

---

## 2. The Five Strict Rules of Engine Core Development

### Rule 1: Zero Dynamic Object Allocation in Execution Hot Paths
* **Banned Constructs inside `src/engine/` hot loops:**
  - `new Map()`, `new Set()`, `new Object()`
  - Object literals (`{ id: 1, name: 'foo' }`)
  - Array literals inside loops (`[a, b, c]`)
  - Class instantiations (`new Cursor()`)
* **Required Approach:** All state, cursors, registers, and temporary tables live inside pre-allocated slices of `ArrayBuffer` or the `Transient Query Arena`.

---

### Rule 2: Pure Numeric FFI Signatures
All engine entry points must accept and return **only primitive numbers** (pointers, byte offsets, lengths, status codes), identical to WebAssembly exported function signatures:

```typescript
// ALLOWED: Matches Wasm ABI
function vm_step(ctxOffset: number): number;
function page_init(pageOffset: number, pageType: number): void;
function page_insert_cell(pageOffset: number, cellOffset: number, cellLen: number): number;

// STRICTLY BANNED: Passes JS object across boundary
function vm_step(ctx: VmContextObject): QueryResultObject;
```

---

### Rule 3: Manual Byte Layouts & Explicit Little-Endian `DataView`
Struct field dereferencing must be written with explicit byte offsets and little-endian indicators:

```typescript
// V1 JavaScript (C-Style):
function get_cell_offset(view: DataView, pageOffset: number, slotIdx: number): number {
  return view.getUint16(pageOffset + 12 + (slotIdx * 2), true);
}

// V2 C (Drop-in Port):
static inline uint16_t get_cell_offset(const uint8_t *page, uint16_t slot_idx) {
  return *(const uint16_t*)(page + 12 + (slot_idx * 2));
}
```

---

### Rule 4: Iterative Only (No Call-Stack Recursion)
* The call stack in `src/engine/` must never exceed **1 function deep** (`vm_step()`).
* **B-Tree Traversal:** Traversal of internal nodes, page descend, and leaf sibling navigation must use an explicit array stack (`cursors[16]`) stored in `VmContext`.
* **Zero Recursion:** Recursive tree search algorithms are strictly forbidden because they trap execution state on the C call stack, preventing pause/resume on async page faults.

---

### Rule 5: Primitive Bitwise Bitmasks
Flags, nullability, and dirty tracking must use native bitwise operations:

```typescript
// Check if column i is NULL:
const isNull = (view.getUint8(nullBitmapOffset + (colIdx >> 3)) & (1 << (colIdx & 7))) !== 0;

// Mark slot S dirty:
dirtyMask[slot >> 3] |= (1 << (slot & 7));
```

---

## 3. Side-by-Side Translation Reference (JS $\leftrightarrow$ C)

| Operation | V1 Implementation (TypeScript / JS) | V2 Implementation (C99 / Wasm) |
| :--- | :--- | :--- |
| **Read uint16** | `view.getUint16(offset, true)` | `*(const uint16_t*)(ptr + offset)` |
| **Write uint32** | `view.setUint32(offset, val, true)` | `*(uint32_t*)(ptr + offset) = val;` |
| **Read float64** | `view.getFloat64(offset, true)` | `*(const double*)(ptr + offset)` |
| **Memory Copy** | `uint8.set(srcSlice, targetOffset)` | `memcpy(dest, src, length)` |
| **Zero Fill** | `uint8.fill(0, start, end)` | `memset(dest, 0, length)` |
| **Null Test** | `(bitmap[i >> 3] & (1 << (i & 7))) !== 0` | `(bitmap[i >> 3] & (1 << (i & 7))) != 0` |

---

## 4. Automated Linting & CI Verification

To ensure that no dynamic JS object allocations slip into the engine core:
1. **Static Analysis Rule:** Custom ESLint rule scanning `src/engine/vm.ts` and `src/engine/page.ts` for object literals (`ObjectExpression`) and `NewExpression` (except pre-allocated buffers at initialization).
2. **Allocation Profiling Test:** Integration test running 100,000 query cycles while monitoring V8 heap metrics (`performance.memory.usedJSHeapSize`); asserts **zero heap allocation growth** during the query loop.

---

## 5. Verification & Test Suite (`tests/c_style_invariants.test.ts`)

1. **Zero-Allocation Loop Verification:** Run 10,000 scans; assert V8 garbage collection is never triggered.
2. **Numeric Signature Parity:** Assert all engine exports accept and return exclusively numeric primitives.
3. **Little-Endian Consistency:** Assert all multi-byte read/write operations specify little-endian byte ordering.
