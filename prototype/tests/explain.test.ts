import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/webdb.js';

describe('Query Plan & Bytecode Disassembly (EXPLAIN)', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'test_explain', storage: 'memory' });
    await db.createTable('users', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'age', type: 'INT32' },
      { name: 'salary', type: 'FLOAT64' },
    ]);
  });

  it('generates a formatted bytecode disassembly plan', async () => {
    const explainResult = await db.from('users')
      .where('age', '>', 21)
      .whereNotNull('salary')
      .explain();

    expect(explainResult.plan.table).toBe('users');
    expect(explainResult.plan.scanType).toBe('TableScan');
    expect(explainResult.bytecodeSize).toBeGreaterThan(0);
    expect(explainResult.instructions.length).toBeGreaterThan(5);

    // Verify opcodes are present in instructions
    const opcodes = explainResult.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_LOAD_INT');
    expect(opcodes).toContain('OP_OPEN_CURSOR');
    expect(opcodes).toContain('OP_REWIND');
    expect(opcodes).toContain('OP_COLUMN_INT');
    expect(opcodes).toContain('OP_GT');
    expect(opcodes).toContain('OP_IS_NULL');
    expect(opcodes).toContain('OP_EMIT_ROW');
    expect(opcodes).toContain('OP_NEXT_ROW');
    expect(opcodes).toContain('OP_HALT');

    // Verify formatted assembly table string
    expect(explainResult.assembly).toContain('ADDR');
    expect(explainResult.assembly).toContain('OPCODE');
    expect(explainResult.assembly).toContain('OP_OPEN_CURSOR');
    expect(explainResult.assembly).toContain('OP_HALT');
  });
});
