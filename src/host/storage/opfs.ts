import { IVfsAdapter } from './vfs.js';

export class OpfsVfsAdapter implements IVfsAdapter {
  readonly name = 'opfs' as const;
  readonly isSynchronous: boolean;

  private dbName: string;
  private rootDir: FileSystemDirectoryHandle | null = null;
  private dbFileHandle: FileSystemFileHandle | null = null;
  private walFileHandle: FileSystemFileHandle | null = null;

  // SyncAccessHandles (available in Dedicated Web Workers)
  private dbSyncHandle: any = null;
  private walSyncHandle: any = null;

  constructor(dbName: string) {
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

  async readPage(pageId: number): Promise<Uint8Array | null> {
    await this.initHandles();
    const offset = (pageId - 1) * 4096;

    if (this.dbSyncHandle) {
      const size = this.dbSyncHandle.getSize();
      if (offset + 4096 > size) return null;
      const buffer = new Uint8Array(4096);
      this.dbSyncHandle.read(buffer, { at: offset });
      return buffer;
    }

    const file = await this.dbFileHandle!.getFile();
    if (offset + 4096 > file.size) return null;
    const slice = file.slice(offset, offset + 4096);
    const arrayBuf = await slice.arrayBuffer();
    return new Uint8Array(arrayBuf);
  }

  async writePage(pageId: number, data: Uint8Array): Promise<void> {
    await this.initHandles();
    const offset = (pageId - 1) * 4096;

    if (this.dbSyncHandle) {
      this.dbSyncHandle.write(data, { at: offset });
      return;
    }

    const writable = await (this.dbFileHandle as any).createWritable({ keepExistingData: true });
    await writable.seek(offset);
    await writable.write(data);
    await writable.close();
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    for (const { pageId, data } of pages) {
      await this.writePage(pageId, data);
    }
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

  async readWalFrame(frameIndex: number): Promise<Uint8Array | null> {
    await this.initHandles();
    const offset = 32 + (frameIndex * 4128);
    if (this.walSyncHandle) {
      const size = this.walSyncHandle.getSize();
      if (offset + 4128 > size) return null;
      const frame = new Uint8Array(4128);
      this.walSyncHandle.read(frame, { at: offset });
      return frame;
    }
    const file = await this.walFileHandle!.getFile();
    if (offset + 4128 > file.size) return null;
    const slice = file.slice(offset, offset + 4128);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    const frames: Uint8Array[] = [];
    let idx = startFrameIndex;
    const limit = maxFrames !== undefined ? startFrameIndex + maxFrames : Infinity;

    while (idx < limit) {
      const frame = await this.readWalFrame(idx);
      if (!frame) break;
      frames.push(frame);
      idx++;
    }
    return frames;
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    await this.initHandles();
    if (this.walSyncHandle) {
      let offset = this.walSyncHandle.getSize();
      for (const frame of frames) {
        this.walSyncHandle.write(frame, { at: offset });
        offset += frame.byteLength;
      }
      return;
    }
    const file = await this.walFileHandle!.getFile();
    const writable = await (this.walFileHandle as any).createWritable({ keepExistingData: true });
    await writable.seek(file.size);
    for (const frame of frames) {
      await writable.write(frame);
    }
    await writable.close();
  }

  async flushWal(): Promise<void> {
    if (this.walSyncHandle) {
      this.walSyncHandle.flush();
    }
  }

  async truncateWal(frameIndex: number): Promise<void> {
    await this.initHandles();
    const newSize = frameIndex === 0 ? 0 : 32 + (frameIndex * 4128);
    if (this.walSyncHandle) {
      this.walSyncHandle.truncate(newSize);
      return;
    }
    const writable = await (this.walFileHandle as any).createWritable();
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
    if (size < 32) return 0;
    return Math.floor((size - 32) / 4128);
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
