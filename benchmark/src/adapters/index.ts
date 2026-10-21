import { BenchmarkAdapter, EngineId, EngineInfo, ScenarioInfo } from './types.js';
import { RawArrayAdapter } from './array_adapter.js';
import { WebDbAdapter } from './webdb_adapter.js';
import { IndexedDbAdapter } from './indexeddb_adapter.js';
import { SqliteWasmAdapter } from './sqlite_adapter.js';

export * from './types.js';
export * from './array_adapter.js';
export * from './webdb_adapter.js';
export * from './indexeddb_adapter.js';
export * from './sqlite_adapter.js';

export const AVAILABLE_ENGINES: EngineInfo[] = [
  {
    id: 'raw_array',
    name: 'Raw JS Array',
    subtitle: 'V8 Heap Objects + Map Index',
    storage: 'memory',
    description: 'In-memory baseline using standard JavaScript Array and Map. Unbound by DB serialization.',
    badgeColor: '#eab308',
    available: true,
  },
  {
    id: 'webdb_wasm_mem',
    name: 'WebDB (C / WASM Memory)',
    subtitle: 'Compiled C Core (<20KB) in Memory',
    storage: 'memory',
    description: 'Relational engine with slotted pages and VDBE bytecode VM powered by compiled C WebAssembly.',
    badgeColor: '#6366f1',
    available: true,
  },
  {
    id: 'webdb_mem',
    name: 'WebDB (JS Memory)',
    subtitle: 'Pure TypeScript/JS Core (RAM)',
    storage: 'memory',
    description: 'Relational engine with slotted-page buffer pool, columnar catalogs, and VDBE bytecode VM in pure JS.',
    badgeColor: '#818cf8',
    available: true,
  },
  {
    id: 'sqlite_mem',
    name: 'SQLite WASM (:memory:)',
    subtitle: 'Official C SQLite compiled to WASM',
    storage: 'memory',
    description: 'Official SQLite compiled to WebAssembly with in-memory VFS and prepared statements.',
    badgeColor: '#0ea5e9',
    available: true,
  },
  {
    id: 'webdb_wasm_idb',
    name: 'WebDB (C / WASM IndexedDB)',
    subtitle: 'C Core WASM on IDB Slotted Pages',
    storage: 'persistent',
    description: 'WebDB running compiled C WebAssembly core persisting 4KB slotted pages to IndexedDB storage.',
    badgeColor: '#8b5cf6',
    available: true,
  },
  {
    id: 'webdb_idb',
    name: 'WebDB (JS IndexedDB)',
    subtitle: 'Pure JS Engine on IDB Pages',
    storage: 'persistent',
    description: 'WebDB persisting 4KB slotted pages to browser IndexedDB storage with LRU buffer caching in pure JS.',
    badgeColor: '#a78bfa',
    available: true,
  },
  {
    id: 'indexeddb',
    name: 'Native IndexedDB',
    subtitle: 'Browser Key-Value / Object Store',
    storage: 'persistent',
    description: 'Native browser structured-clone storage with B-tree secondary indexes and cursor scans.',
    badgeColor: '#ec4899',
    available: true,
  },
  {
    id: 'sqlite_opfs',
    name: 'SQLite WASM (OPFS)',
    subtitle: 'WASM SQLite on Origin Private File System',
    storage: 'persistent',
    description: 'SQLite WASM utilizing synchronous filesystem access via OPFS in Web Workers.',
    badgeColor: '#10b981',
    available: true,
  },
];

export const AVAILABLE_SCENARIOS: ScenarioInfo[] = [
  {
    id: 'bulk_insert',
    name: '1. Bulk Batch Insert',
    category: 'write',
    description: 'Insert N records in a single batch (with transactions/chunking). Measures ingestion throughput.',
    queryHint: 'INSERT INTO table VALUES (... [N rows])',
  },
  {
    id: 'point_lookup',
    name: '2. Batch Point Lookups (IN)',
    category: 'read',
    description: 'Execute batch primary-key lookups for 100 random IDs (WHERE id IN (...)). Measures multi-key index seek and retrieval throughput.',
    queryHint: 'SELECT * FROM table WHERE id IN (? ... 100 IDs)',
  },
  {
    id: 'range_scan',
    name: '3. Range Filter Scan',
    category: 'read',
    description: 'Filtered range scan over numeric column (e.g. 25 <= age <= 40). Tests predicate evaluation & index scans.',
    queryHint: 'SELECT * FROM table WHERE age >= 25 AND age <= 40',
  },
  {
    id: 'sort_limit',
    name: '4. Filter + Sort + Limit',
    category: 'complex',
    description: 'Filter active records, sort by score descending, and limit to top 10. Tests internal sorter performance.',
    queryHint: 'SELECT * FROM table WHERE active = 1 ORDER BY score DESC LIMIT 10',
  },
  {
    id: 'aggregation',
    name: '5. Analytics Aggregation',
    category: 'analytics',
    description: 'Compute COUNT(*), SUM(score), and AVG(age) for active records. Tests column projection and accumulator speed.',
    queryHint: 'SELECT COUNT(*), SUM(score), AVG(age) FROM table WHERE active = 1',
  },
  {
    id: 'join_query',
    name: '6. Indexed 2-Table JOIN',
    category: 'complex',
    description: 'INNER JOIN between orders and users matching on orders.user_id = users.id. Tests foreign-key to primary-key indexed join.',
    queryHint: 'SELECT orders.id, users.name, orders.amount FROM orders JOIN users ON orders.user_id = users.id',
  },
];

export function createAdapter(engineId: EngineId): BenchmarkAdapter {
  switch (engineId) {
    case 'raw_array':
      return new RawArrayAdapter();
    case 'webdb_wasm_mem':
      return new WebDbAdapter('webdb_wasm_mem', 'memory', 'wasm');
    case 'webdb_mem':
      return new WebDbAdapter('webdb_mem', 'memory', 'js');
    case 'webdb_wasm_idb':
      return new WebDbAdapter('webdb_wasm_idb', 'idb', 'wasm');
    case 'webdb_idb':
      return new WebDbAdapter('webdb_idb', 'idb', 'js');
    case 'indexeddb':
      return new IndexedDbAdapter();
    case 'sqlite_mem':
      return new SqliteWasmAdapter('sqlite_mem', false);
    case 'sqlite_opfs':
      return new SqliteWasmAdapter('sqlite_opfs', true);
    default:
      throw new Error(`Unknown engine id: ${engineId}`);
  }
}
