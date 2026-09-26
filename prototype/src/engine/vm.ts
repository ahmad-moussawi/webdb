import {
  PAGE_SIZE,
  PAGE_HEADER_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
} from '../constants.js';
import {
  OpCode,
  VmStatus,
  DataType,
  TableMeta,
} from '../types.js';
import {
  getCellCount,
  getCellOffset,
  getNextPageId,
  getTableLayout,
} from './page.js';

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
  registers: (number | bigint | string | null)[];
  cursor: VmCursor;
  table: TableMeta | null;
}

export function createVmContext(): VmContext {
  return {
    pc: 0,
    status: VmStatus.RUNNING,
    resultCount: 0,
    resultOffset: 0,
    registers: new Array(16).fill(null),
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

const textDecoder = new TextDecoder();

/**
 * Synchronous Bytecode VM execution step loop.
 * Runs instructions until STATUS_DONE, STATUS_BUFFER_FULL, or an error.
 */
export function vm_step(
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array
): VmStatus {
  const codeView = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  const codeLen = bytecode.byteLength;

  while (ctx.pc < codeLen) {
    const op = bytecode[ctx.pc];
    ctx.pc += 1;

    switch (op) {
      case OpCode.OP_HALT: {
        ctx.status = VmStatus.DONE;
        return VmStatus.DONE;
      }

      case OpCode.OP_OPEN_CURSOR: {
        // [OP_OPEN_CURSOR] [cursor_idx: uint8] [root_page_id: uint32]
        const _cursorIdx = bytecode[ctx.pc];
        const rootPageId = codeView.getUint32(ctx.pc + 1, true);
        ctx.pc += 5;

        ctx.cursor.pageId = rootPageId;
        ctx.cursor.cellIdx = 0;
        ctx.cursor.rowOffset = 0;
        break;
      }

      case OpCode.OP_REWIND: {
        // [OP_REWIND] [cursor_idx: uint8] [jump_target_pc: uint16]
        const _cursorIdx = bytecode[ctx.pc];
        const jumpTarget = codeView.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const pageOffset = (ctx.cursor.pageId - 1) * PAGE_SIZE;
        const cellCount = getCellCount(view, pageOffset);

        if (cellCount === 0) {
          ctx.pc = jumpTarget;
        } else {
          ctx.cursor.cellIdx = 0;
          const relCellOffset = getCellOffset(view, pageOffset, 0);
          ctx.cursor.rowOffset = pageOffset + relCellOffset;
        }
        break;
      }

      case OpCode.OP_NEXT_ROW: {
        // [OP_NEXT_ROW] [cursor_idx: uint8] [jump_eof_pc: uint16]
        const _cursorIdx = bytecode[ctx.pc];
        const jumpTarget = codeView.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const pageOffset = (ctx.cursor.pageId - 1) * PAGE_SIZE;
        const cellCount = getCellCount(view, pageOffset);

        ctx.cursor.cellIdx++;

        if (ctx.cursor.cellIdx < cellCount) {
          const relCellOffset = getCellOffset(view, pageOffset, ctx.cursor.cellIdx);
          ctx.cursor.rowOffset = pageOffset + relCellOffset;
        } else {
          // Check if there is a next page linked for this table
          const nextPageId = getNextPageId(view, pageOffset);
          if (nextPageId !== 0) {
            ctx.cursor.pageId = nextPageId;
            ctx.cursor.cellIdx = 0;
            const nextOffset = (nextPageId - 1) * PAGE_SIZE;
            const nextCount = getCellCount(view, nextOffset);
            if (nextCount > 0) {
              const relCellOffset = getCellOffset(view, nextOffset, 0);
              ctx.cursor.rowOffset = nextOffset + relCellOffset;
            } else {
              ctx.pc = jumpTarget; // Empty next page
            }
          } else {
            // EOF reached
            ctx.pc = jumpTarget;
          }
        }
        break;
      }

      case OpCode.OP_COLUMN_INT: {
        // [OP_COLUMN_INT] [col_idx: uint8] [target_reg: uint8]
        const colIdx = bytecode[ctx.pc];
        const regIdx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const col = table.columns[colIdx];
        const { fixedSliceSize, nullBitmapBytes } = getTableLayout(table.columns);

        const nullBitmapOffset = ctx.cursor.rowOffset + 1;
        const byteVal = view.getUint8(nullBitmapOffset + (colIdx >> 3));
        const isNull = (byteVal & (1 << (colIdx & 7))) !== 0;

        if (isNull) {
          ctx.registers[regIdx] = null;
        } else {
          const fixedSliceOffset = nullBitmapOffset + nullBitmapBytes;
          if (col.type === DataType.INT32) {
            ctx.registers[regIdx] = view.getInt32(fixedSliceOffset + col.colOffset, true);
          } else if (col.type === DataType.INT64) {
            ctx.registers[regIdx] = Number(view.getBigInt64(fixedSliceOffset + col.colOffset, true));
          }
        }
        break;
      }

      case OpCode.OP_COLUMN_FLOAT: {
        // [OP_COLUMN_FLOAT] [col_idx: uint8] [target_reg: uint8]
        const colIdx = bytecode[ctx.pc];
        const regIdx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const col = table.columns[colIdx];
        const { nullBitmapBytes } = getTableLayout(table.columns);

        const nullBitmapOffset = ctx.cursor.rowOffset + 1;
        const byteVal = view.getUint8(nullBitmapOffset + (colIdx >> 3));
        const isNull = (byteVal & (1 << (colIdx & 7))) !== 0;

        if (isNull) {
          ctx.registers[regIdx] = null;
        } else {
          const fixedSliceOffset = nullBitmapOffset + nullBitmapBytes;
          ctx.registers[regIdx] = view.getFloat64(fixedSliceOffset + col.colOffset, true);
        }
        break;
      }

      case OpCode.OP_COLUMN_TEXT: {
        // [OP_COLUMN_TEXT] [col_idx: uint8] [target_reg: uint8]
        const colIdx = bytecode[ctx.pc];
        const regIdx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const table = ctx.table!;
        const { fixedSliceSize, nullBitmapBytes } = getTableLayout(table.columns);

        const nullBitmapOffset = ctx.cursor.rowOffset + 1;
        const byteVal = view.getUint8(nullBitmapOffset + (colIdx >> 3));
        const isNull = (byteVal & (1 << (colIdx & 7))) !== 0;

        if (isNull) {
          ctx.registers[regIdx] = null;
        } else {
          let varIdx = 0;
          for (let i = 0; i < colIdx; i++) {
            const c = table.columns[i];
            if (c.type === DataType.TEXT || c.type === DataType.BLOB) {
              varIdx++;
            }
          }
          const fixedSliceOffset = nullBitmapOffset + nullBitmapBytes;
          const varTableOffset = fixedSliceOffset + fixedSliceSize;
          const entryOffset = varTableOffset + (varIdx * 4);
          const relOffset = view.getUint16(entryOffset, true);
          const len = view.getUint16(entryOffset + 2, true);

          if (len === 0) {
            ctx.registers[regIdx] = '';
          } else {
            const textBytes = new Uint8Array(view.buffer, ctx.cursor.rowOffset + relOffset, len);
            ctx.registers[regIdx] = textDecoder.decode(textBytes);
          }
        }
        break;
      }

      case OpCode.OP_IS_NULL: {
        // [OP_IS_NULL] [col_idx: uint8] [jump_target: uint16]
        const colIdx = bytecode[ctx.pc];
        const jumpTarget = codeView.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const nullBitmapOffset = ctx.cursor.rowOffset + 1;
        const byteVal = view.getUint8(nullBitmapOffset + (colIdx >> 3));
        const isNull = (byteVal & (1 << (colIdx & 7))) !== 0;

        if (isNull) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_IS_NOT_NULL: {
        // [OP_IS_NOT_NULL] [col_idx: uint8] [jump_target: uint16]
        const colIdx = bytecode[ctx.pc];
        const jumpTarget = codeView.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        const nullBitmapOffset = ctx.cursor.rowOffset + 1;
        const byteVal = view.getUint8(nullBitmapOffset + (colIdx >> 3));
        const isNull = (byteVal & (1 << (colIdx & 7))) !== 0;

        if (!isNull) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      // SQLite 3VL Comparison Opcodes
      // In SQLite, if either operand is NULL, the comparison evaluates to UNKNOWN (falsy in WHERE).
      // If UNKNOWN, the jump condition does NOT pass!
      case OpCode.OP_EQ: {
        // [OP_EQ] [regA: uint8] [regB: uint8] [jump_target: uint16]
        const regA = bytecode[ctx.pc];
        const regB = bytecode[ctx.pc + 1];
        const jumpTarget = codeView.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const valA = ctx.registers[regA];
        const valB = ctx.registers[regB];

        if (valA !== null && valB !== null && valA === valB) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_NE: {
        const regA = bytecode[ctx.pc];
        const regB = bytecode[ctx.pc + 1];
        const jumpTarget = codeView.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const valA = ctx.registers[regA];
        const valB = ctx.registers[regB];

        if (valA !== null && valB !== null && valA !== valB) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_GT: {
        const regA = bytecode[ctx.pc];
        const regB = bytecode[ctx.pc + 1];
        const jumpTarget = codeView.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const valA = ctx.registers[regA];
        const valB = ctx.registers[regB];

        if (valA !== null && valB !== null && (valA as any) > (valB as any)) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_GE: {
        const regA = bytecode[ctx.pc];
        const regB = bytecode[ctx.pc + 1];
        const jumpTarget = codeView.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const valA = ctx.registers[regA];
        const valB = ctx.registers[regB];

        if (valA !== null && valB !== null && (valA as any) >= (valB as any)) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_LT: {
        const regA = bytecode[ctx.pc];
        const regB = bytecode[ctx.pc + 1];
        const jumpTarget = codeView.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const valA = ctx.registers[regA];
        const valB = ctx.registers[regB];

        if (valA !== null && valB !== null && (valA as any) < (valB as any)) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_LE: {
        const regA = bytecode[ctx.pc];
        const regB = bytecode[ctx.pc + 1];
        const jumpTarget = codeView.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        const valA = ctx.registers[regA];
        const valB = ctx.registers[regB];

        if (valA !== null && valB !== null && (valA as any) <= (valB as any)) {
          ctx.pc = jumpTarget;
        }
        break;
      }

      case OpCode.OP_JUMP: {
        const jumpTarget = codeView.getUint16(ctx.pc, true);
        ctx.pc = jumpTarget;
        break;
      }

      case OpCode.OP_LOAD_INT: {
        const regIdx = bytecode[ctx.pc];
        const val = codeView.getInt32(ctx.pc + 1, true);
        ctx.pc += 5;
        ctx.registers[regIdx] = val;
        break;
      }

      case OpCode.OP_LOAD_FLOAT: {
        const regIdx = bytecode[ctx.pc];
        const val = codeView.getFloat64(ctx.pc + 1, true);
        ctx.pc += 9;
        ctx.registers[regIdx] = val;
        break;
      }

      case OpCode.OP_LOAD_TEXT: {
        const regIdx = bytecode[ctx.pc];
        const len = codeView.getUint16(ctx.pc + 1, true);
        const textBytes = new Uint8Array(bytecode.buffer, bytecode.byteOffset + ctx.pc + 3, len);
        ctx.registers[regIdx] = textDecoder.decode(textBytes);
        ctx.pc += 3 + len;
        break;
      }

      case OpCode.OP_LOAD_NULL: {
        const regIdx = bytecode[ctx.pc];
        ctx.pc += 1;
        ctx.registers[regIdx] = null;
        break;
      }

      case OpCode.OP_EMIT_ROW: {
        // [OP_EMIT_ROW] [cursor_idx: uint8]
        const _cursorIdx = bytecode[ctx.pc];
        ctx.pc += 1;

        // Determine row record length
        const table = ctx.table!;
        const { fixedSliceSize, varColCount, nullBitmapBytes } = getTableLayout(table.columns);
        const headerAndFixedSize = 1 + nullBitmapBytes + fixedSliceSize + (varColCount * 4);

        let totalRowLength = headerAndFixedSize;
        if (varColCount > 0) {
          const varTableOffset = ctx.cursor.rowOffset + 1 + nullBitmapBytes + fixedSliceSize;
          for (let v = 0; v < varColCount; v++) {
            const relOffset = view.getUint16(varTableOffset + (v * 4), true);
            const len = view.getUint16(varTableOffset + (v * 4) + 2, true);
            if (relOffset + len > totalRowLength) {
              totalRowLength = relOffset + len;
            }
          }
        }

        // Check if output buffer has space for 2B length + row record
        const needed = 2 + totalRowLength;
        if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
          ctx.status = VmStatus.BUFFER_FULL;
          return VmStatus.BUFFER_FULL;
        }

        const outTarget = RESULT_BUFFER_OFFSET + ctx.resultOffset;
        view.setUint16(outTarget, totalRowLength, true);

        // Copy row bytes into output result buffer
        const srcUint8 = new Uint8Array(view.buffer, ctx.cursor.rowOffset, totalRowLength);
        const destUint8 = new Uint8Array(view.buffer, outTarget + 2, totalRowLength);
        destUint8.set(srcUint8);

        ctx.resultOffset += needed;
        ctx.resultCount++;
        break;
      }

      default:
        throw new Error(`Unknown VM Opcode: 0x${op.toString(16)} at pc=${ctx.pc - 1}`);
    }
  }

  ctx.status = VmStatus.DONE;
  return VmStatus.DONE;
}
