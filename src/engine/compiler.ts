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

export interface DisassembledInstruction {
  addr: number;
  opcode: string;
  p1: string;
  p2: string;
  p3: string;
  comment: string;
}

const textDecoder = new TextDecoder();

/**
 * Disassembles binary bytecode into human-readable instructions.
 */
export function disassembleBytecode(bytecode: Uint8Array, table?: TableMeta): DisassembledInstruction[] {
  const instructions: DisassembledInstruction[] = [];
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  let pc = 0;

  const getColName = (idx: number) => {
    return table?.columns[idx]?.name ? `'${table.columns[idx].name}'` : `col_${idx}`;
  };

  const fmtAddr = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

  while (pc < bytecode.byteLength) {
    const addr = pc;
    const op = bytecode[pc++];

    switch (op) {
      case OpCode.OP_HALT:
        instructions.push({
          addr,
          opcode: 'OP_HALT',
          p1: '',
          p2: '',
          p3: '',
          comment: 'Halt VM execution (STATUS_DONE)',
        });
        break;

      case OpCode.OP_OPEN_CURSOR: {
        const cursor = bytecode[pc++];
        const rootPage = view.getUint32(pc, true);
        pc += 4;
        instructions.push({
          addr,
          opcode: 'OP_OPEN_CURSOR',
          p1: `c[${cursor}]`,
          p2: `page=${rootPage}`,
          p3: '',
          comment: `Open cursor ${cursor} on root page ${rootPage}${table ? ` ('${table.name}')` : ''}`,
        });
        break;
      }

      case OpCode.OP_REWIND: {
        const cursor = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: 'OP_REWIND',
          p1: `c[${cursor}]`,
          p2: fmtAddr(jumpTarget),
          p3: '',
          comment: `Rewind cursor to first row; jump to ${fmtAddr(jumpTarget)} if empty`,
        });
        break;
      }

      case OpCode.OP_NEXT_ROW: {
        const cursor = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: 'OP_NEXT_ROW',
          p1: `c[${cursor}]`,
          p2: fmtAddr(jumpTarget),
          p3: '',
          comment: `Advance cursor to next row; jump to ${fmtAddr(jumpTarget)} if EOF`,
        });
        break;
      }

      case OpCode.OP_COLUMN_INT: {
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: 'OP_COLUMN_INT',
          p1: `c[0]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as INT into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_FLOAT: {
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: 'OP_COLUMN_FLOAT',
          p1: `c[0]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as FLOAT into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_TEXT: {
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: 'OP_COLUMN_TEXT',
          p1: `c[0]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as TEXT into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_IS_NULL: {
        const colIdx = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: 'OP_IS_NULL',
          p1: `c[0]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: fmtAddr(jumpTarget),
          comment: `If ${getColName(colIdx)} IS NULL -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_IS_NOT_NULL: {
        const colIdx = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: 'OP_IS_NOT_NULL',
          p1: `c[0]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: fmtAddr(jumpTarget),
          comment: `If ${getColName(colIdx)} IS NOT NULL -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_EQ:
      case OpCode.OP_NE:
      case OpCode.OP_GT:
      case OpCode.OP_GE:
      case OpCode.OP_LT:
      case OpCode.OP_LE: {
        const opNames: Record<number, string> = {
          [OpCode.OP_EQ]: 'OP_EQ',
          [OpCode.OP_NE]: 'OP_NE',
          [OpCode.OP_GT]: 'OP_GT',
          [OpCode.OP_GE]: 'OP_GE',
          [OpCode.OP_LT]: 'OP_LT',
          [OpCode.OP_LE]: 'OP_LE',
        };
        const symbols: Record<number, string> = {
          [OpCode.OP_EQ]: '==',
          [OpCode.OP_NE]: '!=',
          [OpCode.OP_GT]: '>',
          [OpCode.OP_GE]: '>=',
          [OpCode.OP_LT]: '<',
          [OpCode.OP_LE]: '<=',
        };
        const regA = bytecode[pc++];
        const regB = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: opNames[op],
          p1: `r[${regA}]`,
          p2: `r[${regB}]`,
          p3: fmtAddr(jumpTarget),
          comment: `If r[${regA}] ${symbols[op]} r[${regB}] -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_JUMP: {
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: 'OP_JUMP',
          p1: fmtAddr(jumpTarget),
          p2: '',
          p3: '',
          comment: `Unconditional jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_LOAD_INT: {
        const regIdx = bytecode[pc++];
        const val = view.getInt32(pc, true);
        pc += 4;
        instructions.push({
          addr,
          opcode: 'OP_LOAD_INT',
          p1: `r[${regIdx}]`,
          p2: `${val}`,
          p3: '',
          comment: `Load literal int ${val} into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_LOAD_FLOAT: {
        const regIdx = bytecode[pc++];
        const val = view.getFloat64(pc, true);
        pc += 8;
        instructions.push({
          addr,
          opcode: 'OP_LOAD_FLOAT',
          p1: `r[${regIdx}]`,
          p2: `${val}`,
          p3: '',
          comment: `Load literal float ${val} into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_LOAD_TEXT: {
        const regIdx = bytecode[pc++];
        const len = view.getUint16(pc, true);
        pc += 2;
        const textBytes = new Uint8Array(bytecode.buffer, bytecode.byteOffset + pc, len);
        const str = textDecoder.decode(textBytes);
        pc += len;
        instructions.push({
          addr,
          opcode: 'OP_LOAD_TEXT',
          p1: `r[${regIdx}]`,
          p2: `"${str}"`,
          p3: '',
          comment: `Load literal text "${str}" into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_LOAD_NULL: {
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: 'OP_LOAD_NULL',
          p1: `r[${regIdx}]`,
          p2: 'NULL',
          p3: '',
          comment: `Set r[${regIdx}] to NULL`,
        });
        break;
      }

      case OpCode.OP_EMIT_ROW: {
        const cursor = bytecode[pc++];
        instructions.push({
          addr,
          opcode: 'OP_EMIT_ROW',
          p1: `c[${cursor}]`,
          p2: '',
          p3: '',
          comment: `Row passed all filters -> emit to Output Result Buffer`,
        });
        break;
      }

      default:
        instructions.push({
          addr,
          opcode: `OP_UNKNOWN(0x${op.toString(16)})`,
          p1: '',
          p2: '',
          p3: '',
          comment: 'Unknown opcode',
        });
        break;
    }
  }

  return instructions;
}

/**
 * Formats a list of disassembled instructions into an ASCII table string.
 */
export function formatDisassembly(instructions: DisassembledInstruction[]): string {
  const pad = (s: string, n: number) => s.padEnd(n, ' ');
  const fmtAddr = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

  let out = `${pad('ADDR', 8)} ${pad('OPCODE', 18)} ${pad('P1', 12)} ${pad('P2', 20)} ${pad('P3', 10)} COMMENT\n`;
  out += '-'.repeat(95) + '\n';

  for (const ins of instructions) {
    out += `${pad(fmtAddr(ins.addr), 8)} ${pad(ins.opcode, 18)} ${pad(ins.p1, 12)} ${pad(ins.p2, 20)} ${pad(ins.p3, 10)} ${ins.comment}\n`;
  }

  return out;
}

