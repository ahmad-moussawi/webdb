/**
 * Subpath entry: `@ahmadmoussawi/webdb/core/wasm`
 *
 * Allows explicit WASM engine injection into `WebDB.open({ engine: createWasmEngine(...) })`
 * without pulling in either the JS VM interpreter (`vm.c.ts` / `vm.helpers.c.ts`)
 * or the embedded 70 KB base64 WASM chunk (which is only lazy-loaded when
 * neither `wasmBinary` nor `wasmUrl` is provided).
 */

import {
  instantiateWasmCore,
  instantiateWasmCoreAsync,
  instantiateWasmCoreStreaming,
  type WasmCoreExports,
} from "./wasm_runtime.ts";
import type { WebDbCoreEngine } from "../js/vm_host.ts";

export {
  instantiateWasmCore,
  instantiateWasmCoreAsync,
  instantiateWasmCoreStreaming,
  type WasmCoreExports,
  type WebDbCoreEngine,
};

export interface WasmEngineOptions {
  /** Pre-loaded `.wasm` binary bytes (skips loading the embedded base64 chunk). */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** URL or Fetch Response (or Promise<Response>) for streaming `.wasm` instantiation (skips embedded base64). */
  wasmUrl?: string | URL | Response | Promise<Response>;
}

/**
 * Creates a pluggable WASM core engine descriptor for `WebDB.open({ engine })`.
 */
export function createWasmEngine(
  options?: WasmEngineOptions,
): WebDbCoreEngine {
  return {
    mode: "wasm",
    async init(memory: WebAssembly.Memory) {
      let wasmCore: WasmCoreExports;
      if (options?.wasmBinary) {
        wasmCore = await instantiateWasmCoreAsync(memory, options.wasmBinary);
      } else if (options?.wasmUrl) {
        wasmCore = await instantiateWasmCoreStreaming(memory, options.wasmUrl);
      } else {
        const { getWebDbCoreWasmBytes } = await import("./embedded_wasm.ts");
        wasmCore = await instantiateWasmCoreAsync(
          memory,
          getWebDbCoreWasmBytes(),
        );
      }
      return { vm_step: wasmCore.vm_step, wasmCore };
    },
  };
}
