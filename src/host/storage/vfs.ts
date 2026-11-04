export interface IVfsAdapter {
  readonly name: string;
  readonly isSynchronous?: boolean;

  /** Reads one or more 4KB pages from storage by 1-indexed pageId */
  readPages(pageIds: number[]): Promise<Array<Uint8Array | null>>;

  /** Atomically commits a batch of 4KB pages to storage */
  writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void>;

  /** Flushes all in-flight writes durably to persistent storage (optional if writePages is already durable) */
  flush?(): Promise<void>;

  /** Truncates the storage file/store to the specified page count */
  truncate(pageCount: number): Promise<void>;

  // --- Write-Ahead Log Storage (.wal file / 'wal' store) ---

  /** Reads the 32-byte WAL file header. Returns null if WAL is empty or does not exist. */
  readWalHeader(): Promise<Uint8Array | null>;

  /** Writes or overwrites the 32-byte WAL file header */
  writeWalHeader(header: Uint8Array): Promise<void>;

  /** Reads a batch of consecutive 4,128-byte WAL frames (32B header + 4096B page data) starting from 0-based startFrameIndex */
  readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]>;

  /** Appends one or more 4,128-byte WAL frames to the end of the log */
  appendWalFrames(frames: Uint8Array[]): Promise<void>;

  /** Flushes WAL writes durably to persistent storage (optional if appendWalFrames is already durable) */
  flushWal?(): Promise<void>;

  /** Truncates the WAL to the specified frame count (0 resets WAL) */
  truncateWal(frameIndex: number): Promise<void>;

  /** Returns the current number of frames in the WAL */
  getWalFrameCount(): Promise<number>;

  /** Closes and cleans up storage handles (optional) */
  close?(): Promise<void>;
}
