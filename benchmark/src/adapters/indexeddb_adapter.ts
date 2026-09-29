import {
  BenchmarkAdapter,
  BenchmarkRecord,
  EngineId,
  OrderRecord,
  StorageCategory,
} from "./types.js";

export class IndexedDbAdapter implements BenchmarkAdapter {
  readonly id: EngineId = "indexeddb";
  readonly name = "Native IndexedDB";
  readonly storage: StorageCategory = "persistent";

  private dbName: string = "";
  private db: IDBDatabase | null = null;

  constructor() {
    this.dbName = `idb_bench_${Date.now()}`;
  }

  async init(): Promise<void> {
    if (this.db) {
      await this.teardown();
    }

    this.dbName = `idb_bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("benchmark")) {
          const store = db.createObjectStore("benchmark", { keyPath: "id" });
          store.createIndex("age", "age", { unique: false });
          store.createIndex("score", "score", { unique: false });
          store.createIndex("active", "active", { unique: false });
        }
        if (!db.objectStoreNames.contains("orders")) {
          const ordersStore = db.createObjectStore("orders", { keyPath: "id" });
          ordersStore.createIndex("user_id", "user_id", { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async bulkInsert(
    records: BenchmarkRecord[],
    orders: import("./types.js").OrderRecord[] = [],
  ): Promise<void> {
    if (!this.db) throw new Error("IndexedDB not initialized");
    const db = this.db;

    // Use chunks to prevent transaction timeouts on huge datasets
    const CHUNK_SIZE = 5000;
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("benchmark", "readwrite");
        const store = tx.objectStore("benchmark");

        for (const item of chunk) {
          store.put(item);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(new Error("IndexedDB transaction aborted"));
      });
    }

    if (orders.length > 0) {
      for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
        const chunk = orders.slice(i, i + CHUNK_SIZE);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("orders", "readwrite");
          const store = tx.objectStore("orders");

          for (const item of chunk) {
            store.put(item);
          }

          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(new Error("IndexedDB transaction aborted"));
        });
      }
    }
  }

  async pointLookup(ids: number[]): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error("IndexedDB not initialized");
    const tx = this.db.transaction("benchmark", "readonly");
    const store = tx.objectStore("benchmark");

    const promises = ids.map(
      (id) =>
        new Promise<BenchmarkRecord | undefined>((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );

    const results = await Promise.all(promises);
    return results.filter(Boolean) as BenchmarkRecord[];
  }

  async rangeScan(minAge: number, maxAge: number): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error("IndexedDB not initialized");
    const db = this.db;

    return new Promise<BenchmarkRecord[]>((resolve, reject) => {
      const tx = db.transaction("benchmark", "readonly");
      const store = tx.objectStore("benchmark");
      const index = store.index("age");
      const range = IDBKeyRange.bound(minAge, maxAge);
      const req = index.getAll(range);

      req.onsuccess = () => {
        resolve(req.result as BenchmarkRecord[]);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async sortLimit(limit: number): Promise<BenchmarkRecord[]> {
    if (!this.db) throw new Error("IndexedDB not initialized");
    const db = this.db;

    return new Promise<BenchmarkRecord[]>((resolve, reject) => {
      const tx = db.transaction("benchmark", "readonly");
      const store = tx.objectStore("benchmark");
      const index = store.index("score");
      // Cursor in descending order by score
      const req = index.openCursor(null, "prev");
      const results: BenchmarkRecord[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && results.length < limit) {
          const val = cursor.value as BenchmarkRecord;
          if (val.active === 1) {
            results.push(val);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  async aggregation(): Promise<{
    count: number;
    sumScore: number;
    avgAge: number;
  }> {
    if (!this.db) throw new Error("IndexedDB not initialized");
    const db = this.db;

    return new Promise((resolve, reject) => {
      const tx = db.transaction("benchmark", "readonly");
      const store = tx.objectStore("benchmark");
      const index = store.index("active");
      const req = index.openCursor(IDBKeyRange.only(1));

      let count = 0;
      let sumScore = 0;
      let sumAge = 0;

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value as BenchmarkRecord;
          count++;
          sumScore += val.score;
          sumAge += val.age;
          cursor.continue();
        } else {
          resolve({
            count,
            sumScore: Math.round(sumScore * 100) / 100,
            avgAge: count > 0 ? sumAge / count : 0,
          });
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  async joinQuery(): Promise<any[]> {
    if (!this.db) throw new Error("IndexedDB not initialized");
    const db = this.db;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(["orders", "benchmark"], "readonly");
      const ordersStore = tx.objectStore("orders");
      const benchStore = tx.objectStore("benchmark");

      const getAllOrdersReq = ordersStore.getAll();
      getAllOrdersReq.onsuccess = () => {
        const orders = getAllOrdersReq.result as OrderRecord[];
        if (orders.length === 0) {
          resolve([]);
          return;
        }

        const results: Array<{
          order_id: number;
          user_name: string;
          amount: number;
        }> = [];
        let remaining = orders.length;

        for (const order of orders) {
          const userReq = benchStore.get(order.user_id);
          userReq.onsuccess = () => {
            const user = userReq.result as BenchmarkRecord | undefined;
            if (user) {
              results.push({
                order_id: order.id,
                user_name: user.name,
                amount: order.amount,
              });
            }
            remaining--;
            if (remaining === 0) {
              resolve(results);
            }
          };
          userReq.onerror = () => reject(userReq.error);
        }
      };

      getAllOrdersReq.onerror = () => reject(getAllOrdersReq.error);
    });
  }

  async teardown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}
