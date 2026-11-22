/**
 * Slim Entrypoint: `@ahmadmoussawi/webdb/slim`
 *
 * Exports the full `WebDB` API, `QueryBuilder`, `liveQuery`, compiler, planners,
 * types, and constants with ZERO static imports of the WASM engine, JS VM
 * interpreter, or VFS storage adapters (`MemoryStorage`, `IdbStorage`,
 * `OpfsStorage`).
 *
 * Pass explicit `engine` and `storage` instances from subpath exports:
 * - `@ahmadmoussawi/webdb/core/wasm` (`WasmEngine`)
 * - `@ahmadmoussawi/webdb/core/js` (`JsEngine`)
 * - `@ahmadmoussawi/webdb/storage/memory` (`MemoryStorage`)
 * - `@ahmadmoussawi/webdb/storage/idb` (`IdbStorage`)
 * - `@ahmadmoussawi/webdb/storage/opfs` (`OpfsStorage`)
 */

export * from "./types/index.js";
export * from "./constants.js";
export * from "./host/storage/vfs.js";
export * from "./host/storage/io.js";
export * from "./host/storage/crc32.js";
export * from "./host/storage/wal_codec.js";
export * from "./host/driver/index.js";
export * from "./host/compiler/index.js";
export * from "./host/api/index.js";
export * from "./shared/index.js";
export {
  sql_like_match,
  compare_sorter_keys,
  fnv1a_32,
  type VmStepFn,
  type WebDbCoreEngine,
} from "./core/js/vm_host.js";
export { UuidCodec, UlidCodec } from "./core/js/codecs.c.js";
