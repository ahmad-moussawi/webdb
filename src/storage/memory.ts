import { IVfsAdapter } from './vfs.js';

export class MemoryVfsAdapter implements IVfsAdapter {
  readonly name = 'memory' as const;
  readonly isSynchronous = true;

  private pages = new Map<number, Uint8Array>();

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

  async close(): Promise<void> {
    this.pages.clear();
  }
}
