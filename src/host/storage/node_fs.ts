import { mkdir, open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { IVfsAdapter } from './vfs.js';

const PAGE_SIZE = 4096;
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_SIZE = 4128;

interface NodeFileHandleLike {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  stat(): Promise<{ size: number }>;
  truncate(len: number): Promise<void>;
  datasync(): Promise<void>;
  close(): Promise<void>;
}

export interface NodeFsStorageOptions {
  /**
   * Optional explicit path for the Write-Ahead Log file.
   * Defaults to replacing a trailing `.db` extension with `.wal`, or appending `.wal`.
   */
  walPath?: string;
  /**
   * Open the database and WAL files strictly read-only.
   * Any mutating VFS operation throws an error.
   * Defaults to `false`.
   */
  readOnly?: boolean;
  /**
   * Create the database file (and parent directories) if it does not exist.
   * Ignored when `readOnly` is `true`. Defaults to `true`.
   */
  create?: boolean;
  /**
   * Optional logical database name exposed via `IVfsAdapter.databaseName`.
   */
  databaseName?: string;
}

function defaultWalPath(dbPath: string): string {
  if (/\.db$/i.test(dbPath)) {
    return dbPath.slice(0, -3) + '.wal';
  }
  return `${dbPath}.wal`;
}

function defaultDatabaseName(dbPath: string): string {
  const base = basename(dbPath);
  return /\.db$/i.test(base) ? base.slice(0, -3) : base;
}

function isErrCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function assertNonNegativeInt(val: number, name: string): void {
  if (!Number.isInteger(val) || val < 0) {
    throw new RangeError(`Invalid ${name}: ${val}. Expected a non-negative integer`);
  }
}

function assertPositivePageId(pageId: number): void {
  if (!Number.isInteger(pageId) || pageId < 1) {
    throw new RangeError(`Invalid pageId: ${pageId}. Expected an integer >= 1`);
  }
}

async function readFully(
  handle: NodeFileHandleLike,
  buffer: Uint8Array,
  position: number,
): Promise<number> {
  let totalRead = 0;
  while (totalRead < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      buffer.byteLength - totalRead,
      position + totalRead,
    );
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  return totalRead;
}

async function writeFully(
  handle: NodeFileHandleLike,
  buffer: Uint8Array,
  position: number,
): Promise<void> {
  let totalWritten = 0;
  while (totalWritten < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      totalWritten,
      buffer.byteLength - totalWritten,
      position + totalWritten,
    );
    if (bytesWritten === 0) {
      throw new Error(`Short write at file offset ${position + totalWritten}`);
    }
    totalWritten += bytesWritten;
  }
}

/**
 * Node.js filesystem VFS storage adapter (`@ahmadmoussawi/webdb/storage/node`).
 *
 * Persists 4 KB database pages to `<dbPath>` and 4,128-byte WAL frames to `<walPath>`,
 * using the exact same on-disk binary format as `OpfsStorage` and `WebDB.exportBinary()`.
 */
export class NodeFsStorage implements IVfsAdapter {
  readonly name = 'node-fs' as const;
  readonly databaseName: string;
  readonly isSynchronous = false;
  readonly dbPath: string;
  readonly walPath: string;
  readonly readOnly: boolean;

  private readonly create: boolean;
  private dbHandle: NodeFileHandleLike | null = null;
  private walHandle: NodeFileHandleLike | null = null;
  private dbHandlePromise: Promise<NodeFileHandleLike> | null = null;
  private walHandlePromise: Promise<NodeFileHandleLike | null> | null = null;
  private closeGeneration = 0;

