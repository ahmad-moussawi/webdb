import {
  DATABASE_PAGE_SIZE,
  SchedulerBridge,
  SchedulerStatus,
  StorageResult,
} from "./protocol.js";

interface EmbindEnum {
  readonly value: number;
}

interface EmbindByteVector {
  size(): number;
  get(index: number): number;
  push_back(value: number): void;
  delete?(): void;
}

interface EmbindPageIdVector {
  size(): number;
  get(index: number): number;
  delete?(): void;
}

interface EmbindScheduler {
  startOperation(plan: string): string;
  lastStartResult(): EmbindEnum;
  pageSize(): number;
  stepOperation(operationId: string): EmbindEnum;
  getPendingPageIds(operationId: string): EmbindPageIdVector;
  providePage(operationId: string, pageId: number, bytes: EmbindByteVector): EmbindEnum;
  getDirtyPageIds(operationId: string): EmbindPageIdVector;
  copyDirtyPage(operationId: string, pageId: number): EmbindByteVector;
  finishFlush(operationId: string, success: boolean): EmbindEnum;
  failOperation(operationId: string, message: string): EmbindEnum;
  cancelOperation(operationId: string): void;
  releaseOperation(operationId: string): EmbindEnum;
  getExecutionResults(operationId: string): string;
  getExecutionError(operationId: string): string;
  delete?(): void;
}

export interface WebDbWasmModule {
  OperationScheduler: new () => EmbindScheduler;
  ByteVector: new () => EmbindByteVector;
}

function enumValue(value: EmbindEnum): number {
  return value.value;
}

function copyPage(vector: EmbindByteVector): Uint8Array {
  const bytes = new Uint8Array(vector.size());
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = vector.get(index);
  }
  vector.delete?.();
  return bytes;
}

function copyPageIds(vector: EmbindPageIdVector): number[] {
  const pageIds: number[] = [];
  for (let index = 0; index < vector.size(); index += 1) {
    pageIds.push(vector.get(index));
  }
  vector.delete?.();
  return pageIds;
}

// Adapts generated Embind classes to normal TypeScript values. This is the only place that knows
// about Embind enum wrappers and vectors, keeping the worker coordinator browser-native.
export class WasmSchedulerBridge implements SchedulerBridge {
  private readonly scheduler: EmbindScheduler;

  constructor(private readonly module: WebDbWasmModule) {
    this.scheduler = new module.OperationScheduler();
    if (this.scheduler.pageSize() !== DATABASE_PAGE_SIZE) {
      throw new Error("The loaded WASM module uses an incompatible page size.");
    }
  }

  startOperation(plan: string): string {
    return this.scheduler.startOperation(plan);
  }

  lastStartResult(): StorageResult {
    return enumValue(this.scheduler.lastStartResult()) as StorageResult;
  }

  stepOperation(operationId: string): SchedulerStatus {
    return enumValue(this.scheduler.stepOperation(operationId)) as SchedulerStatus;
  }

  getPendingPageIds(operationId: string): readonly number[] {
    return copyPageIds(this.scheduler.getPendingPageIds(operationId));
  }

  providePage(operationId: string, pageId: number, bytes: Uint8Array): StorageResult {
    if (bytes.byteLength !== DATABASE_PAGE_SIZE) return StorageResult.InvalidArgument;

    const vector = new this.module.ByteVector();
    try {
      for (const byte of bytes) vector.push_back(byte);
      return enumValue(this.scheduler.providePage(operationId, pageId, vector)) as StorageResult;
    } finally {
      vector.delete?.();
    }
  }

  getDirtyPageIds(operationId: string): readonly number[] {
    return copyPageIds(this.scheduler.getDirtyPageIds(operationId));
  }

  copyDirtyPage(operationId: string, pageId: number): Uint8Array {
    return copyPage(this.scheduler.copyDirtyPage(operationId, pageId));
  }

  finishFlush(operationId: string, success: boolean): StorageResult {
    return enumValue(this.scheduler.finishFlush(operationId, success)) as StorageResult;
  }

  failOperation(operationId: string, message: string): StorageResult {
    return enumValue(this.scheduler.failOperation(operationId, message)) as StorageResult;
  }

  cancelOperation(operationId: string): void {
    this.scheduler.cancelOperation(operationId);
  }

  releaseOperation(operationId: string): StorageResult {
    return enumValue(this.scheduler.releaseOperation(operationId)) as StorageResult;
  }

  getExecutionResults(operationId: string): string {
    return this.scheduler.getExecutionResults(operationId);
  }

  getExecutionError(operationId: string): string {
    return this.scheduler.getExecutionError(operationId);
  }

  dispose(): void {
    this.scheduler.delete?.();
  }
}
