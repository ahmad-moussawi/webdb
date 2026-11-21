import { IVfsAdapter } from './vfs.js';

export type IdbDurability = 'default' | 'strict' | 'relaxed';

export interface IndexedDbVfsOptions {
  durability?: IdbDurability;
}

export class IndexedDbVfsAdapter implements IVfsAdapter {
  readonly name = 'idb' as const;
  readonly isSynchronous = false;
  readonly durability: IdbDurability;

  private dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private cachedWalFrameCount: number | null = null;

  constructor(dbName: string, options?: IndexedDbVfsOptions) {
    this.dbName = `webdb_${dbName}`;
    this.durability = options?.durability ?? 'relaxed';
  }

  private openWriteTx(
    db: IDBDatabase,
    stores: string | string[],
  ): IDBTransaction {
    if (this.durability === 'default') {
      return db.transaction(stores, 'readwrite');
    }
    try {
      return db.transaction(stores, 'readwrite', {
        durability: this.durability,
      });
    } catch {
      return db.transaction(stores, 'readwrite');
    }
  }

  private commitTx(tx: IDBTransaction): void {
    if (typeof (tx as any).commit === 'function') {
      try {
        (tx as any).commit();
      } catch {
        // Ignore if transaction already auto-committed or browser doesn't support explicit commit
      }
    }
  }

