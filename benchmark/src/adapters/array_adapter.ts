import { BenchmarkAdapter, BenchmarkRecord, OrderRecord, EngineId, StorageCategory } from './types.js';

export class RawArrayAdapter implements BenchmarkAdapter {
  readonly id: EngineId = 'raw_array';
  readonly name = 'Raw JS Array';
  readonly storage: StorageCategory = 'memory';

  private data: BenchmarkRecord[] = [];
  private idIndex: Map<number, BenchmarkRecord> = new Map();
  private orders: OrderRecord[] = [];

  async init(): Promise<void> {
    this.data = [];
    this.idIndex.clear();
    this.orders = [];
  }

  async bulkInsert(records: BenchmarkRecord[], orders: OrderRecord[] = []): Promise<void> {
    this.data = new Array(records.length);
    this.idIndex = new Map();
    for (let i = 0; i < records.length; i++) {
      const rec = { ...records[i] };
      this.data[i] = rec;
      this.idIndex.set(rec.id, rec);
    }
    this.orders = orders.map((o) => ({ ...o }));
  }

  async pointLookup(ids: number[]): Promise<BenchmarkRecord[]> {
    const results: BenchmarkRecord[] = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const rec = this.idIndex.get(ids[i]);
      if (rec) results[i] = rec;
    }
    return results;
  }

  async rangeScan(minAge: number, maxAge: number): Promise<BenchmarkRecord[]> {
    const results: BenchmarkRecord[] = [];
    const len = this.data.length;
    for (let i = 0; i < len; i++) {
      const row = this.data[i];
      if (row.age >= minAge && row.age <= maxAge) {
        results.push(row);
      }
    }
    return results;
  }

  async sortLimit(limit: number): Promise<BenchmarkRecord[]> {
    // Filter active = 1, sort by score DESC, limit
    return this.data
      .filter((r) => r.active === 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async aggregation(): Promise<{ count: number; sumScore: number; avgAge: number }> {
    let count = 0;
    let sumScore = 0;
    let sumAge = 0;
    const len = this.data.length;
    for (let i = 0; i < len; i++) {
      const row = this.data[i];
      if (row.active === 1) {
        count++;
        sumScore += row.score;
        sumAge += row.age;
      }
    }
    return {
      count,
      sumScore: Math.round(sumScore * 100) / 100,
      avgAge: count > 0 ? sumAge / count : 0,
    };
  }

  async joinQuery(): Promise<any[]> {
    const results: Array<{ order_id: number; user_name: string; amount: number }> = [];
    const len = this.orders.length;
    for (let i = 0; i < len; i++) {
      const order = this.orders[i];
      const user = this.idIndex.get(order.user_id);
      if (user) {
        results.push({
          order_id: order.id,
          user_name: user.name,
          amount: order.amount,
        });
      }
    }
    return results;
  }

  async teardown(): Promise<void> {
    this.data = [];
    this.idIndex.clear();
    this.orders = [];
  }
}
