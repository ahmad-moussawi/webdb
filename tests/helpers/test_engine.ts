import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import type { WebDbCoreEngine } from "@ahmadmoussawi/webdb/slim";

export function testEngine(): WebDbCoreEngine {
  const mode =
    (globalThis as any).process?.env?.WEBDB_CORE ??
    (globalThis as any).__WEBDB_DEFAULT_CORE__;
  return mode === "wasm" ? new WasmEngine() : new JsEngine();
}
