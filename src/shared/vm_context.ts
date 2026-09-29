import { VmStatus, TableMeta, ColumnMeta } from '../types/index.js';
import { DEFAULT_MAX_QUERY_MEMORY } from '../constants.js';

export interface VmCursor {
  pageId: number;
  rootPageId?: number;
  slotIdx: number;
  cellIdx: number;
  rowOffset: number; // Absolute byte offset in view
  btreeDepth?: number;
  flags?: number;
}

export function createVmCursor(): VmCursor {
  return {
    pageId: 0,
    rootPageId: 0,
    slotIdx: 0,
    cellIdx: 0,
    rowOffset: 0,
    btreeDepth: 0,
    flags: 0,
  };
}

export interface VmKeyInfo {
  numKeys: number;
  directions: number[]; // 0 = ASC, 1 = DESC
  nullOrders: number[]; // 0 = NULLS_FIRST, 1 = NULLS_LAST
  limit?: number;
  offset?: number;
}

export interface VmSorterEntry {
  keys: any[];
  rowOffset: number;
  rowLen: number;
  rowData?: Uint8Array;
}

export interface VmSorter {
  keyInfo: VmKeyInfo;
  entries: VmSorterEntry[];
  readIdx: number;
  isSorted: boolean;
}

export interface VmAggBucket {
  hash: number;
  keys: any[];
  count: number;
  sum: number;
  min_val: number;
  max_val: number;
  has_val: boolean;
}

export interface VmAggregator {
  mode: number; // 0 = hash, 1 = stream
  startKeyReg: number;
  numKeys: number;
  capacity: number;
  occupiedCount: number;
  readIdx: number;
  buckets: VmAggBucket[];
}

export interface VmContext {
  pc: number;
  status: VmStatus;
  fault_page_id: number;
  resultCount: number;
  resultOffset: number;
  arenaOffset: number;
  maxQueryMemory: number;
  rowsAffected: number;
  registers: (number | bigint | string | Uint8Array | null)[];
  cursor: VmCursor;
  cursors: VmCursor[];
  keyInfos: VmKeyInfo[];
  sorters: VmSorter[];
  aggregators: VmAggregator[];
  table: TableMeta | null;
  tables?: TableMeta[];
  outputColumns?: ColumnMeta[];
  udfs?: Record<number, (...args: any[]) => any>;
  inSets?: Set<any>[];
}

export function createVmContext(): VmContext {
  const cursors: VmCursor[] = Array.from({ length: 16 }, () => createVmCursor());
  return {
    pc: 0,
    status: VmStatus.RUNNING,
    fault_page_id: 0,
    resultCount: 0,
    resultOffset: 0,
    arenaOffset: 0,
    maxQueryMemory: DEFAULT_MAX_QUERY_MEMORY,
    rowsAffected: 0,
    registers: new Array(64).fill(null),
    cursor: cursors[0],
    cursors,
    keyInfos: [],
    sorters: [],
    aggregators: [],
    table: null,
    tables: undefined,
    outputColumns: undefined,
    inSets: [],
  };
}

export function resetVmContext(
  ctx: VmContext,
  table?: TableMeta,
  tables?: TableMeta[],
): void {
  ctx.pc = 0;
  ctx.status = VmStatus.RUNNING;
  ctx.fault_page_id = 0;
  ctx.resultCount = 0;
  ctx.resultOffset = 0;
  ctx.arenaOffset = 0;
  ctx.maxQueryMemory = DEFAULT_MAX_QUERY_MEMORY;
  ctx.rowsAffected = 0;
  ctx.registers.fill(null);
  for (let i = 0; i < ctx.cursors.length; i++) {
    const c = ctx.cursors[i];
    c.pageId = 0;
    c.rootPageId = 0;
    c.slotIdx = 0;
    c.cellIdx = 0;
    c.rowOffset = 0;
    c.btreeDepth = 0;
    c.flags = 0;
  }
  ctx.cursor = ctx.cursors[0];
  ctx.keyInfos = [];
  ctx.sorters = [];
  ctx.aggregators = [];
  ctx.table = table ?? null;
  ctx.tables = tables;
  ctx.outputColumns = undefined;
  ctx.inSets = [];
}
