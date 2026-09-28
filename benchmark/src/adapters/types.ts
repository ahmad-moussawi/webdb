export interface BenchmarkRecord {
  id: number;
  name: string;
  age: number;
  score: number;
  city: string;
  active: number; // 1 or 0 for universal cross-DB compatibility
}

export interface OrderRecord {
  id: number;
  user_id: number;
  amount: number;
}

export type StorageCategory = 'memory' | 'persistent';

export type EngineId =
  | 'raw_array'
  | 'webdb_mem'
  | 'webdb_idb'
  | 'indexeddb'
  | 'sqlite_mem'
  | 'sqlite_opfs';

export interface EngineInfo {
  id: EngineId;
  name: string;
  subtitle: string;
  storage: StorageCategory;
  description: string;
  badgeColor: string;
  available: boolean;
  unavailableReason?: string;
}

export type ScenarioId =
  | 'bulk_insert'
  | 'point_lookup'
  | 'range_scan'
  | 'sort_limit'
  | 'aggregation'
  | 'join_query';

export interface ScenarioInfo {
  id: ScenarioId;
  name: string;
  description: string;
  queryHint: string;
  category: 'write' | 'read' | 'complex' | 'analytics';
}

export interface BenchmarkAdapter {
  id: EngineId;
  name: string;
  storage: StorageCategory;
  
  /** Initialize database instance and tables */
  init(): Promise<void>;
  
  /** Insert batch of records into DB */
  bulkInsert(records: BenchmarkRecord[], orders?: OrderRecord[]): Promise<void>;
  
  /** Point lookup by primary key ID (100 random lookups) */
  pointLookup(ids: number[]): Promise<BenchmarkRecord[]>;
  
  /** Range scan on numeric field (e.g. 25 <= age <= 40) */
  rangeScan(minAge: number, maxAge: number): Promise<BenchmarkRecord[]>;
  
  /** Filtered sort and limit (e.g. active = 1 ORDER BY score DESC LIMIT 10) */
  sortLimit(limit: number): Promise<BenchmarkRecord[]>;
  
  /** Aggregation (e.g. COUNT(*) and SUM(score) where active = 1) */
  aggregation(): Promise<{ count: number; sumScore: number; avgAge: number }>;

  /** 2-table indexed JOIN between orders and users */
  joinQuery(): Promise<any[]>;
  
  /** Clean up resources and drop table/database */
  teardown(): Promise<void>;
}

export interface ScenarioResult {
  engineId: EngineId;
  scenarioId: ScenarioId;
  opsPerSec: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  samples: number;
  memoryDeltaBytes?: number;
  error?: string;
}

export interface BenchmarkRunConfig {
  datasetSize: number;
  engines: EngineId[];
  scenarios: ScenarioId[];
  iterations: number;
}
