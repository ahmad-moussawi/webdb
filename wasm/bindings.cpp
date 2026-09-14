#include <emscripten/bind.h>
#include "engine.hpp"

/**
 * @file bindings.cpp
 * @brief Emscripten Embind interface for the WebDB SQL Engine.
 *
 * This file lives in the isolated 'wasm' directory to ensure the core
 * database engine (src/) remains completely decoupled from WebAssembly/Emscripten
 * toolchain headers.
 */

using namespace emscripten;
using namespace webdb;

EMSCRIPTEN_BINDINGS(webdb_module) {
    class_<SqlEngine>("SqlEngine")
        .constructor<>()
        .function("executeQuery", &SqlEngine::execute_query);
}