  private toStorableBytes(data: Uint8Array): ArrayBuffer | Uint8Array {
    const isShared =
      typeof SharedArrayBuffer !== 'undefined' &&
      data.buffer instanceof SharedArrayBuffer;
    if (
      !isShared &&
      data.byteOffset === 0 &&
      data.byteLength === data.buffer.byteLength
    ) {
      return data.buffer as ArrayBuffer;
    }
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const idb = globalThis.indexedDB;
        if (!idb) {
          reject(new Error('IndexedDB is not available in the current environment'));
          return;
        }

        const request = idb.open(this.dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('pages')) {
            db.createObjectStore('pages');
          }
          if (!db.objectStoreNames.contains('wal_frames')) {
            db.createObjectStore('wal_frames');
          }
          if (!db.objectStoreNames.contains('wal_meta')) {
            db.createObjectStore('wal_meta');
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    if (pageIds.length === 0) return [];
    const db = await this.getDb();
    return new Promise<Array<Uint8Array | null>>((resolve, reject) => {
      const tx = db.transaction('pages', 'readonly');
      const store = tx.objectStore('pages');
      const results: Array<Uint8Array | null> = new Array(pageIds.length).fill(null);

      // Fast-path: contiguous ascending range (e.g. exportBinary reading 1..N) -> 1 getAll + 1 getAllKeys IPC
      let isContiguous = pageIds.length >= 4 && typeof store.getAll === 'function' && typeof store.getAllKeys === 'function';
      if (isContiguous) {
        const startId = pageIds[0];
        for (let i = 1; i < pageIds.length; i++) {
          if (pageIds[i] !== startId + i) {
            isContiguous = false;
            break;
          }
        }
      }

      if (isContiguous) {
        const startId = pageIds[0];
        const endId = pageIds[pageIds.length - 1];
        const range = IDBKeyRange.bound(startId, endId);
        let keys: IDBValidKey[] = [];
        let vals: any[] = [];

        const keysReq = store.getAllKeys(range);
        keysReq.onsuccess = () => {
          keys = keysReq.result;
        };
        const valsReq = store.getAll(range);
        valsReq.onsuccess = () => {
          vals = valsReq.result;
        };

        tx.oncomplete = () => {
          for (let i = 0; i < keys.length; i++) {
            const idx = (keys[i] as number) - startId;
            const val = vals[i];
            if (idx >= 0 && idx < results.length && val) {
              results[idx] = val instanceof Uint8Array ? val : new Uint8Array(val);
            }
          }
          resolve(results);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        return;
      }

      for (let i = 0; i < pageIds.length; i++) {
        const request = store.get(pageIds[i]);
        request.onsuccess = () => {
          const result = request.result;
          if (result) {
            results[i] = result instanceof Uint8Array ? result : new Uint8Array(result);
          }
        };
      }

      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    if (pages.length === 0) return;
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = this.openWriteTx(db, 'pages');
      const store = tx.objectStore('pages');

      for (const { pageId, data } of pages) {
        store.put(this.toStorableBytes(data), pageId);
      }
      this.commitTx(tx);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async flush(): Promise<void> {
    // IndexedDB transactions are auto-flushed upon transaction completion
  }

  async truncate(pageCount: number): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = this.openWriteTx(db, 'pages');
      const store = tx.objectStore('pages');
      const range = IDBKeyRange.lowerBound(pageCount, true);
      store.delete(range);
      this.commitTx(tx);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // --- Write-Ahead Log Methods ---

  async readWalHeader(): Promise<Uint8Array | null> {
    const db = await this.getDb();
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction('wal_meta', 'readonly');
      const store = tx.objectStore('wal_meta');
      const request = store.get('header');

      request.onsuccess = () => {
        const result = request.result;
        if (!result) {
          resolve(null);
        } else {
          resolve(result instanceof Uint8Array ? result : new Uint8Array(result));
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async writeWalHeader(header: Uint8Array): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = this.openWriteTx(db, 'wal_meta');
      const store = tx.objectStore('wal_meta');
      store.put(this.toStorableBytes(header), 'header');
      this.commitTx(tx);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    const db = await this.getDb();
    return new Promise<Uint8Array[]>((resolve, reject) => {
      const tx = db.transaction('wal_frames', 'readonly');
      const store = tx.objectStore('wal_frames');
      const range = maxFrames !== undefined
        ? IDBKeyRange.bound(startFrameIndex, startFrameIndex + maxFrames - 1)
        : IDBKeyRange.lowerBound(startFrameIndex, false);

      // Fast-path: single getAll() IPC call instead of N cursor round-trips
      if (typeof store.getAll === 'function') {
        const request = store.getAll(range, maxFrames);
        request.onsuccess = () => {
          const raw = request.result ?? [];
          const frames: Uint8Array[] = new Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            const val = raw[i];
            frames[i] = val instanceof Uint8Array ? val : new Uint8Array(val);
          }
          resolve(frames);
        };
        request.onerror = () => reject(request.error);
        return;
      }

      const frames: Uint8Array[] = [];
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const val = cursor.value;
          frames.push(val instanceof Uint8Array ? val : new Uint8Array(val));
          cursor.continue();
        } else {
          resolve(frames);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async appendWalFrames(frames: Uint8Array[]): Promise<void> {
    if (frames.length === 0) return;
    await this.appendWalFramesWithHeader(frames);
  }

  async appendWalFramesWithHeader(
    frames: Uint8Array[],
    walHeader?: Uint8Array,
  ): Promise<number> {
    if (frames.length === 0 && !walHeader) {
      return this.cachedWalFrameCount ?? (await this.getWalFrameCount());
    }
    const db = await this.getDb();
    const stores = walHeader ? ['wal_frames', 'wal_meta'] : ['wal_frames'];
    return new Promise<number>((resolve, reject) => {
      const tx = this.openWriteTx(db, stores);
      const framesStore = tx.objectStore('wal_frames');
      if (walHeader) {
        tx.objectStore('wal_meta').put(this.toStorableBytes(walHeader), 'header');
      }

      let finalCount = 0;

      const writeFramesFrom = (startIdx: number) => {
        let nextIdx = startIdx;
        for (const frame of frames) {
          framesStore.put(this.toStorableBytes(frame), nextIdx++);
        }
        finalCount = nextIdx;
      };

      if (this.cachedWalFrameCount !== null) {
        writeFramesFrom(this.cachedWalFrameCount);
        this.commitTx(tx);
      } else {
        const countReq = framesStore.count();
        countReq.onsuccess = () => {
          writeFramesFrom(countReq.result);
          this.commitTx(tx);
        };
      }

      tx.oncomplete = () => {
        this.cachedWalFrameCount = finalCount;
        resolve(finalCount);
      };
      tx.onerror = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
      tx.onabort = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
    });
  }

  async flushWal(): Promise<void> {
    // IndexedDB transactions are auto-flushed upon completion
  }

  async truncateWal(frameIndex: number): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = this.openWriteTx(db, ['wal_frames', 'wal_meta']);
      const framesStore = tx.objectStore('wal_frames');
      const metaStore = tx.objectStore('wal_meta');

      if (frameIndex === 0) {
        framesStore.clear();
        metaStore.delete('header');
      } else {
        const range = IDBKeyRange.lowerBound(frameIndex, false);
        framesStore.delete(range);
      }
      this.commitTx(tx);

      tx.oncomplete = () => {
        this.cachedWalFrameCount =
          frameIndex === 0
            ? 0
            : this.cachedWalFrameCount !== null
              ? Math.min(this.cachedWalFrameCount, frameIndex)
              : null;
        resolve();
      };
      tx.onerror = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
      tx.onabort = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
    });
  }

  async getWalFrameCount(): Promise<number> {
    const db = await this.getDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction('wal_frames', 'readonly');
      const store = tx.objectStore('wal_frames');
      const request = store.count();

      request.onsuccess = () => {
        this.cachedWalFrameCount = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async checkpointAtomic(
    pages: Array<{ pageId: number; data: Uint8Array }>,
    walHeader?: Uint8Array,
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = this.openWriteTx(db, ['pages', 'wal_frames', 'wal_meta']);
      const pagesStore = tx.objectStore('pages');
      const framesStore = tx.objectStore('wal_frames');
      const metaStore = tx.objectStore('wal_meta');

      for (const { pageId, data } of pages) {
        pagesStore.put(this.toStorableBytes(data), pageId);
      }

      framesStore.clear();
      if (walHeader) {
        metaStore.put(this.toStorableBytes(walHeader), 'header');
      } else {
        metaStore.delete('header');
      }
      this.commitTx(tx);

      tx.oncomplete = () => {
        this.cachedWalFrameCount = 0;
        resolve();
      };
      tx.onerror = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
      tx.onabort = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
    });
  }

  async replaceDatabaseAtomic(
    pages: Array<{ pageId: number; data: Uint8Array }>,
    walHeader: Uint8Array,
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = this.openWriteTx(db, ['pages', 'wal_frames', 'wal_meta']);
      const pagesStore = tx.objectStore('pages');
      const framesStore = tx.objectStore('wal_frames');
      const metaStore = tx.objectStore('wal_meta');

      pagesStore.clear();
      for (const { pageId, data } of pages) {
        pagesStore.put(this.toStorableBytes(data), pageId);
      }

      framesStore.clear();
      metaStore.put(this.toStorableBytes(walHeader), 'header');
      this.commitTx(tx);

      tx.oncomplete = () => {
        this.cachedWalFrameCount = 0;
        resolve();
      };
      tx.onerror = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
      tx.onabort = () => {
        this.cachedWalFrameCount = null;
        reject(tx.error);
      };
    });
  }

  async readSyncSnapshot(): Promise<{
    walFrameCount: number;
    walHeader: Uint8Array | null;
    page1: Uint8Array | null;
  }> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['pages', 'wal_frames', 'wal_meta'], 'readonly');
      const pagesStore = tx.objectStore('pages');
      const framesStore = tx.objectStore('wal_frames');
      const metaStore = tx.objectStore('wal_meta');

      let walFrameCount = 0;
      let walHeader: Uint8Array | null = null;
      let page1: Uint8Array | null = null;

      const countReq = framesStore.count();
      countReq.onsuccess = () => {
        walFrameCount = countReq.result;
      };

      const headerReq = metaStore.get('header');
      headerReq.onsuccess = () => {
        const res = headerReq.result;
        if (res) {
          walHeader = res instanceof Uint8Array ? res : new Uint8Array(res);
        }
      };

      const page1Req = pagesStore.get(1);
      page1Req.onsuccess = () => {
        const res = page1Req.result;
        if (res) {
          page1 = res instanceof Uint8Array ? res : new Uint8Array(res);
        }
      };

      tx.oncomplete = () => {
        this.cachedWalFrameCount = walFrameCount;
        resolve({ walFrameCount, walHeader, page1 });
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async close(): Promise<void> {
    this.cachedWalFrameCount = null;
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
