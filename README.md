# WebDB

An embedded, single-threaded relational SQL database engine implemented from scratch in modern C++ (C++20), architected to compile natively and to WebAssembly (WASM) via Emscripten.

---

## Architecture Overview

- **Storage Abstraction (VFS)**: Zero direct OS system calls or naked file streams (`std::fstream`). Disk and memory interactions are abstracted behind an `IVirtualFileSystem` interface in [src/include/vfs.hpp](src/include/vfs.hpp), allowing in-memory arrays or browser Origin Private File System (OPFS) backends.
- **Single-Threaded Core**: Free of threading primitives (`std::thread`, `pthread`, mutexes) to ensure deterministic portability to standard single-threaded WASM runtimes.
- **Isolated Bindings**: The core engine in [src/](src/) contains zero Emscripten or web references. All WebAssembly glue logic lives exclusively inside [wasm/bindings.cpp](wasm/bindings.cpp) using Embind.
- **Wire Format**: WASM boundary queries and responses exchange standard JSON strings.

---

## Directory Structure

```text
webdb/
├── CMakeLists.txt              # Unified build configuration (Native & Emscripten)
├── README.md                   # Project documentation and build instructions
├── src/
│   ├── include/
│   │   ├── engine.hpp          # Core SQL engine header
│   │   └── vfs.hpp             # Virtual File System interface & in-memory backend
│   ├── engine.cpp              # Engine execution lifecycle & JSON serialization
│   └── main.cpp                # Native CLI driver for testing
└── wasm/
    └── bindings.cpp            # Emscripten Embind exports
```

---

## Prerequisites

### Native Build
- C++20 compliant compiler (Apple Clang 13+, GCC 10+, or Clang 11+)
- CMake 3.20+ (optional if compiling directly with the compiler CLI)

### WebAssembly (WASM) Build
- [Emscripten SDK (emsdk)](https://emscripten.org/docs/getting_started/downloads.html)

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

### 1. Native Build

#### Option A: Using CMake
```bash
# Generate build configuration
cmake -B build -S .

# Build the native CLI executable
cmake --build build

# Run the CLI
./build/webdb_cli
```

#### Option B: Direct Clang / GCC Compilation
If CMake is not installed on your host:
```bash
clang++ -std=c++20 -Wall -Wextra -Wpedantic -I src/include src/engine.cpp src/main.cpp -o webdb_cli
./webdb_cli
```

---

### 2. WebAssembly (WASM) Build

Make sure your active shell has the Emscripten environment loaded (`source ./emsdk_env.sh`).

#### Option A: Using CMake with `emcmake`
```bash
# Configure with Emscripten CMake wrapper
emcmake cmake -B build-wasm -S .

# Compile target artifacts
cmake --build build-wasm
```

This generates:
- `build-wasm/webdb.js` (JavaScript glue / ES6 loader module)
- `build-wasm/webdb.wasm` (Compiled WebAssembly binary)

#### Option B: Direct `emcc` Compilation
```bash
em++ -std=c++20 -O3 --bind \
  -I src/include \
  src/engine.cpp wasm/bindings.cpp \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="createWebDB" \
  -s NO_DISABLE_EXCEPTION_CATCHING \
  -s FILESYSTEM=0 \
  -o webdb.js
```

---

## JavaScript / Browser Usage

Once compiled to WebAssembly, import the generated ES6 module:

```javascript
import createWebDB from './build-wasm/webdb.js';

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

## Testing & Verification

Run the native CLI runner to verify the VFS layer and query responses:

```bash
./webdb_cli
```

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
