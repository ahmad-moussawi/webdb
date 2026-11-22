/**
 * Subpath entry: `@ahmadmoussawi/webdb/core/wasm`
 *
 * Allows explicit WASM engine injection into `WebDB.open({ engine: new WasmEngine(...), storage })`
 * without pulling in either the JS VM interpreter (`vm.c.ts` / `vm.helpers.c.ts`)
 * or the embedded 70 KB base64 WASM chunk (which is only lazy-loaded when
 * neither `wasmBinary` nor `wasmUrl` is provided).
 */

import {
  compileWasmModuleAsync,
  compileWasmModuleStreaming,
  instantiateCompiledWasmModule,
  instantiateWasmCore,
  instantiateWasmCoreAsync,
  instantiateWasmCoreStreaming,
  type WasmCoreExports,
} from "./wasm_runtime.ts";
import type { WebDbCoreEngine } from "../js/vm_host.ts";

export {
  compileWasmModuleAsync,
  compileWasmModuleStreaming,
  instantiateCompiledWasmModule,
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
 * Pluggable WebAssembly core engine for `WebDB.open({ engine: new WasmEngine(...), storage })`.
 * Compiles the WASM binary once and caches the compiled `WebAssembly.Module` across instances.
 */
export class WasmEngine implements WebDbCoreEngine {
  readonly mode = "wasm" as const;
  private modulePromise?: Promise<WebAssembly.Module>;

  constructor(private readonly options?: WasmEngineOptions) {}

  private loadModule(): Promise<WebAssembly.Module> {
    if (!this.modulePromise) {
      let promise: Promise<WebAssembly.Module>;
      if (this.options?.wasmBinary) {
        promise = compileWasmModuleAsync(this.options.wasmBinary);
      } else if (this.options?.wasmUrl) {
        promise = compileWasmModuleStreaming(this.options.wasmUrl);
      } else {
        promise = import("./embedded_wasm.ts").then(
          ({ getWebDbCoreWasmBytes }) =>
            compileWasmModuleAsync(getWebDbCoreWasmBytes()),
        );
      }
      this.modulePromise = promise.catch((err) => {
        this.modulePromise = undefined;
        throw err;
      });
    }
    return this.modulePromise;
  }

  async init(memory: WebAssembly.Memory) {
    const wasmModule = await this.loadModule();
    const wasmCore = await instantiateCompiledWasmModule(memory, wasmModule);
    return { vm_step: wasmCore.vm_step, wasmCore };
  }
}
