import { VmStatus, TableMeta } from '../types/index.js';

export interface VmCursor {
  pageId: number;
  cellIdx: number;
  rowOffset: number; // Absolute byte offset in view
}

export interface VmContext {
  pc: number;
  status: VmStatus;
  resultCount: number;
  resultOffset: number;
  registers: (number | bigint | string | Uint8Array | null)[];
  cursor: VmCursor;
  table: TableMeta | null;
}

export function createVmContext(): VmContext {
  return {
    pc: 0,
    status: VmStatus.RUNNING,
    resultCount: 0,
    resultOffset: 0,
    registers: new Array(64).fill(null),
    cursor: {
      pageId: 0,
      cellIdx: 0,
      rowOffset: 0,
    },
    table: null,
  };
}

export function resetVmContext(ctx: VmContext, table: TableMeta): void {
  ctx.pc = 0;
  ctx.status = VmStatus.RUNNING;
  ctx.resultCount = 0;
  ctx.resultOffset = 0;
  ctx.registers.fill(null);
  ctx.cursor.pageId = 0;
  ctx.cursor.cellIdx = 0;
  ctx.cursor.rowOffset = 0;
  ctx.table = table;
}
