import {
  AsyncPageStore,
  DATABASE_PAGE_SIZE,
  OperationOutcome,
  SchedulerBridge,
  SchedulerStatus,
  StorageResult,
} from "./protocol.js";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelAndRelease(scheduler: SchedulerBridge, operationId: string): OperationOutcome {
  scheduler.cancelOperation(operationId);
  scheduler.releaseOperation(operationId);
  return { status: SchedulerStatus.Cancelled };
}

// Drives one scheduler operation. The loop makes only one host call at a time and checks the
// abort signal after each await so a late storage response never resumes a cancelled operation.
export async function runOperation(
  scheduler: SchedulerBridge,
  store: AsyncPageStore,
  plan: string,
  signal?: AbortSignal,
): Promise<OperationOutcome> {
  const operationId = scheduler.startOperation(plan);
  if (!operationId || scheduler.lastStartResult() !== StorageResult.Success) {
    return { status: SchedulerStatus.Error, error: "Unable to start scheduler operation." };
  }

  if (signal?.aborted) return cancelAndRelease(scheduler, operationId);

  while (true) {
    const status = scheduler.stepOperation(operationId);

    if (status === SchedulerStatus.PageFault) {
      const pageIds = scheduler.getPendingPageIds(operationId);
      if (pageIds.length !== 1) {
        scheduler.failOperation(operationId, "Scheduler returned an invalid page-fault request.");
        const error = scheduler.getExecutionError(operationId);
        scheduler.releaseOperation(operationId);
        return { status: SchedulerStatus.Error, error };
      }

      try {
        const pages = await store.readPages(pageIds);
        if (signal?.aborted) return cancelAndRelease(scheduler, operationId);
        const pageId = pageIds[0]!;
        const page = pages.get(pageId);
        if (!page || page.byteLength !== DATABASE_PAGE_SIZE ||
            scheduler.providePage(operationId, pageId, page.slice()) !== StorageResult.Success) {
          scheduler.failOperation(operationId, "Host returned an invalid page response.");
        }
      } catch (error) {
        if (signal?.aborted) return cancelAndRelease(scheduler, operationId);
        scheduler.failOperation(operationId, `Page read failed: ${describe(error)}`);
      }
      continue;
    }

    if (status === SchedulerStatus.Flushing) {
      const pages = new Map<number, Uint8Array>();
      for (const pageId of scheduler.getDirtyPageIds(operationId)) {
        const page = scheduler.copyDirtyPage(operationId, pageId);
        if (page.byteLength !== DATABASE_PAGE_SIZE) {
          scheduler.failOperation(operationId, "Scheduler returned an invalid dirty page.");
          break;
        }
        pages.set(pageId, page.slice());
      }

      try {
        await store.writePages(pages);
        if (signal?.aborted) return cancelAndRelease(scheduler, operationId);
        scheduler.finishFlush(operationId, true);
      } catch (error) {
        if (signal?.aborted) return cancelAndRelease(scheduler, operationId);
        scheduler.finishFlush(operationId, false);
      }
      continue;
    }

    if (status === SchedulerStatus.Complete) {
      const result = scheduler.getExecutionResults(operationId);
      scheduler.releaseOperation(operationId);
      return { status, result };
    }

    if (status === SchedulerStatus.Cancelled) {
      scheduler.releaseOperation(operationId);
      return { status };
    }

    const error = scheduler.getExecutionError(operationId) || "Scheduler operation failed.";
    scheduler.releaseOperation(operationId);
    return { status: SchedulerStatus.Error, error };
  }
}
