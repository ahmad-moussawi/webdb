import {
  OpCode,
  DataType,
  TableMeta,
} from '../types.js';

export type ComparisonOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

export interface QueryFilter {
  type: 'null' | 'cmp';
  colName: string;
  isNull?: boolean; // true for isNull, false for isNotNull
  op?: ComparisonOp;
  value?: any;
}

export interface QueryPlan {
  table: TableMeta;
  filters: QueryFilter[];
  limit?: number;
  offset?: number;
}

class BytecodeEmitter {
  private buffer: number[] = [];
  private textEncoder = new TextEncoder();

  emitUint8(val: number): number {
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    return pos;
  }

  emitUint16(val: number): number {
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    this.buffer.push((val >> 8) & 0xff);
    return pos;
  }

  emitUint32(val: number): number {
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    this.buffer.push((val >> 8) & 0xff);
    this.buffer.push((val >> 16) & 0xff);
    this.buffer.push((val >> 24) & 0xff);
    return pos;
  }

  emitInt32(val: number): number {
    return this.emitUint32(val);
  }

  emitFloat64(val: number): number {
    const pos = this.buffer.length;
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, true);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) {
      this.buffer.push(u8[i]);
    }
    return pos;
  }

  emitString(str: string): number {
    const bytes = this.textEncoder.encode(str);
    const pos = this.emitUint16(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      this.buffer.push(bytes[i]);
    }
    return pos;
  }

  patchUint16(pos: number, val: number): void {
    this.buffer[pos] = val & 0xff;
    this.buffer[pos + 1] = (val >> 8) & 0xff;
  }

  currentOffset(): number {
    return this.buffer.length;
  }

  toByteArray(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

/**
 * Compiles a QueryPlan into an executable bytecode array.
 */
export function compileQuery(plan: QueryPlan): Uint8Array {
  const emitter = new BytecodeEmitter();
  const table = plan.table;

  // 1. Preamble: Load constant filter values into registers
  for (let i = 0; i < plan.filters.length; i++) {
    const filter = plan.filters[i];
    if (filter.type === 'cmp') {
      const regConst = i * 2 + 1;
      const val = filter.value;

      if (val === null || val === undefined) {
        emitter.emitUint8(OpCode.OP_LOAD_NULL);
        emitter.emitUint8(regConst);
      } else if (typeof val === 'number') {
        // Look up column datatype
        const col = table.columns.find((c) => c.name === filter.colName);
        if (col && col.type === DataType.FLOAT64) {
          emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
          emitter.emitUint8(regConst);
          emitter.emitFloat64(val);
        } else {
          emitter.emitUint8(OpCode.OP_LOAD_INT);
          emitter.emitUint8(regConst);
          emitter.emitInt32(Math.floor(val));
        }
      } else if (typeof val === 'bigint') {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regConst);
        emitter.emitInt32(Number(val));
      } else if (typeof val === 'string') {
        emitter.emitUint8(OpCode.OP_LOAD_TEXT);
        emitter.emitUint8(regConst);
        emitter.emitString(val);
      }
    }
  }

  // 2. Open Cursor
  emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
  emitter.emitUint8(0); // cursor_0
  emitter.emitUint32(table.rootPageId);

  // 3. Rewind Cursor
  emitter.emitUint8(OpCode.OP_REWIND);
  emitter.emitUint8(0); // cursor_0
  const rewindJumpPatch = emitter.emitUint16(0); // Patch later to EOF

  // 4. loop_start
  const loopStartPos = emitter.currentOffset();
  const nextRowPatches: number[] = [];

  for (let i = 0; i < plan.filters.length; i++) {
    const filter = plan.filters[i];
    const colIdx = table.columns.findIndex((c) => c.name === filter.colName);
    if (colIdx === -1) {
      throw new Error(`Column "${filter.colName}" not found in table "${table.name}"`);
    }
    const col = table.columns[colIdx];

    if (filter.type === 'null') {
      if (filter.isNull) {
        // If col IS NOT NULL -> skip to next row
        emitter.emitUint8(OpCode.OP_IS_NOT_NULL);
        emitter.emitUint8(colIdx);
        const patch = emitter.emitUint16(0);
        nextRowPatches.push(patch);
      } else {
        // If col IS NULL -> skip to next row
        emitter.emitUint8(OpCode.OP_IS_NULL);
        emitter.emitUint8(colIdx);
        const patch = emitter.emitUint16(0);
        nextRowPatches.push(patch);
      }
    } else if (filter.type === 'cmp') {
      const regCol = i * 2;
      const regConst = i * 2 + 1;

      // Read column into regCol
      if (col.type === DataType.INT32 || col.type === DataType.INT64) {
        emitter.emitUint8(OpCode.OP_COLUMN_INT);
        emitter.emitUint8(colIdx);
        emitter.emitUint8(regCol);
      } else if (col.type === DataType.FLOAT64) {
        emitter.emitUint8(OpCode.OP_COLUMN_FLOAT);
        emitter.emitUint8(colIdx);
        emitter.emitUint8(regCol);
      } else if (col.type === DataType.TEXT) {
        emitter.emitUint8(OpCode.OP_COLUMN_TEXT);
        emitter.emitUint8(colIdx);
        emitter.emitUint8(regCol);
      }

      // Test condition -> if satisfied, jump to pass_label; else fall through to skip
      let cmpOpcode = OpCode.OP_EQ;
      if (filter.op === '=') cmpOpcode = OpCode.OP_EQ;
      else if (filter.op === '!=') cmpOpcode = OpCode.OP_NE;
      else if (filter.op === '>') cmpOpcode = OpCode.OP_GT;
      else if (filter.op === '>=') cmpOpcode = OpCode.OP_GE;
      else if (filter.op === '<') cmpOpcode = OpCode.OP_LT;
      else if (filter.op === '<=') cmpOpcode = OpCode.OP_LE;

      emitter.emitUint8(cmpOpcode);
      emitter.emitUint8(regCol);
      emitter.emitUint8(regConst);
      const passPatch = emitter.emitUint16(0); // Patch to pass label

      // If condition failed or was UNKNOWN, jump to next_row
      emitter.emitUint8(OpCode.OP_JUMP);
      const skipPatch = emitter.emitUint16(0);
      nextRowPatches.push(skipPatch);

      // Pass label:
      emitter.patchUint16(passPatch, emitter.currentOffset());
    }
  }

  // 5. Emit matching row
  emitter.emitUint8(OpCode.OP_EMIT_ROW);
  emitter.emitUint8(0); // cursor_0

  // 6. next_row_label
  const nextRowPos = emitter.currentOffset();
  for (const patch of nextRowPatches) {
    emitter.patchUint16(patch, nextRowPos);
  }

  // 7. Advance cursor
  emitter.emitUint8(OpCode.OP_NEXT_ROW);
  emitter.emitUint8(0); // cursor_0
  const nextRowEofPatch = emitter.emitUint16(0); // Patch to EOF

  // Loop back
  emitter.emitUint8(OpCode.OP_JUMP);
  emitter.emitUint16(loopStartPos);

  // 8. EOF Label
  const eofPos = emitter.currentOffset();
  emitter.patchUint16(rewindJumpPatch, eofPos);
  emitter.patchUint16(nextRowEofPatch, eofPos);

  emitter.emitUint8(OpCode.OP_HALT);

  return emitter.toByteArray();
}
