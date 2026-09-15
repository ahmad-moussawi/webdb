import { AsyncPageStore, DATABASE_PAGE_SIZE, validateDataPageId } from "./protocol.js";

const DATABASE_VERSION = 1;
const PAGES_STORE = "webdb_pages";
function copyPage(page: Uint8Array): Uint8Array {
  if (page.byteLength !== DATABASE_PAGE_SIZE) {
    throw new RangeError(`Page must contain exactly ${DATABASE_PAGE_SIZE} bytes.`);
  }
  return page.slice();
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

// Browser host store for Phase 2 page batches. Master metadata is deliberately absent: Phase 4
// will add its stronger generation and recovery protocol without changing this page-copy boundary.
export class IndexedDbPageStore implements AsyncPageStore {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly name: string,
    private readonly indexedDb: IDBFactory = globalThis.indexedDB,
  ) {}

  async readPages(pageIds: readonly number[]): Promise<Map<number, Uint8Array>> {
    const uniquePageIds = new Set(pageIds);
    if (uniquePageIds.size !== pageIds.length) {
      throw new RangeError("A page read batch cannot contain duplicate page IDs.");
    }
    for (const pageId of pageIds) validateDataPageId(pageId);

    const database = await this.open();
    const transaction = database.transaction(PAGES_STORE, "readonly");
    const store = transaction.objectStore(PAGES_STORE);
    const done = transactionDone(transaction);
    try {
      const results = await Promise.all(pageIds.map(async (pageId) => {
        const stored = await requestResult(store.get(pageId));
        if (!(stored instanceof Uint8Array)) {
          throw new Error(`Page ${pageId} is unavailable or malformed.`);
        }
        return [pageId, copyPage(stored)] as const;
      }));
      await done;
      return new Map(results);
    } catch (error) {
      // A request error also aborts the IndexedDB transaction. Observe that rejection before
      // returning the request failure so the transaction promise cannot become unhandled.
      await done.catch(() => undefined);
      throw error;
    }
  }

  async writePages(pages: ReadonlyMap<number, Uint8Array>): Promise<void> {
    // Validate and copy every input before opening the transaction. This prevents a caller's
    // mutable page buffer from changing while IndexedDB serializes the batch.
    const copiedPages = new Map<number, Uint8Array>();
    for (const [pageId, page] of pages) {
      validateDataPageId(pageId);
      copiedPages.set(pageId, copyPage(page));
    }
    if (copiedPages.size === 0) return;

    const database = await this.open();
    const transaction = database.transaction(PAGES_STORE, "readwrite");
    const store = transaction.objectStore(PAGES_STORE);
    const done = transactionDone(transaction);
    for (const [pageId, page] of copiedPages) {
      store.put(page, pageId);
    }
    // IndexedDB reports durable transaction success only through oncomplete, not individual puts.
    await done;
  }

  close(): void {
    this.databasePromise?.then((database) => database.close()).catch(() => undefined);
    this.databasePromise = undefined;
  }

  private open(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = this.indexedDb.open(this.name, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PAGES_STORE)) {
          database.createObjectStore(PAGES_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another connection."));
    });
    return this.databasePromise;
  }
}
