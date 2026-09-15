import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAsyncPageStore } from "../src/in-memory-page-store.js";
import { runOperation } from "../src/operation-coordinator.js";
import { DATABASE_PAGE_SIZE, SchedulerBridge, SchedulerStatus, StorageResult } from "../src/protocol.js";

class SchedulerMock implements SchedulerBridge {
  private status = SchedulerStatus.Ready;
  private readonly page = new Uint8Array(DATABASE_PAGE_SIZE);
  private released = false;
  private error = "";
  private flushCompleted = false;
  public providedPages = 0;
  public flushes: boolean[] = [];

  startOperation(_plan: string): string {
    return "1";
  }

  lastStartResult(): StorageResult {
    return StorageResult.Success;
  }

  stepOperation(_operationId: string): SchedulerStatus {
    if (this.status === SchedulerStatus.Ready) {
      this.status = this.flushCompleted ? SchedulerStatus.Complete : SchedulerStatus.PageFault;
    }
    return this.status;
  }

  getPendingPageIds(_operationId: string): readonly number[] {
    return this.status === SchedulerStatus.PageFault ? [2] : [];
  }

  providePage(_operationId: string, pageId: number, bytes: Uint8Array): StorageResult {
    if (this.status !== SchedulerStatus.PageFault || pageId !== 2 || bytes.byteLength !== DATABASE_PAGE_SIZE) {
      return StorageResult.InvalidArgument;
    }
    this.page.set(bytes);
    this.page[8] = 99;
    this.providedPages += 1;
    this.status = SchedulerStatus.Flushing;
    return StorageResult.Success;
  }

  getDirtyPageIds(_operationId: string): readonly number[] {
    return this.status === SchedulerStatus.Flushing ? [2] : [];
  }

  copyDirtyPage(_operationId: string, pageId: number): Uint8Array {
    return pageId === 2 && this.status === SchedulerStatus.Flushing ? this.page.slice() : new Uint8Array();
  }

  finishFlush(_operationId: string, success: boolean): StorageResult {
    this.flushes.push(success);
    if (success) {
      this.flushCompleted = true;
      this.status = SchedulerStatus.Ready;
    } else {
      this.status = SchedulerStatus.Error;
      this.error = "The host failed to flush dirty pages.";
    }
    return StorageResult.Success;
  }

  failOperation(_operationId: string, message: string): StorageResult {
    this.status = SchedulerStatus.Error;
    this.error = message;
    return StorageResult.Success;
  }

  cancelOperation(_operationId: string): void {
    if (this.status !== SchedulerStatus.Complete && this.status !== SchedulerStatus.Error) {
      this.status = SchedulerStatus.Cancelled;
    }
  }

  releaseOperation(_operationId: string): StorageResult {
    this.released = true;
    return StorageResult.Success;
  }

  getExecutionResults(_operationId: string): string {
    return this.status === SchedulerStatus.Complete ? "{}" : "";
  }

  getExecutionError(_operationId: string): string {
    return this.error;
  }

  get isReleased(): boolean {
    return this.released;
  }
}

test("coordinator reads, writes, flushes, and releases an operation", async () => {
  const scheduler = new SchedulerMock();
  const store = new InMemoryAsyncPageStore(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE)]]));

  const outcome = await runOperation(scheduler, store, "{} ");

  assert.deepEqual(outcome, { status: SchedulerStatus.Complete, result: "{}" });
  assert.equal(scheduler.providedPages, 1);
  assert.deepEqual(scheduler.flushes, [true]);
  assert.equal(scheduler.isReleased, true);

  const persisted = await store.readPages([2]);
  assert.equal(persisted.get(2)?.[8], 99);
});

test("coordinator reports a read failure and releases the operation", async () => {
  const scheduler = new SchedulerMock();
  const store = new InMemoryAsyncPageStore(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE)]]));
  store.failReads = true;

  const outcome = await runOperation(scheduler, store, "{}");

  assert.equal(outcome.status, SchedulerStatus.Error);
  if (outcome.status === SchedulerStatus.Error) {
    assert.match(outcome.error, /Page read failed/);
  }
  assert.equal(scheduler.isReleased, true);
});

test("coordinator reports a flush failure and never claims completion", async () => {
  const scheduler = new SchedulerMock();
  const store = new InMemoryAsyncPageStore(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE)]]));
  store.failWrites = true;

  const outcome = await runOperation(scheduler, store, "{}");

  assert.equal(outcome.status, SchedulerStatus.Error);
  assert.deepEqual(scheduler.flushes, [false]);
  assert.equal(scheduler.isReleased, true);
});

test("coordinator drops a late read response after cancellation", async () => {
  const scheduler = new SchedulerMock();
  const controller = new AbortController();
  let resolveRead: ((pages: Map<number, Uint8Array>) => void) | undefined;
  const store = {
    readPages: () => new Promise<Map<number, Uint8Array>>((resolve) => {
      resolveRead = resolve;
    }),
    writePages: async () => assert.fail("Cancelled operation must not write pages"),
  };

  const outcomePromise = runOperation(scheduler, store, "{}", controller.signal);
  controller.abort();
  resolveRead?.(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE)]]));
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { status: SchedulerStatus.Cancelled });
  assert.equal(scheduler.providedPages, 0);
  assert.equal(scheduler.isReleased, true);
});

test("coordinator drops a late write completion after cancellation", async () => {
  const scheduler = new SchedulerMock();
  const controller = new AbortController();
  let resolveWrite: (() => void) | undefined;
  const store = {
    readPages: async () => new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE)]]),
    writePages: () => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }),
  };

  const outcomePromise = runOperation(scheduler, store, "{}", controller.signal);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.abort();
  resolveWrite?.();
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { status: SchedulerStatus.Cancelled });
  assert.deepEqual(scheduler.flushes, []);
  assert.equal(scheduler.isReleased, true);
});
