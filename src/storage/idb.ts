import { IVfsAdapter } from './vfs.js';

export class IndexedDbVfsAdapter implements IVfsAdapter {
  readonly name = 'idb' as const;
  readonly isSynchronous = false;

  private dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName: string) {
    this.dbName = `webdb_${dbName}`;
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

  async readPage(pageId: number): Promise<Uint8Array | null> {
    const db = await this.getDb();
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction('pages', 'readonly');
      const store = tx.objectStore('pages');
      const request = store.get(pageId);

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

  async writePage(pageId: number, data: Uint8Array): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite');
      const store = tx.objectStore('pages');
      // Store a clone of the byte slice
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      store.put(copy, pageId);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void> {
    if (pages.length === 0) return;
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite');
      const store = tx.objectStore('pages');

      for (const { pageId, data } of pages) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        store.put(copy, pageId);
      }

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
      const tx = db.transaction('pages', 'readwrite');
      const store = tx.objectStore('pages');
      const range = IDBKeyRange.lowerBound(pageCount, false);
      const request = store.delete(range);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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
      const tx = db.transaction('wal_meta', 'readwrite');
      const store = tx.objectStore('wal_meta');
      const copy = new Uint8Array(header.byteLength);
      copy.set(header);
      store.put(copy, 'header');

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async readWalFrame(frameIndex: number): Promise<Uint8Array | null> {
    const db = await this.getDb();
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction('wal_frames', 'readonly');
      const store = tx.objectStore('wal_frames');
      const request = store.get(frameIndex);

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

  async readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]> {
    const db = await this.getDb();
    return new Promise<Uint8Array[]>((resolve, reject) => {
      const tx = db.transaction('wal_frames', 'readonly');
      const store = tx.objectStore('wal_frames');
      const frames: Uint8Array[] = [];
      const range = maxFrames !== undefined
        ? IDBKeyRange.bound(startFrameIndex, startFrameIndex + maxFrames - 1)
        : IDBKeyRange.lowerBound(startFrameIndex, false);
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
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wal_frames', 'readwrite');
      const store = tx.objectStore('wal_frames');
      const countReq = store.count();

      countReq.onsuccess = () => {
        let nextIdx = countReq.result;
        for (const frame of frames) {
          const copy = new Uint8Array(frame.byteLength);
          copy.set(frame);
          store.put(copy, nextIdx++);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async flushWal(): Promise<void> {
    // IndexedDB transactions are auto-flushed upon completion
  }

  async truncateWal(frameIndex: number): Promise<void> {
    const db = await this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['wal_frames', 'wal_meta'], 'readwrite');
      const framesStore = tx.objectStore('wal_frames');
      const metaStore = tx.objectStore('wal_meta');

      if (frameIndex === 0) {
        framesStore.clear();
        metaStore.delete('header');
      } else {
        const range = IDBKeyRange.lowerBound(frameIndex, false);
        framesStore.delete(range);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getWalFrameCount(): Promise<number> {
    const db = await this.getDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction('wal_frames', 'readonly');
      const store = tx.objectStore('wal_frames');
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
