export interface IVfsAdapter {
  readonly name: 'memory' | 'opfs' | 'idb';
  readonly isSynchronous: boolean;

  /** Reads a 4KB page from storage into a Uint8Array */
  readPage(pageId: number): Promise<Uint8Array | null>;

  /** Writes a 4KB page from memory to persistent storage */
  writePage(pageId: number, data: Uint8Array): Promise<void>;

  /** Atomically commits a batch of dirty pages or WAL frames */
  writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void>;

  /** Flushes all in-flight writes durably to persistent storage */
  flush(): Promise<void>;

  /** Truncates the storage file/store to the specified page count */
  truncate(pageCount: number): Promise<void>;

  // --- Write-Ahead Log Storage (.wal file / 'wal' store) ---

  /** Reads the 32-byte WAL file header. Returns null if WAL is empty or does not exist. */
  readWalHeader(): Promise<Uint8Array | null>;

  /** Writes or overwrites the 32-byte WAL file header */
  writeWalHeader(header: Uint8Array): Promise<void>;

  /** Reads a single 4,128-byte WAL frame (32B header + 4096B page data) by 0-based frame index */
  readWalFrame(frameIndex: number): Promise<Uint8Array | null>;

  /** Reads a batch of consecutive 4,128-byte WAL frames starting from frameIndex */
  readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]>;

  /** Appends one or more 4,128-byte WAL frames to the end of the log */
  appendWalFrames(frames: Uint8Array[]): Promise<void>;

  /** Flushes WAL writes durably to persistent storage */
  flushWal(): Promise<void>;

  /** Truncates the WAL to the specified frame count (0 resets WAL) */
  truncateWal(frameIndex: number): Promise<void>;

  /** Returns the current number of frames in the WAL */
  getWalFrameCount(): Promise<number>;

  /** Closes and cleans up storage handles */
  close(): Promise<void>;
}
