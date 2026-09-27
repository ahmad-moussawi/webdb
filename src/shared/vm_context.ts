import { VmStatus, TableMeta } from '../types/index.js';

export interface VmCursor {
  pageId: number;
  slotIdx: number;
  cellIdx: number;
  rowOffset: number; // Absolute byte offset in view
  btreeDepth?: number;
  flags?: number;
}

export function createVmCursor(): VmCursor {
  return {
    pageId: 0,
    slotIdx: 0,
    cellIdx: 0,
    rowOffset: 0,
    btreeDepth: 0,
    flags: 0,
  };
}

export interface VmContext {
  pc: number;
  status: VmStatus;
  fault_page_id: number;
  resultCount: number;
  resultOffset: number;
  arenaOffset: number;
  rowsAffected: number;
  registers: (number | bigint | string | Uint8Array | null)[];
  cursor: VmCursor;
  cursors: VmCursor[];
  table: TableMeta | null;
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
    rowsAffected: 0,
    registers: new Array(64).fill(null),
    cursor: cursors[0],
    cursors,
    table: null,
  };
}

export function resetVmContext(ctx: VmContext, table?: TableMeta): void {
  ctx.pc = 0;
  ctx.status = VmStatus.RUNNING;
  ctx.fault_page_id = 0;
  ctx.resultCount = 0;
  ctx.resultOffset = 0;
  ctx.arenaOffset = 0;
  ctx.rowsAffected = 0;
  ctx.registers.fill(null);
  for (let i = 0; i < ctx.cursors.length; i++) {
    const c = ctx.cursors[i];
    c.pageId = 0;
    c.slotIdx = 0;
    c.cellIdx = 0;
    c.rowOffset = 0;
    c.btreeDepth = 0;
    c.flags = 0;
  }
  ctx.cursor = ctx.cursors[0];
  ctx.table = table ?? null;
}
