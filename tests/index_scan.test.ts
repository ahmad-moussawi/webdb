import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';

describe('Index Search & Query Acceleration (Phase 3)', () => {
  it('accelerates primary key point lookup using OP_INDEX_SEEK_EQ instead of TableScan', async () => {
    const db = await WebDB.open({ name: 'test_pk_seek', storage: 'memory' });

    await db.createTable('users', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
      { name: 'age', type: 'INT32' },
    ]);

    await db.insert('users', { id: 10, name: 'Alice', age: 25 });
    await db.insert('users', { id: 20, name: 'Bob', age: 30 });
    await db.insert('users', { id: 30, name: 'Charlie', age: 35 });

    // 1. Verify explain() diagnostics
    const explain = await db.from('users').where('id', '=', 20).explain();
    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.indexName).toBe('pk_users');

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_OPEN_INDEX');
    expect(opcodes).toContain('OP_INDEX_SEEK_EQ');
    // Bypasses full table scan: no OP_REWIND or OP_NEXT_ROW
    expect(opcodes).not.toContain('OP_REWIND');
    expect(opcodes).not.toContain('OP_NEXT_ROW');

    // 2. Verify query execution result
    const results = await db.from('users').where('id', '=', 20).toArray();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 20, name: 'Bob', age: 30 });

    // 3. Point seek on non-existent primary key returns empty array
    const notFound = await db.from('users').where('id', '=', 999).toArray();
    expect(notFound).toEqual([]);
  });

  it('accelerates secondary unique index point lookup', async () => {
    const db = await WebDB.open({ name: 'test_secondary_unique_seek', storage: 'memory' });

    await db.createTable('accounts', [
      { name: 'id', type: 'INT32', primaryKey: true, flags: { autoInc: true } },
      { name: 'email', type: 'TEXT' },
      { name: 'tier', type: 'TEXT' },
    ]);

    await db.createIndex('accounts', 'email', { name: 'idx_accounts_email', unique: true });

    await db.insert('accounts', { email: 'alice@domain.com', tier: 'gold' });
    await db.insert('accounts', { email: 'bob@domain.com', tier: 'silver' });
    await db.insert('accounts', { email: 'carol@domain.com', tier: 'bronze' });

    // Verify explain()
    const explain = await db.from('accounts').where('email', '=', 'bob@domain.com').explain();
    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.indexName).toBe('idx_accounts_email');

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_INDEX_SEEK_EQ');
    expect(opcodes).not.toContain('OP_REWIND');

    // Query result
    const rows = await db.from('accounts').where('email', '=', 'bob@domain.com').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'bob@domain.com', tier: 'silver' });

    // Non-existent key
    const missing = await db.from('accounts').where('email', '=', 'nobody@domain.com').toArray();
    expect(missing).toEqual([]);
  });

  it('accelerates composite index exact point lookup', async () => {
    const db = await WebDB.open({ name: 'test_composite_seek', storage: 'memory' });

    await db.createTable('memberships', [
      { name: 'id', type: 'INT32', primaryKey: true, flags: { autoInc: true } },
      { name: 'tenant_id', type: 'INT32' },
      { name: 'user_id', type: 'INT32' },
      { name: 'role', type: 'TEXT' },
    ]);

    await db.createIndex('memberships', ['tenant_id', 'user_id'], {
      name: 'idx_tenant_user',
      unique: true,
    });

    await db.insert('memberships', { tenant_id: 1, user_id: 101, role: 'admin' });
    await db.insert('memberships', { tenant_id: 1, user_id: 102, role: 'editor' });
    await db.insert('memberships', { tenant_id: 2, user_id: 101, role: 'viewer' });

    // Query matching composite index tuple
    const explain = await db
      .from('memberships')
      .where('tenant_id', '=', 1)
      .where('user_id', '=', 102)
      .explain();

    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.indexName).toBe('idx_tenant_user');

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_LOAD_BLOB');
    expect(opcodes).toContain('OP_INDEX_SEEK_EQ');

    const rows = await db
      .from('memberships')
      .where('tenant_id', '=', 1)
      .where('user_id', '=', 102)
      .toArray();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: 1, user_id: 102, role: 'editor' });
  });

  it('accelerates range scan queries via OP_INDEX_SEEK_GE and OP_INDEX_NEXT', async () => {
    const db = await WebDB.open({ name: 'test_index_range_scan', storage: 'memory' });

    await db.createTable('scores', [
      { name: 'id', type: 'INT32', primaryKey: true, flags: { autoInc: true } },
      { name: 'player', type: 'TEXT' },
      { name: 'score', type: 'INT32' },
    ]);

    await db.createIndex('scores', 'score', { name: 'idx_player_score' });

    await db.insert('scores', { player: 'P1', score: 50 });
    await db.insert('scores', { player: 'P2', score: 75 });
    await db.insert('scores', { player: 'P3', score: 85 });
    await db.insert('scores', { player: 'P4', score: 95 });
    await db.insert('scores', { player: 'P5', score: 100 });

    const explain = await db.from('scores').where('score', '>=', 85).explain();
    expect(explain.plan.scanType).toBe('IndexScan');
    expect(explain.plan.indexName).toBe('idx_player_score');

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_OPEN_INDEX');
    expect(opcodes).toContain('OP_INDEX_SEEK_GE');
    expect(opcodes).toContain('OP_INDEX_NEXT');

    const rows = await db.from('scores').where('score', '>=', 85).toArray();
    expect(rows).toHaveLength(3);
    const players = rows.map((r) => r.player);
    expect(players).toContain('P3');
    expect(players).toContain('P4');
    expect(players).toContain('P5');
  });

  it('evaluates additional non-indexed filters on index point lookups', async () => {
    const db = await WebDB.open({ name: 'test_point_seek_extra_filter', storage: 'memory' });

    await db.createTable('tasks', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'title', type: 'TEXT' },
      { name: 'status', type: 'TEXT' },
    ]);

    await db.insert('tasks', { id: 1, title: 'Write tests', status: 'completed' });
    await db.insert('tasks', { id: 2, title: 'Deploy', status: 'pending' });

    // Point seek on ID 1 with status = 'pending' should evaluate status and return nothing
    const noMatch = await db
      .from('tasks')
      .where('id', '=', 1)
      .where('status', '=', 'pending')
      .toArray();
    expect(noMatch).toEqual([]);

    // Point seek on ID 1 with status = 'completed' should return the row
    const match = await db
      .from('tasks')
      .where('id', '=', 1)
      .where('status', '=', 'completed')
      .toArray();
    expect(match).toHaveLength(1);
    expect(match[0]).toMatchObject({ id: 1, title: 'Write tests', status: 'completed' });
  });

  it('falls back to TableScan when no indexed column is queried', async () => {
    const db = await WebDB.open({ name: 'test_fallback_tablescan', storage: 'memory' });

    await db.createTable('items', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
      { name: 'category', type: 'TEXT' },
    ]);

    await db.insert('items', { id: 1, name: 'Apple', category: 'Fruit' });
    await db.insert('items', { id: 2, name: 'Carrot', category: 'Vegetable' });

    // Query on non-indexed column category
    const explain = await db.from('items').where('category', '=', 'Fruit').explain();
    expect(explain.plan.scanType).toBe('TableScan');
    expect(explain.plan.indexName).toBeUndefined();

    const opcodes = explain.instructions.map((i) => i.opcode);
    expect(opcodes).toContain('OP_REWIND');
    expect(opcodes).toContain('OP_NEXT_ROW');
    expect(opcodes).not.toContain('OP_INDEX_SEEK_EQ');

    const rows = await db.from('items').where('category', '=', 'Fruit').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Apple');
  });

  it('supports projected select fields with point seek', async () => {
    const db = await WebDB.open({ name: 'test_point_seek_projection', storage: 'memory' });

    await db.createTable('products', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
      { name: 'price', type: 'INT32' },
      { name: 'secret_code', type: 'TEXT' },
    ]);

    await db.insert('products', { id: 10, name: 'Gadget', price: 99, secret_code: 'SEC123' });

    const rows = await db
      .from('products')
      .select('name', 'price')
      .where('id', '=', 10)
      .toArray();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: 'Gadget', price: 99 });
    expect(rows[0]).not.toHaveProperty('secret_code');
  });
});
