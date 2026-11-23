import type { IVfsAdapter } from './vfs.js';

/**
 * Copy-on-write in-memory overlay over a read-only `IVfsAdapter`.
 *
 * Allows `WebDB.open()` to replay committed WAL frames into memory for accurate
 * read-only inspection without mutating a single byte of the underlying storage.
 * Once `seal()` is called after startup recovery, all subsequent write operations throw.
 */
export class ReadOnlyOverlayVfs implements IVfsAdapter {
  readonly name: string;
  readonly databaseName?: string;
  readonly isSynchronous = false;
  readonly readOnly = true;

  private readonly base: IVfsAdapter;
  private readonly pageOverlay = new Map<number, Uint8Array>();
  private truncatedPageCount: number | null = null;
  private walTruncated = false;
  private walHeaderOverlay: Uint8Array | null | undefined = undefined;
  private walFramesOverlay: Uint8Array[] | null = null;
  private sealed = false;

  constructor(base: IVfsAdapter) {
    this.base = base;
    this.name = base.name === 'node-fs' ? 'node-fs-ro' : `${base.name}-ro`;
    this.databaseName = base.databaseName;
  }

  /** Prevents any further in-memory overlay mutations after startup WAL replay. */
  seal(): void {
    this.sealed = true;
  }

  get replayedPageCount(): number {
    return this.pageOverlay.size;
  }

  get maxOverlaidPageId(): number {
    let max = 0;
    for (const pageId of this.pageOverlay.keys()) {
      if (pageId > max) max = pageId;
    }
    return max;
  }

  private assertNotSealed(op: string): void {
    if (this.sealed) {
      throw new Error(`Cannot ${op}: storage is opened in read-only mode`);
    }
  }

  async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    const results: Array<Uint8Array | null> = new Array(pageIds.length).fill(null);
    const missingIds: number[] = [];
    const missingPositions: number[] = [];

    for (let i = 0; i < pageIds.length; i++) {
      const pageId = pageIds[i];
      // Check overlay BEFORE truncatedPageCount so pages written after truncate() are visible
      const overlaid = this.pageOverlay.get(pageId);
      if (overlaid) {
        results[i] = new Uint8Array(overlaid);
        continue;
      }
      if (this.truncatedPageCount !== null && pageId > this.truncatedPageCount) {
        results[i] = null;
        continue;
      }
      missingIds.push(pageId);
      missingPositions.push(i);
    }

    if (missingIds.length > 0) {
      const diskPages = await this.base.readPages(missingIds);
      for (let i = 0; i < missingIds.length; i++) {
        results[missingPositions[i]] = diskPages[i] ?? null;
      }
    }

    return results;
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    this.assertNotSealed('writePages');
    for (const { pageId, data } of pages) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      this.pageOverlay.set(pageId, copy);
    }
  }

  async flush(): Promise<void> {
    // Strictly in-memory overlay; never flush to disk
  }

  async truncate(pageCount: number): Promise<void> {
    this.assertNotSealed('truncate');
    if (!Number.isInteger(pageCount) || pageCount < 0) {
      throw new RangeError(`Invalid pageCount: ${pageCount}. Expected a non-negative integer`);
    }
    this.truncatedPageCount =
      this.truncatedPageCount === null
        ? pageCount
        : Math.min(this.truncatedPageCount, pageCount);
    for (const key of Array.from(this.pageOverlay.keys())) {
      if (key > pageCount) {
        this.pageOverlay.delete(key);
      }
    }
  }

  async readWalHeader(): Promise<Uint8Array | null> {
    if (this.walTruncated) return null;
    if (this.walHeaderOverlay !== undefined) {
      return this.walHeaderOverlay ? new Uint8Array(this.walHeaderOverlay) : null;
    }
    return this.base.readWalHeader();
  }

  async writeWalHeader(header: Uint8Array): Promise<void> {
    this.assertNotSealed('writeWalHeader');
    const copy = new Uint8Array(header.byteLength);
    copy.set(header);
    this.walHeaderOverlay = copy;
    this.walTruncated = false;
  }

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    if (!Number.isInteger(startFrameIndex) || startFrameIndex < 0) {
      throw new RangeError(
        `Invalid startFrameIndex: ${startFrameIndex}. Expected a non-negative integer`,
      );
    }
    if (maxFrames !== undefined) {
      if (!Number.isInteger(maxFrames) || maxFrames < 0) {
        throw new RangeError(`Invalid maxFrames: ${maxFrames}. Expected a non-negative integer`);
      }
      if (maxFrames === 0) return [];
    }
    if (this.walTruncated) return [];
    if (this.walFramesOverlay !== null) {
      const end =
        maxFrames !== undefined
          ? startFrameIndex + maxFrames
          : this.walFramesOverlay.length;
      return this.walFramesOverlay
        .slice(startFrameIndex, end)
        .map((f) => new Uint8Array(f));
    }
    return this.base.readWalFrames(startFrameIndex, maxFrames);
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    this.assertNotSealed('appendWalFrames');
    if (this.walFramesOverlay === null) {
      this.walFramesOverlay = this.walTruncated ? [] : await this.base.readWalFrames(0);
    }
    this.walTruncated = false;
    for (const frame of frames) {
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      this.walFramesOverlay.push(copy);
    }
  }

  async flushWal(): Promise<void> {
    // Strictly in-memory overlay
  }

  async truncateWal(frameIndex: number): Promise<void> {
    this.assertNotSealed('truncateWal');
    if (frameIndex === 0) {
      this.walTruncated = true;
      this.walHeaderOverlay = null;
      this.walFramesOverlay = [];
    } else {
      if (this.walFramesOverlay === null) {
        this.walFramesOverlay = await this.base.readWalFrames(0);
      }
      this.walFramesOverlay.length = Math.min(this.walFramesOverlay.length, frameIndex);
    }
  }

  async getWalFrameCount(): Promise<number> {
    if (this.walTruncated) return 0;
    if (this.walFramesOverlay !== null) return this.walFramesOverlay.length;
    return this.base.getWalFrameCount();
  }

  async close(): Promise<void> {
    await this.base.close?.();
  }
}
