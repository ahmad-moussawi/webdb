import { IVfsAdapter } from './vfs.js';

export class OpfsStorage implements IVfsAdapter {
  readonly name = 'opfs' as const;
  readonly databaseName: string;
  readonly isSynchronous: boolean;

  private dbName: string;
  private rootDir: FileSystemDirectoryHandle | null = null;
  private dbFileHandle: FileSystemFileHandle | null = null;
  private walFileHandle: FileSystemFileHandle | null = null;

  // SyncAccessHandles (available in Dedicated Web Workers)
  private dbSyncHandle: any = null;
  private walSyncHandle: any = null;

  constructor(dbName: string) {
    this.databaseName = dbName;
    this.dbName = dbName;
    this.isSynchronous = typeof (globalThis as any).FileSystemSyncAccessHandle !== 'undefined';
  }

  private async initHandles(): Promise<void> {
    if (this.rootDir) return;

    if (!navigator?.storage?.getDirectory) {
      throw new Error('OPFS (Origin Private File System) is not available in the current environment');
    }

    this.rootDir = await navigator.storage.getDirectory();
    this.dbFileHandle = await this.rootDir.getFileHandle(`${this.dbName}.db`, { create: true });
    this.walFileHandle = await this.rootDir.getFileHandle(`${this.dbName}.wal`, { create: true });

    if (this.isSynchronous) {
      try {
        this.dbSyncHandle = await (this.dbFileHandle as any).createSyncAccessHandle();
        this.walSyncHandle = await (this.walFileHandle as any).createSyncAccessHandle();
      } catch {
        // Fallback to async handles if sync handles cannot be acquired
      }
    }
  }

  async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    if (pageIds.length === 0) return [];
    await this.initHandles();

    // Helper: check if pageIds is strictly consecutive ascending (e.g. exportBinary 1..N)
    let isContiguous = pageIds.length >= 2;
    if (isContiguous) {
      for (let i = 1; i < pageIds.length; i++) {
        if (pageIds[i] !== pageIds[i - 1] + 1) {
          isContiguous = false;
          break;
        }
      }
    }

    if (this.dbSyncHandle) {
      const size = this.dbSyncHandle.getSize();
      if (isContiguous) {
        const startOffset = (pageIds[0] - 1) * 4096;
        if (startOffset >= size) {
          return new Array(pageIds.length).fill(null);
        }
        const readablePages = Math.min(
          pageIds.length,
          Math.floor((size - startOffset) / 4096),
        );
        const results: Array<Uint8Array | null> = new Array(pageIds.length).fill(null);
        if (readablePages > 0) {
          const bulk = new Uint8Array(readablePages * 4096);
          this.dbSyncHandle.read(bulk, { at: startOffset });
          for (let i = 0; i < readablePages; i++) {
            results[i] = bulk.slice(i * 4096, (i + 1) * 4096);
          }
        }
        return results;
      }

      return pageIds.map((pageId) => {
        const offset = (pageId - 1) * 4096;
        if (offset + 4096 > size) return null;
        const buffer = new Uint8Array(4096);
        this.dbSyncHandle.read(buffer, { at: offset });
        return buffer;
      });
    }

    const file = await this.dbFileHandle!.getFile();
    if (isContiguous) {
      const startOffset = (pageIds[0] - 1) * 4096;
      if (startOffset >= file.size) {
        return new Array(pageIds.length).fill(null);
      }
      const readablePages = Math.min(
        pageIds.length,
        Math.floor((file.size - startOffset) / 4096),
      );
      const results: Array<Uint8Array | null> = new Array(pageIds.length).fill(null);
      if (readablePages > 0) {
        const bulkBuf = await file
          .slice(startOffset, startOffset + readablePages * 4096)
          .arrayBuffer();
        const bulk = new Uint8Array(bulkBuf);
        for (let i = 0; i < readablePages; i++) {
          results[i] = bulk.slice(i * 4096, (i + 1) * 4096);
        }
      }
      return results;
    }