  constructor(dbPath: string, options: NodeFsStorageOptions = {}) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('NodeFsStorage requires a non-empty file path');
    }
    this.dbPath = dbPath;
    this.walPath = options.walPath ?? defaultWalPath(dbPath);
    this.readOnly = options.readOnly ?? false;
    this.create = this.readOnly ? false : (options.create ?? true);
    this.databaseName = options.databaseName ?? defaultDatabaseName(dbPath);
  }

  private assertWritable(op: string): void {
    if (this.readOnly) {
      throw new Error(`Cannot ${op}: NodeFsStorage is opened in read-only mode (${this.dbPath})`);
    }
  }

  private async openFileSafe(
    filePath: string,
    forWrite: boolean,
    allowCreate: boolean,
  ): Promise<NodeFileHandleLike | null> {
    if (this.readOnly) {
      try {
        return (await open(filePath, 'r')) as unknown as NodeFileHandleLike;
      } catch (err) {
        if (!forWrite && isErrCode(err, 'ENOENT')) {
          return null;
        }
        throw err;
      }
    }

    try {
      return (await open(filePath, 'r+')) as unknown as NodeFileHandleLike;
    } catch (err) {
      if (!isErrCode(err, 'ENOENT')) {
        throw err;
      }
      if (!allowCreate) {
        return null;
      }
      await mkdir(dirname(filePath), { recursive: true });
      try {
        return (await open(filePath, 'wx+')) as unknown as NodeFileHandleLike;
      } catch (createErr) {
        if (isErrCode(createErr, 'EEXIST')) {
          return (await open(filePath, 'r+')) as unknown as NodeFileHandleLike;
        }
        throw createErr;
      }
    }
  }

  private async ensureDbHandle(forWrite: boolean): Promise<NodeFileHandleLike> {
    if (forWrite) {
      this.assertWritable('write database pages');
    }
    if (this.dbHandle) return this.dbHandle;
    if (this.dbHandlePromise) return this.dbHandlePromise;

    const gen = this.closeGeneration;
    const opening = (async (): Promise<NodeFileHandleLike> => {
      const handle = await this.openFileSafe(this.dbPath, forWrite, this.create);
      if (!handle) {
        throw new Error(`Database file not found: ${this.dbPath}`);
      }
      if (this.closeGeneration !== gen) {
        await handle.close().catch(() => {});
        throw new Error(`NodeFsStorage was closed while opening: ${this.dbPath}`);
      }
      this.dbHandle = handle;
      return handle;
    })();

    this.dbHandlePromise = opening;
    try {
      return await opening;
    } finally {
      if (this.dbHandlePromise === opening) {
        this.dbHandlePromise = null;
      }
    }
  }

  private async ensureWalHandle(forWrite: boolean): Promise<NodeFileHandleLike | null> {
    if (forWrite) {
      this.assertWritable('write WAL');
    }
    if (this.walHandle) return this.walHandle;

    if (this.walHandlePromise) {
      const existing = await this.walHandlePromise;
      if (existing || !forWrite) return existing;
      if (this.walHandle) return this.walHandle;
    }

    const gen = this.closeGeneration;
    const opening = (async (): Promise<NodeFileHandleLike | null> => {
      // Never create an empty .wal file on read-only checks or when merely probing for a WAL
      const handle = await this.openFileSafe(this.walPath, forWrite, forWrite);
      if (!handle) return null;
      if (this.closeGeneration !== gen) {
        await handle.close().catch(() => {});
        if (forWrite) {
          throw new Error(`NodeFsStorage was closed while opening WAL: ${this.walPath}`);
        }
        return null;
      }
      this.walHandle = handle;
      return handle;
    })();

    this.walHandlePromise = opening;
    try {
      return await opening;
    } finally {
      if (this.walHandlePromise === opening) {
        this.walHandlePromise = null;
      }
    }
  }

  async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    if (pageIds.length === 0) return [];
    const handle = await this.ensureDbHandle(false);
    const { size } = await handle.stat();

    // Fast path for contiguous ascending valid page IDs (>= 1)
    let isContiguous =
      pageIds.length >= 2 && Number.isInteger(pageIds[0]) && pageIds[0] >= 1;
    if (isContiguous) {
      for (let i = 1; i < pageIds.length; i++) {
        if (pageIds[i] !== pageIds[i - 1] + 1) {
          isContiguous = false;
          break;
        }
      }
    }

    if (isContiguous) {
      const startOffset = (pageIds[0] - 1) * PAGE_SIZE;
      if (startOffset >= size) {
        return new Array(pageIds.length).fill(null);
      }
      const readablePages = Math.min(
        pageIds.length,
        Math.floor((size - startOffset) / PAGE_SIZE),
      );
      const results: Array<Uint8Array | null> = new Array(pageIds.length).fill(null);
      if (readablePages > 0) {
        const bulk = new Uint8Array(readablePages * PAGE_SIZE);
        const bytesRead = await readFully(handle, bulk, startOffset);
        const completePages = Math.floor(bytesRead / PAGE_SIZE);
        for (let i = 0; i < completePages; i++) {
          results[i] = bulk.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
        }
      }
      return results;
    }

    const results: Array<Uint8Array | null> = new Array(pageIds.length).fill(null);
    for (let i = 0; i < pageIds.length; i++) {
      const pageId = pageIds[i];
      if (!Number.isInteger(pageId) || pageId < 1) {
        results[i] = null;
        continue;
      }
      const offset = (pageId - 1) * PAGE_SIZE;
      if (offset + PAGE_SIZE > size) {
        results[i] = null;
        continue;
      }
      const buf = new Uint8Array(PAGE_SIZE);
      const bytesRead = await readFully(handle, buf, offset);
      results[i] = bytesRead === PAGE_SIZE ? buf : null;
    }
    return results;
  }

  /**
   * Coalesces contiguous runs of sorted pages into single buffers so writePages()
   * issues one write syscall per contiguous run.
   */
  private coalesceWriteRuns(
    pages: Array<{ pageId: number; data: Uint8Array }>,
  ): Array<{ offset: number; data: Uint8Array }> {
    if (pages.length === 1) {
      return [{ offset: (pages[0].pageId - 1) * PAGE_SIZE, data: pages[0].data }];
    }

    let sorted = pages;
    for (let i = 1; i < pages.length; i++) {
      if (pages[i].pageId < pages[i - 1].pageId) {
        sorted = [...pages].sort((a, b) => a.pageId - b.pageId);
        break;
      }
    }

    const runs: Array<{ offset: number; data: Uint8Array }> = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      while (j < sorted.length && sorted[j].pageId === sorted[j - 1].pageId + 1) {
        j++;
      }
      const startOffset = (sorted[i].pageId - 1) * PAGE_SIZE;
      if (j === i + 1) {
        runs.push({ offset: startOffset, data: sorted[i].data });
      } else {
        const count = j - i;
        const combined = new Uint8Array(count * PAGE_SIZE);
        for (let k = 0; k < count; k++) {
          combined.set(sorted[i + k].data, k * PAGE_SIZE);
        }
        runs.push({ offset: startOffset, data: combined });
      }
      i = j;
    }
    return runs;
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    this.assertWritable('writePages');
    if (pages.length === 0) return;
    for (const p of pages) {
      assertPositivePageId(p.pageId);
      if (p.data.byteLength !== PAGE_SIZE) {
        throw new RangeError(
          `Invalid page buffer length for page ${p.pageId}: expected ${PAGE_SIZE} bytes, got ${p.data.byteLength}`,
        );
      }
    }
    const handle = await this.ensureDbHandle(true);
    const runs = this.coalesceWriteRuns(pages);
    for (const run of runs) {
      await writeFully(handle, run.data, run.offset);
    }
  }

  async flush(): Promise<void> {
    if (this.readOnly || !this.dbHandle) return;
    await this.dbHandle.datasync();
  }

  async truncate(pageCount: number): Promise<void> {
    this.assertWritable('truncate');
    assertNonNegativeInt(pageCount, 'pageCount');
    const handle = await this.ensureDbHandle(true);
    await handle.truncate(pageCount * PAGE_SIZE);
  }

  // --- Write-Ahead Log Methods ---

  async readWalHeader(): Promise<Uint8Array | null> {
    const handle = await this.ensureWalHandle(false);
    if (!handle) return null;
    const { size } = await handle.stat();
    if (size < WAL_HEADER_SIZE) return null;
    const header = new Uint8Array(WAL_HEADER_SIZE);
    const bytesRead = await readFully(handle, header, 0);
    return bytesRead === WAL_HEADER_SIZE ? header : null;
  }

  async writeWalHeader(header: Uint8Array): Promise<void> {
    this.assertWritable('writeWalHeader');
    const handle = await this.ensureWalHandle(true);
    if (!handle) {
      throw new Error(`Failed to open WAL file for writing: ${this.walPath}`);
    }
    await writeFully(handle, header, 0);
  }

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    assertNonNegativeInt(startFrameIndex, 'startFrameIndex');
    if (maxFrames !== undefined) {
      assertNonNegativeInt(maxFrames, 'maxFrames');
      if (maxFrames === 0) return [];
    }

    const handle = await this.ensureWalHandle(false);
    if (!handle) return [];
    const { size } = await handle.stat();
    const startOffset = WAL_HEADER_SIZE + startFrameIndex * WAL_FRAME_SIZE;
    if (startOffset >= size) return [];

    const availableBytes = size - startOffset;
    const bytesToRead =
      maxFrames !== undefined
        ? Math.min(availableBytes, maxFrames * WAL_FRAME_SIZE)
        : availableBytes;
    if (bytesToRead <= 0) return [];

    const bulk = new Uint8Array(bytesToRead);
    const actualRead = await readFully(handle, bulk, startOffset);
    const frames: Uint8Array[] = [];
    for (let off = 0; off < actualRead; off += WAL_FRAME_SIZE) {
      const end = Math.min(off + WAL_FRAME_SIZE, actualRead);
      frames.push(bulk.slice(off, end));
    }
    return frames;
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    this.assertWritable('appendWalFrames');
    if (frames.length === 0) return;
    const handle = await this.ensureWalHandle(true);
    if (!handle) {
      throw new Error(`Failed to open WAL file for writing: ${this.walPath}`);
    }

    let payload: Uint8Array;
    if (frames.length === 1) {
      payload = frames[0];
    } else {
      let totalLen = 0;
      for (const f of frames) totalLen += f.byteLength;
      payload = new Uint8Array(totalLen);
      let pos = 0;
      for (const f of frames) {
        payload.set(f, pos);
        pos += f.byteLength;
      }
    }

    const { size } = await handle.stat();
    const offset = Math.max(WAL_HEADER_SIZE, size);
    await writeFully(handle, payload, offset);
  }

  async flushWal(): Promise<void> {
    if (this.readOnly || !this.walHandle) return;
    await this.walHandle.datasync();
  }

  async truncateWal(frameIndex: number): Promise<void> {
    this.assertWritable('truncateWal');
    assertNonNegativeInt(frameIndex, 'frameIndex');
    if (frameIndex === 0) {
      const handle = await this.ensureWalHandle(false);
      if (!handle) return;
      await handle.truncate(0);
      return;
    }
    const handle = await this.ensureWalHandle(true);
    if (!handle) return;
    await handle.truncate(WAL_HEADER_SIZE + frameIndex * WAL_FRAME_SIZE);
  }

  async getWalFrameCount(): Promise<number> {
    const handle = await this.ensureWalHandle(false);
    if (!handle) return 0;
    const { size } = await handle.stat();
    if (size <= WAL_HEADER_SIZE) return 0;
    return Math.ceil((size - WAL_HEADER_SIZE) / WAL_FRAME_SIZE);
  }

  async close(): Promise<void> {
    this.closeGeneration++;
    const pendingDb = this.dbHandlePromise;
    const pendingWal = this.walHandlePromise;
    this.dbHandlePromise = null;
    this.walHandlePromise = null;

    if (pendingDb) await pendingDb.catch(() => {});
    if (pendingWal) await pendingWal.catch(() => {});

    const db = this.dbHandle;
    const wal = this.walHandle;
    this.dbHandle = null;
    this.walHandle = null;
    try {
      if (db) await db.close();
    } finally {
      if (wal) await wal.close();
    }
  }
}
