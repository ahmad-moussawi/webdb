import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAsyncPageStore } from "../src/in-memory-page-store.js";
import { runOperation } from "../src/operation-coordinator.js";
import { DATABASE_PAGE_SIZE, SchedulerStatus, StorageResult } from "../src/protocol.js";
import { WasmSchedulerBridge, WebDbWasmModule } from "../src/wasm-scheduler-bridge.js";

async function loadWasmModule(): Promise<WebDbWasmModule> {
  const moduleUrl = new URL("../../dist/wasm/webdb.js", import.meta.url);
  const loaded = await import(moduleUrl.href) as { default: () => Promise<WebDbWasmModule> };
  return loaded.default();
}

test("TypeScript coordinator drives the compiled WASM scheduler", async () => {
  const module = await loadWasmModule();
  const scheduler = new WasmSchedulerBridge(module);
  const store = new InMemoryAsyncPageStore(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE)]]));
  const plan = '{"version":1,"reads":[2],"writes":[{"page_id":2,"byte_offset":12,"value":88}]}';

  const outcome = await runOperation(scheduler, store, plan);

  assert.deepEqual(outcome, { status: SchedulerStatus.Complete, result: "{}" });
  const persisted = await store.readPages([2]);
  assert.equal(persisted.get(2)?.[12], 88);
  scheduler.dispose();
});

test("WASM bridge rejects a non-page-sized host buffer before crossing into WASM", async () => {
  const module = await loadWasmModule();
  const scheduler = new WasmSchedulerBridge(module);
  const operationId = scheduler.startOperation('{"version":1,"reads":[2]}');

  assert.equal(scheduler.stepOperation(operationId), SchedulerStatus.PageFault);
  assert.equal(scheduler.providePage(operationId, 2, new Uint8Array(DATABASE_PAGE_SIZE - 1)),
               StorageResult.InvalidArgument);
  assert.equal(scheduler.stepOperation(operationId), SchedulerStatus.PageFault);
  scheduler.cancelOperation(operationId);
  scheduler.releaseOperation(operationId);
  scheduler.dispose();
});

test("WASM bridge rejects invalid JavaScript page IDs before Embind coercion", async () => {
  const module = await loadWasmModule();
  const scheduler = new WasmSchedulerBridge(module);
  const operationId = scheduler.startOperation('{"version":1,"reads":[2]}');
  const validPage = new Uint8Array(DATABASE_PAGE_SIZE);

  assert.equal(scheduler.stepOperation(operationId), SchedulerStatus.PageFault);
  for (const invalidPageId of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 1, 2_147_483_648]) {
    assert.equal(scheduler.providePage(operationId, invalidPageId, validPage), StorageResult.InvalidArgument);
    assert.equal(scheduler.stepOperation(operationId), SchedulerStatus.PageFault);
  }

  scheduler.cancelOperation(operationId);
  scheduler.releaseOperation(operationId);
  scheduler.dispose();
});
