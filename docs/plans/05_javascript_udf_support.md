# Phase 5 Technical Specification: JavaScript UDF Support (Synchronous Function Extensibility)

## 1. Executive Summary & Design Rationale

Embedding full-featured text processing (PCRE regular expressions, Unicode case-folding) or date formatting (ICU library) in C/WebAssembly would bloat the binary by **1.5 MB to 3 MB**, completely destroying our featherweight footprint target of **~150 KB Wasm** (~40 KB gzipped).

WebDB solves this by providing **Synchronous User-Defined Functions (UDFs)** that bridge the Engine Core directly into V8's highly optimized native engines:
- **`RegExp`:** Executed via V8's native JIT regular expression engine.
- **`Intl` & Dates:** Native `Intl.DateTimeFormat`, `Intl.Collator`, and `Date` APIs.
- **Custom Math / Transformations:** Arbitrary user JavaScript functions.

---

## 2. Host UDF Registration & Registry

Functions are registered on the database instance:

```typescript
// Register a RegExp filter function
db.registerFunction('regexp', (pattern: string, val: string): boolean => {
  return new RegExp(pattern).test(val);
});

// Register an Intl date formatting function
db.registerFunction('format_date', (epochMs: number, locale: string): string => {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(epochMs));
});
```

### 2.1 Pre-Compilation Optimization
When a query contains a constant pattern (e.g. `WHERE regexp('^A.*', name)`), the Query Compiler compiles the `RegExp` object **once** during query plan generation, avoiding per-row regex recompilation overhead.

---

## 3. Bytecode Dispatch & The `OP_CALL_UDF` Instruction

When a query evaluates a UDF, the compiler emits:

```asm
OP_CALL_UDF  udf_id: uint16, arg_reg: uint8, out_reg: uint8
```

### 3.1 Execution in V1 (JS Reference Engine)
- The engine indexes into `udfRegistry[udf_id]`.
- Reads argument values from register `arg_reg` (or consecutive registers).
- Invokes the function synchronously: `const result = fn(...args);`.
- Writes the return value into `r[out_reg]`.

### 3.2 Execution in V2 (WebAssembly FFI Dispatch)
The compiled C/Wasm binary imports the UDF dispatcher directly from the JavaScript environment:

```c
// C Engine import declaration
extern int32_t js_call_udf(uint16_t udf_id, uint32_t arg_offset, uint32_t arg_len, uint32_t out_offset);
```

#### Performance Invariant:
- A synchronous Wasm $\to$ JS call takes **~10–15 nanoseconds** in modern V8 / SpiderMonkey / JavaScriptCore engines.
- A table scan evaluating a regex UDF over 10,000 rows completes in **under 2 milliseconds**.

---

## 4. Return Value Marshaling & 3VL Null Safety

UDF return values are marshaled back into VM registers according to strict rules:
1. **`boolean`:** Marshaled to `int32_t` (`1` = true, `0` = false).
2. **`number`:** Marshaled to integer or `double`.
3. **`string`:** Encoded as UTF-8 bytes into the query scratchpad; register points to `(offset, length)`.
4. **`null` or `undefined`:** Register marked as `NULL`, propagating SQLite 3VL comparison rules cleanly.

---

## 5. Error Handling & Exception Propagation

If a user UDF throws a JavaScript exception (e.g. `new RegExp('[')` throws `SyntaxError`):
1. The Host UDF dispatcher catches the exception.
2. In V2 Wasm, the dispatcher returns a negative error code (e.g. `-1`).
3. The VM halts execution and yields `status = STATUS_ERR_UDF_FAILED`.
4. The JS Host rejects the active query Promise with the original user exception preserved with its stack trace.
5. **Zero Memory Corruption:** Registers and page slots remain in a deterministic, consistent state.

---

## 6. Exhaustive Edge Cases & Failure Modes

* [ ] **Non-Existent UDF Call:** Query referencing an unregistered UDF ID must be rejected at compile time with `UnknownFunctionError`.
* [ ] **UDF Mutating Global State:** Verify that non-pure UDFs do not alter database memory or invalidate active cursor pointers.
* [ ] **Large String Return Overflow:** If a UDF returns a string exceeding the scratchpad capacity, the engine must throw `UdfOutputExceededError` instead of overflowing the buffer.

---

## 7. Verification & Test Suite (`tests/udf_support.test.ts`)

1. **Native RegExp Filtering:** Filter 1,000 rows with `regexp('^[A-M]', name)`; assert correct matching rows.
2. **Date / Intl Transformation:** Apply `format_date` UDF to timestamp column; assert correct localized string output.
3. **Exception Safety:** Call a UDF that intentionally throws `new Error('UDF crashed')`; assert query Promise rejects with exact error and engine resumes normally on next query.
