/**
 * Subpath entry: `@ahmadmoussawi/webdb/core/js`
 *
 * Allows explicit JS VM engine injection into `WebDB.open({ engine: createJsEngine() })`
 * without pulling in any WebAssembly runtime or embedded WASM bytes.
 */

import { vm_step, vm_step_raw } from "./vm.c.ts";
import {
  executeVmStepWithRunner,
  sql_like_match,
  compare_sorter_keys,
  fnv1a_32,
  type VmStepFn,
  type WebDbCoreEngine,
} from "./vm_host.ts";

export {
  vm_step,
  vm_step_raw,
  executeVmStepWithRunner,
  sql_like_match,
  compare_sorter_keys,
  fnv1a_32,
  type VmStepFn,
  type WebDbCoreEngine,
};

/**
 * Creates a pluggable JS VM core engine descriptor for `WebDB.open({ engine })`.
 */
export function createJsEngine(): WebDbCoreEngine {
  return {
    mode: "js",
    init() {
      return { vm_step };
    },
  };
}
