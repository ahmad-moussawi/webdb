# WebDB

An embedded, single-threaded relational SQL database engine implemented from scratch in modern C++ (C++20), architected to compile natively and to WebAssembly (WASM) via Emscripten.

## Why WebDB?

WebDB is a compact, inspectable database engine for applications that need
local relational data without giving up portability. It is intentionally light:
WebDB keeps the core package small while preserving the storage, query, and
extensibility features that matter for browser applications. It is built for
the browser from the beginning, rather than being a native database adapted to
run there later.

WebDB relies on browser capabilities wherever they are the right tool instead
of reimplementing them inside the WASM binary. JavaScript and browser APIs can
handle capabilities such as dates, regular expressions, and math, keeping the
database focused and reducing package size. This browser-native approach also
provides a natural path for JavaScript User-Defined Functions (UDFs), so
applications can extend queries with the runtime they already use.

## Browser-First Strengths

- **Small by design**: a focused three-type core keeps downloads, startup, and
  memory use approachable for web applications.
- **IndexedDB and OPFS**: IndexedDB is the first-class universal browser
  backend, while OPFS is supported as the high-performance browser storage
  path where synchronous worker file access is available.
- **Browser-native extensions**: JavaScript UDFs can delegate dates, regular
  expressions, math, and application-specific logic to the browser runtime
  instead of adding large utility libraries to WASM.
- **Built for browser workflows**: asynchronous storage, Web Workers,
  Promise-based APIs, streaming results, and cancellation are part of the
  architecture rather than after-the-fact compatibility layers.

## Project Status

WebDB is now in **Phase 1** of its development plan. This phase establishes a
durable storage format, dual master pages, CRC-protected slotted pages, typed
tuples, and a corruption-aware table heap.

The high-level plan is:

1. **Phase 1: Storage foundation** - page formats, checksums, tuple encoding,
  table heaps, and native/WASM build support.
2. **Phase 2: Browser persistence** - first-class IndexedDB and OPFS backends
  behind the browser page-store abstraction, with async scheduling for
  IndexedDB and high-performance worker access for OPFS.
3. **Phase 3: Relational features** - schemas, indexes, richer SQL execution,
  and stable references for application data.
4. **Phase 4: Production hardening** - stronger recovery, migrations,
  performance work, and broader compatibility guarantees.

WebDB currently supports three scalar data types: `INT`, `DOUBLE`, and `TEXT`.
Nullable columns are supported as a value property, not as a fourth scalar
type. WebDB is still under heavy development; APIs, file formats, and behavior
may change, and it is not yet ready for production data.

## WebDB And SQLite WASM

WebDB and SQLite compiled to WebAssembly solve different problems. SQLite WASM
is an excellent choice when the priority is maximum SQL compatibility and a
mature, general-purpose database. WebDB makes a different tradeoff: it keeps
the database core intentionally focused so browser applications can get a
smaller package, simpler integration, and a storage model designed around web
platform capabilities.

| | WebDB | SQLite WASM |
|---|---|---|
| Package size | Intentionally small; limited scope and browser API delegation reduce WASM payload and startup cost | Broader engine and compatibility surface generally produce a larger, more capable runtime |
| Primary goal | A focused, inspectable database core designed specifically for browsers | A mature, general-purpose SQL engine compiled for browsers |
| Feature scope | Intentionally limited to the features needed for the browser-first roadmap | Broad SQL language, virtual tables, extensions, and compatibility features |
| Why the scope differs | WebDB relies on JavaScript and browser APIs for dates, regular expressions, math, storage, and host integration instead of bundling replacements into WASM | SQLite provides more functionality inside the database engine itself |
| Data types | Exactly three scalar types: `INT`, `DOUBLE`, and `TEXT` | Dynamic typing with broader SQL compatibility |
| Thread model | Single-threaded by design, which keeps the core small, deterministic, and easy to run in browser workers without requiring pthreads or shared-memory setup | Can support more concurrency options, but browser threading may require additional runtime and deployment configuration |
| Browser persistence | IndexedDB is the first-class universal backend; OPFS is the high-performance option where available | Depends on the selected SQLite WASM VFS and browser integration layer |
| Extensibility | JavaScript UDFs let applications reuse browser-native dates, regex, math, and domain logic without growing the WASM binary | Extensibility commonly uses SQLite's native extension mechanisms or a separate JavaScript integration layer |
| Browser architecture | Designed around asynchronous storage, Web Workers, Promise-based APIs, streaming, and cancellation | Native-first architecture adapted to browser runtimes through WASM and VFS layers |
| Best fit | Browser applications that value a small download, low startup overhead, browser-native APIs, UDFs, and explicit IndexedDB/OPFS storage | Applications that need mature SQL compatibility, a wider feature set, and SQLite ecosystem compatibility today |

