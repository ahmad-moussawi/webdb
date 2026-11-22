/**
 * Subpath entry: `@ahmadmoussawi/webdb/core/js`
 *
 * Allows explicit JS VM engine injection into `WebDB.open({ engine: new JsEngine(), storage })`
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
 * Pluggable pure-JavaScript VM core engine for `WebDB.open({ engine: new JsEngine(), storage })`.
 */
export class JsEngine implements WebDbCoreEngine {
  readonly mode = "js" as const;

  init() {
    return { vm_step };
  }
}
