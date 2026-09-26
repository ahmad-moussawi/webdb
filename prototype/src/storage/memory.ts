import { IVfsAdapter } from './vfs.js';

export class MemoryVfsAdapter implements IVfsAdapter {
  readonly name = 'memory' as const;
  readonly isSynchronous = true;

  private pages = new Map<number, Uint8Array>();
  private walHeader: Uint8Array | null = null;
  private walFrames: Uint8Array[] = [];

  async readPage(pageId: number): Promise<Uint8Array | null> {
    const page = this.pages.get(pageId);
    if (!page) return null;
    return new Uint8Array(page); // return copy
  }

  async writePage(pageId: number, data: Uint8Array): Promise<void> {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.pages.set(pageId, copy);
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    for (const { pageId, data } of pages) {
      await this.writePage(pageId, data);
    }
  }

  async flush(): Promise<void> {
    // In-memory data is immediately durable in RAM
  }

  async truncate(pageCount: number): Promise<void> {
    for (const key of Array.from(this.pages.keys())) {
      if (key >= pageCount) {
        this.pages.delete(key);
      }
    }
  }

  // --- Write-Ahead Log Methods ---

  async readWalHeader(): Promise<Uint8Array | null> {
    if (!this.walHeader) return null;
    return new Uint8Array(this.walHeader);
  }

  async writeWalHeader(header: Uint8Array): Promise<void> {
    const copy = new Uint8Array(header.byteLength);
    copy.set(header);
    this.walHeader = copy;
  }

  async readWalFrame(frameIndex: number): Promise<Uint8Array | null> {
    const frame = this.walFrames[frameIndex];
    if (!frame) return null;
    return new Uint8Array(frame);
  }

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    const end = maxFrames !== undefined ? startFrameIndex + maxFrames : this.walFrames.length;
    const slice = this.walFrames.slice(startFrameIndex, end);
    return slice.map((f) => new Uint8Array(f));
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    for (const frame of frames) {
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      this.walFrames.push(copy);
    }
  }

  async flushWal(): Promise<void> {
    // In-memory frames are immediately durable in RAM
  }

  async truncateWal(frameIndex: number): Promise<void> {
    if (frameIndex === 0) {
      this.walFrames = [];
      this.walHeader = null;
    } else {
      this.walFrames.length = Math.min(this.walFrames.length, frameIndex);
    }
  }

  async getWalFrameCount(): Promise<number> {
    return this.walFrames.length;
  }

  async close(): Promise<void> {
    this.pages.clear();
    this.walFrames = [];
    this.walHeader = null;
  }
}