### What WebDB Deliberately Leaves Out

WebDB does not try to reproduce every database feature or every native runtime
inside the WASM package. The three-type model keeps serialization and query
execution compact. The single-threaded core avoids the size and deployment
complexity of pthreads and shared-memory WASM. Browser APIs provide capabilities
that the platform already implements well, while JavaScript UDFs provide an
escape hatch for application-specific behavior.

This is the central WebDB tradeoff: less built-in breadth in exchange for a
smaller, browser-native engine that can lean on the platform instead of
rebuilding it. Choose SQLite WASM when broad SQL compatibility and maturity are
the priority. Choose WebDB when package size, browser integration, predictable
single-threaded execution, and JavaScript extensibility matter more. WebDB is
still under active development, so this comparison will evolve with the
implementation.

---

## Architecture Overview

- **Storage Abstraction**: Storage is designed around browser page stores, with IndexedDB as the universal first-class backend and OPFS as the high-performance option. Native and in-memory stores remain useful for development and testing.
- **Single-Threaded Core**: Free of threading primitives (`std::thread`, `pthread`, mutexes) to ensure deterministic portability to standard single-threaded WASM runtimes.
- **Isolated Bindings**: The core engine in [src/](src/) contains zero Emscripten or web references. All WebAssembly glue logic lives exclusively inside [wasm/bindings.cpp](wasm/bindings.cpp) using Embind.
- **Wire Format**: WASM boundary queries and responses exchange standard JSON strings.

---

## Prerequisites

### Native Build
- C++20 compliant compiler (Apple Clang 13+, GCC 10+, or Clang 11+)
- GNU Make or a compatible `make` implementation
- CMake 3.20+ (used by the Makefile)

### WebAssembly (WASM) Build
- [Emscripten SDK (emsdk)](https://emscripten.org/docs/getting_started/downloads.html)
- GNU Make or a compatible `make` implementation
- CMake 3.20+ (used by the Makefile)

Install and activate Emscripten:
```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

---

## Build Instructions

### Native Build

```bash
# Configure and build the native CLI and storage test runner.
make build

# Run the native CLI and VFS integration checks.
make run

# Build and run the native CTest suite.
make test
```

Native outputs are written to `dist/native`. Remove generated files with:

```bash
# Remove all generated build files under dist/.
make clean
```

Use `make help` to list all available targets. The Makefile keeps all generated
files under `dist`.

---

### WebAssembly Build

Activate the Emscripten environment before running the Makefile targets:

```bash
source /path/to/emsdk/emsdk_env.sh
```

```bash
# Configure and build the development WASM artifacts.
make wasm
```

This generates:
- `dist/wasm/webdb.js` (JavaScript glue / ES6 loader module)
- `dist/wasm/webdb.wasm` (Compiled WebAssembly binary)

```bash
# Configure and build the size-optimized production WASM artifacts.
make wasm-prod
```

Both targets write `webdb.js` and `webdb.wasm` to `dist/wasm`. The production
target uses Emscripten size optimization and link-time optimization.

---

## JavaScript / Browser Usage

Once compiled to WebAssembly, import the generated ES6 module:

```javascript
import createWebDB from './dist/wasm/webdb.js';

// Initialize the WebAssembly module
const module = await createWebDB();

// Instantiate the database engine
const engine = new module.SqlEngine();

// Execute SQL queries
const response = engine.executeQuery("SELECT * FROM users;");
const result = JSON.parse(response);

console.log(result);
```

Sample JSON response from `SELECT`:
```json
{
  "status": "success",
  "type": "SELECT",
  "columns": ["id", "name", "role"],
  "column_types": ["INTEGER", "VARCHAR", "VARCHAR"],
  "rows": [
    [1, "Alice", "Admin"],
    [2, "Bob", "Engineer"],
    [3, "Charlie", "Designer"]
  ],
  "row_count": 3
}
```

---

## Verification

Run the native test suite with:

```bash
make test
```

Use `make run` to exercise the native CLI and VFS integration manually.

Expected output:
```text
=== WebDB Engine CLI (Native Build) ===

[SQL] SELECT * FROM users;
[JSON Result] {"status":"success","type":"SELECT","columns":["id","name","role"],"column_types":["INTEGER","VARCHAR","VARCHAR"],"rows":[[1,"Alice","Admin"],[2,"Bob","Engineer"],[3,"Charlie","Designer"]],"row_count":3}

...

=== Testing VFS Subsystem ===
VFS Write & Readback: PASS
VFS File Size: 28 bytes

Baseline engine execution completed successfully.
```
