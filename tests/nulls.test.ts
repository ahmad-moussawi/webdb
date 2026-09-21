import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/webdb.js';
import { NotNullConstraintError } from '../src/types.js';

describe('SQLite-Compatible NULL Semantics & 3VL', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'test_nulls', storage: 'memory' });
    await db.createTable('employees', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'department', type: 'TEXT' }, // Nullable
      { name: 'salary', type: 'INT32' },     // Nullable
    ]);

    await db.insert('employees', { id: 1, name: 'Alice', department: 'Engineering', salary: 120000 });
    await db.insert('employees', { id: 2, name: 'Bob', department: null, salary: 90000 });
    await db.insert('employees', { id: 3, name: 'Charlie', department: 'Sales', salary: null });
    await db.insert('employees', { id: 4, name: 'Diana', department: null, salary: null });
  });

  it('evaluates col = NULL and col != NULL to UNKNOWN (matches 0 rows in WHERE)', async () => {
    // In SQL / SQLite 3VL: salary = NULL always evaluates to UNKNOWN (falsy)
    const eqNull = await db.from('employees').where('salary', '=', null).toArray();
    expect(eqNull).toHaveLength(0);

    const neNull = await db.from('employees').where('salary', '!=', null).toArray();
    expect(neNull).toHaveLength(0);
  });

  it('accurately selects null rows via whereNull()', async () => {
    const nullDeps = await db.from('employees').whereNull('department').toArray();
    expect(nullDeps).toHaveLength(2);
    expect(nullDeps.map((e) => e.name).sort()).toEqual(['Bob', 'Diana']);

    const nullSalaries = await db.from('employees').whereNull('salary').toArray();
    expect(nullSalaries).toHaveLength(2);
    expect(nullSalaries.map((e) => e.name).sort()).toEqual(['Charlie', 'Diana']);
  });

  it('accurately selects non-null rows via whereNotNull()', async () => {
    const hasDept = await db.from('employees').whereNotNull('department').toArray();
    expect(hasDept).toHaveLength(2);
    expect(hasDept.map((e) => e.name).sort()).toEqual(['Alice', 'Charlie']);
  });

  it('combines whereNotNull with comparison filters', async () => {
    const highPaidInDept = await db.from('employees')
      .whereNotNull('department')
      .where('salary', '>', 100000)
      .toArray();

    expect(highPaidInDept).toHaveLength(1);
    expect(highPaidInDept[0].name).toBe('Alice');
  });

  it('rejects inserting NULL into NOT NULL columns', async () => {
    await expect(
      db.insert('employees', { id: 5, name: null as any, department: 'HR' })
    ).rejects.toThrow(NotNullConstraintError);
  });

  it('implements SQLite collation ordering where NULL is smaller than any value', async () => {
    const ascRows = await db.from('employees').orderBy('salary', 'asc').toArray();
    // In SQLite: NULLs appear FIRST in ASC ordering
    expect(ascRows[0].salary).toBeNull();
    expect(ascRows[1].salary).toBeNull();
    expect(ascRows[2].salary).toBe(90000);
    expect(ascRows[3].salary).toBe(120000);

    const descRows = await db.from('employees').orderBy('salary', 'desc').toArray();
    // In SQLite: NULLs appear LAST in DESC ordering
    expect(descRows[0].salary).toBe(120000);
    expect(descRows[1].salary).toBe(90000);
    expect(descRows[2].salary).toBeNull();
    expect(descRows[3].salary).toBeNull();
  });
});
