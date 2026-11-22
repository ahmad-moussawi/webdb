/**
 * WebDB WebAssembly Core Adapter
 * Wraps compiled C WebAssembly exports with 1:1 API parity to the JS Core.
 */

import { getWebDbCoreWasmBytes } from "./embedded_wasm.ts";
import {
  instantiateWasmCore,
  instantiateWasmCoreAsync,
  instantiateWasmCoreStreaming,
  type WasmCoreExports,
} from "./wasm_runtime.ts";

export {
  instantiateWasmCore,
  instantiateWasmCoreAsync,
  instantiateWasmCoreStreaming,
  type WasmCoreExports,
};

export function createWasmCore(
  memory: WebAssembly.Memory,
  customBytes?: Uint8Array,
): WasmCoreExports {
  const bytes = customBytes ?? getWebDbCoreWasmBytes();
  return instantiateWasmCore(memory, bytes);
}