    return Promise.all(
      pageIds.map(async (pageId) => {
        const offset = (pageId - 1) * 4096;
        if (offset + 4096 > file.size) {
          return null;
        }
        const arrayBuf = await file.slice(offset, offset + 4096).arrayBuffer();
        return new Uint8Array(arrayBuf);
      }),
    );
  }

  /**
   * Coalesces contiguous runs of sorted pages into single buffers so writePages()
   * issues 1 write syscall/IPC per contiguous run instead of 1 per 4 KB page.
   */
  private coalesceWriteRuns(
    pages: Array<{ pageId: number; data: Uint8Array }>,
  ): Array<{ offset: number; data: Uint8Array }> {
    if (pages.length === 1) {
      return [{ offset: (pages[0].pageId - 1) * 4096, data: pages[0].data }];
    }

    // Sort a shallow copy if not already sorted by pageId
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
      const startOffset = (sorted[i].pageId - 1) * 4096;
      if (j === i + 1) {
        runs.push({ offset: startOffset, data: sorted[i].data });
      } else {
        const count = j - i;
        const combined = new Uint8Array(count * 4096);
        for (let k = 0; k < count; k++) {
          combined.set(sorted[i + k].data, k * 4096);
        }
        runs.push({ offset: startOffset, data: combined });
      }
      i = j;
    }
    return runs;
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    if (pages.length === 0) return;
    await this.initHandles();

    const runs = this.coalesceWriteRuns(pages);

    if (this.dbSyncHandle) {
      for (const run of runs) {
        this.dbSyncHandle.write(run.data, { at: run.offset });
      }
      return;
    }

    const writable = await (this.dbFileHandle as any).createWritable({ keepExistingData: true });
    for (const run of runs) {
      await writable.seek(run.offset);
      await writable.write(run.data);
    }
    await writable.close();
  }

  async flush(): Promise<void> {
    if (this.dbSyncHandle) {
      this.dbSyncHandle.flush();
    }
  }

  async truncate(pageCount: number): Promise<void> {
    await this.initHandles();
    const newSize = pageCount * 4096;
    if (this.dbSyncHandle) {
      this.dbSyncHandle.truncate(newSize);
      return;
    }
    const writable = await (this.dbFileHandle as any).createWritable({ keepExistingData: true });
    await writable.truncate(newSize);
    await writable.close();
  }

  // --- Write-Ahead Log Methods ---

  async readWalHeader(): Promise<Uint8Array | null> {
    await this.initHandles();
    if (this.walSyncHandle) {
      const size = this.walSyncHandle.getSize();
      if (size < 32) return null;
      const header = new Uint8Array(32);
      this.walSyncHandle.read(header, { at: 0 });
      return header;
    }
    const file = await this.walFileHandle!.getFile();
    if (file.size < 32) return null;
    const slice = file.slice(0, 32);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async writeWalHeader(header: Uint8Array): Promise<void> {
    await this.initHandles();
    if (this.walSyncHandle) {
      this.walSyncHandle.write(header, { at: 0 });
      return;
    }
    const writable = await (this.walFileHandle as any).createWritable({ keepExistingData: true });
    await writable.seek(0);
    await writable.write(header);
    await writable.close();
  }

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    await this.initHandles();
    const startOffset = 32 + startFrameIndex * 4128;

    const sliceFramesFromBulk = (bulk: Uint8Array): Uint8Array[] => {
      const frames: Uint8Array[] = [];
      for (let off = 0; off < bulk.byteLength; off += 4128) {
        const end = Math.min(off + 4128, bulk.byteLength);
        frames.push(bulk.slice(off, end));
      }
      return frames;
    };

    if (this.walSyncHandle) {
      const size = this.walSyncHandle.getSize();
      if (startOffset >= size) return [];
      const availableBytes = size - startOffset;
      const bytesToRead =
        maxFrames !== undefined
          ? Math.min(availableBytes, maxFrames * 4128)
          : availableBytes;
      if (bytesToRead <= 0) return [];
      const bulk = new Uint8Array(bytesToRead);
      this.walSyncHandle.read(bulk, { at: startOffset });
      return sliceFramesFromBulk(bulk);
    }

    const file = await this.walFileHandle!.getFile();
    if (startOffset >= file.size) return [];
    const availableBytes = file.size - startOffset;
    const bytesToRead =
      maxFrames !== undefined
        ? Math.min(availableBytes, maxFrames * 4128)
        : availableBytes;
    if (bytesToRead <= 0) return [];
    const bulk = new Uint8Array(
      await file.slice(startOffset, startOffset + bytesToRead).arrayBuffer(),
    );
    return sliceFramesFromBulk(bulk);
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    if (frames.length === 0) return;
    await this.initHandles();

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

    if (this.walSyncHandle) {
      const offset = Math.max(32, this.walSyncHandle.getSize());
      this.walSyncHandle.write(payload, { at: offset });
      return;
    }
    const file = await this.walFileHandle!.getFile();
    const writable = await (this.walFileHandle as any).createWritable({ keepExistingData: true });
    await writable.seek(Math.max(32, file.size));
    await writable.write(payload);
    await writable.close();
  }

  async flushWal(): Promise<void> {
    if (this.walSyncHandle) {
      this.walSyncHandle.flush();
    }
  }

  async truncateWal(frameIndex: number): Promise<void> {
    await this.initHandles();
    const newSize = frameIndex === 0 ? 0 : 32 + frameIndex * 4128;
    if (this.walSyncHandle) {
      this.walSyncHandle.truncate(newSize);
      return;
    }
    const writable = await (this.walFileHandle as any).createWritable({
      keepExistingData: frameIndex > 0,
    });
    await writable.truncate(newSize);
    await writable.close();
  }

  async getWalFrameCount(): Promise<number> {
    await this.initHandles();
    let size = 0;
    if (this.walSyncHandle) {
      size = this.walSyncHandle.getSize();
    } else {
      const file = await this.walFileHandle!.getFile();
      size = file.size;
    }
    if (size <= 32) return 0;
    return Math.ceil((size - 32) / 4128);
  }

  /**
   * Atomically replaces all database pages and resets the WAL header.
   * Uses FileSystemWritableFileStream atomic swap when async handles are active,
   * or stages to a temporary OPFS file (with `.move()` atomic swap when supported)
   * before updating SyncAccessHandles so failures never tear the live database.
   */
  async replaceDatabaseAtomic(
    pages: Array<{ pageId: number; data: Uint8Array }>,
    walHeader: Uint8Array,
  ): Promise<void> {
    if (pages.length === 0) {
      throw new RangeError("replaceDatabaseAtomic requires at least 1 page");
    }
    await this.initHandles();

    const sorted = [...pages].sort((a, b) => a.pageId - b.pageId);
    const fullDb = new Uint8Array(sorted.length * 4096);
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      if (p.pageId !== i + 1) {
        throw new RangeError(
          `replaceDatabaseAtomic requires contiguous pages 1..${sorted.length}`,
        );
      }
      if (p.data.byteLength !== 4096) {
        throw new RangeError(
          `Invalid page buffer length for page ${p.pageId}: expected 4096 bytes, got ${p.data.byteLength}`,
        );
      }
      fullDb.set(p.data, i * 4096);
    }

    const writeWritableAbortSafe = async (
      fileHandle: FileSystemFileHandle,
      data: Uint8Array,
    ) => {
      const writable = await (fileHandle as any).createWritable({
        keepExistingData: false,
      });
      try {
        await writable.write(data);
        await writable.close();
      } catch (err) {
        await writable.abort?.().catch(() => {});
        throw err;
      }
    };

    if (this.dbSyncHandle && this.rootDir) {
      // Stage full DB into a sibling temp file first so write/quota errors leave live DB + WAL untouched
      const tmpName = `${this.dbName}.db.atomic.tmp`;
      const tmpHandle = await this.rootDir.getFileHandle(tmpName, {
        create: true,
      });
      const tmpSync = await (tmpHandle as any).createSyncAccessHandle();
      let tmpClosed = false;
      try {
        tmpSync.truncate(0);
        tmpSync.write(fullDb, { at: 0 });
        tmpSync.flush();

        // Reset WAL only after the new DB image is durably staged
        if (this.walSyncHandle) {
          this.walSyncHandle.truncate(0);
          this.walSyncHandle.write(walHeader, { at: 0 });
          this.walSyncHandle.flush();
        } else {
          await writeWritableAbortSafe(this.walFileHandle!, walHeader);
        }

        if (typeof (tmpHandle as any).move === "function") {
          tmpSync.close();
          tmpClosed = true;
          this.dbSyncHandle.close();
          this.dbSyncHandle = null;
          try {
            await (tmpHandle as any).move(this.rootDir, `${this.dbName}.db`);
          } finally {
            this.dbFileHandle = await this.rootDir.getFileHandle(
              `${this.dbName}.db`,
              { create: true },
            );
            this.dbSyncHandle = await (
              this.dbFileHandle as any
            ).createSyncAccessHandle();
          }
          return;
        }

        // Fallback when FileSystemFileHandle.move() is unavailable:
        // write pages 2..N before Page 1 + truncate, then remove temp staging file.
        if (fullDb.byteLength > 4096) {
          this.dbSyncHandle.write(fullDb.subarray(4096), { at: 4096 });
          this.dbSyncHandle.flush();
        }
        this.dbSyncHandle.write(fullDb.subarray(0, 4096), { at: 0 });
        this.dbSyncHandle.truncate(fullDb.byteLength);
        this.dbSyncHandle.flush();
      } finally {
        if (!tmpClosed) {
          try {
            tmpSync.close();
          } catch {
            // Ignore close error
          }
        }
        if (typeof (this.rootDir as any).removeEntry === "function") {
          await (this.rootDir as any).removeEntry(tmpName).catch(() => {});
        }
      }
      return;
    }

    // Async handles path: reset WAL first (prior frames were already checkpointed into the live DB),
    // then atomically replace the main DB file via OPFS `.crswap` writable stream with abort-on-error lock safety.
    await writeWritableAbortSafe(this.walFileHandle!, walHeader);
    await writeWritableAbortSafe(this.dbFileHandle!, fullDb);
  }

  async close(): Promise<void> {
    if (this.dbSyncHandle) {
      this.dbSyncHandle.close();
      this.dbSyncHandle = null;
    }
    if (this.walSyncHandle) {
      this.walSyncHandle.close();
      this.walSyncHandle = null;
    }
    this.dbFileHandle = null;
    this.walFileHandle = null;
    this.rootDir = null;
  }
}
