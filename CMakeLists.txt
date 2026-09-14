cmake_minimum_required(VERSION 3.20)
project(webdb LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Compiler warning flags for high code quality
if (MSVC)
    add_compile_options(/W4 /permissive-)
else()
    add_compile_options(-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

# Core database engine library (independent of any web/WASM dependencies)
add_library(webdb_core STATIC
    src/engine.cpp
    src/common/checksum.cpp
    src/storage/master_page.cpp
    src/storage/slotted_page.cpp
    src/storage/tuple.cpp
    src/storage/value.cpp
    src/storage/table_heap.cpp
)

target_include_directories(webdb_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src/include
)

# ------------------------------------------------------------------------------
# Build Targets: Emscripten (WASM) vs Native
# ------------------------------------------------------------------------------
if (EMSCRIPTEN)
    message(STATUS "Configuring build for WebAssembly (Emscripten)")

    add_executable(webdb_wasm
        wasm/bindings.cpp
    )

    target_link_libraries(webdb_wasm PRIVATE webdb_core)

    # Emscripten compiler and linker flags:
    # -O3: Aggressive optimization
    # --bind: Embind support for C++ <-> JS bindings
    # ALLOW_MEMORY_GROWTH=1: Dynamic linear memory resizing
    # MODULARIZE=1: Wraps output in a module factory function
    # EXPORT_ES6=1: ES6 module output syntax
    # EXPORT_NAME="createWebDB": JavaScript factory function name
    # NO_DISABLE_EXCEPTION_CATCHING: Clean exception handling support across boundaries
    target_compile_options(webdb_wasm PRIVATE -O3)
    target_link_options(webdb_wasm PRIVATE
        -O3
        --bind
        -s ALLOW_MEMORY_GROWTH=1
        -s MODULARIZE=1
        -s EXPORT_ES6=1
        -s EXPORT_NAME="createWebDB"
        -s NO_DISABLE_EXCEPTION_CATCHING
        -s FILESYSTEM=0
    )

    # Output artifact name: webdb.js (which generates webdb.wasm alongside it)
    set_target_properties(webdb_wasm PROPERTIES
        OUTPUT_NAME "webdb"
        SUFFIX ".js"
    )
else()
    message(STATUS "Configuring build for Native Platform")

    # Native CLI runner for testing and local development
    add_executable(webdb_cli
        src/main.cpp
    )
    target_link_libraries(webdb_cli PRIVATE webdb_core)

    # Storage Engine Unit Test Suite (Phase 1)
    add_executable(test_storage
        tests/test_storage.cpp
    )
    target_link_libraries(test_storage PRIVATE webdb_core)
endif()
