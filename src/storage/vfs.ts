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

  /** Closes and cleans up storage handles */
  close(): Promise<void>;
}
