/**
 * Slim Entrypoint: `@ahmadmoussawi/webdb/slim`
 *
 * Exports the full `WebDB` API, `QueryBuilder`, `liveQuery`, compiler, planners,
 * types, and constants with ZERO static imports of the WASM engine, JS VM
 * interpreter, or VFS storage adapters (`MemoryVfsAdapter`, `IndexedDbVfsAdapter`,
 * `OpfsVfsAdapter`).
 *
 * `WebDB.open()` dynamically loads only the selected engine and VFS adapter on
 * demand — or accepts explicit `engine` / `vfs` instances from subpath exports:
 * - `@ahmadmoussawi/webdb/core/wasm`
 * - `@ahmadmoussawi/webdb/core/js`
 * - `@ahmadmoussawi/webdb/storage/memory`
 * - `@ahmadmoussawi/webdb/storage/idb`
 * - `@ahmadmoussawi/webdb/storage/opfs`
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
