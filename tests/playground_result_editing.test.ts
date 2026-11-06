import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB, DataType } from '../src/index.ts';
import {
  resolveEditability,
  getCellEditability,
  parseCellInput,
} from '../playground/src/utils/resultEditing.ts';

describe('Playground result grid editability', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: 'grid_edit', storage: 'memory' });
    await db.createTable('customers', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'city', type: 'TEXT' },
    ]);
    await db.createTable('orders', [
      { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      { name: 'customer_id', type: 'INT32' },
      { name: 'total', type: 'FLOAT64' },
    ]);
    await db.createTable('log', [{ name: 'msg', type: 'TEXT' }]);
    await db.insert('customers', { id: 1, name: 'Alice', city: 'Beirut' });
    await db.insert('orders', { id: 10, customer_id: 1, total: 5.5 });
    await db.insert('log', { msg: 'x' });
  });

  const resolve = async (qb: any) => {
    const rows = await qb.clone().toArray();
    const cols = rows.length ? Object.keys(rows[0]) : [];
    return { rows, cols, res: resolveEditability(qb.getQueryShape(), cols, await db.listTables()) };
  };

  it('allows editing direct table results that include the PK', async () => {
    const { rows, res } = await resolve(db.from('customers'));
    expect(res.disabledReason).toBeUndefined();
    const info = getCellEditability(res, 'name', rows[0]);
    expect(info.editable).toBe(true);
    expect(info.target).toMatchObject({ table: 'customers', column: 'name', notNull: true });
    // PK is editable too
    expect(getCellEditability(res, 'id', rows[0]).editable).toBe(true);
  });

  it('disables editing when the PK is not selected', async () => {
    const { rows, res } = await resolve(db.from('customers').select('name', 'city'));
    const info = getCellEditability(res, 'name', rows[0]);
    expect(info.editable).toBe(false);
    expect(info.reason).toMatch(/Primary key column "id"/);
  });

  it('disables editing for tables without a primary key', async () => {
    const { rows, res } = await resolve(db.from('log'));
    expect(getCellEditability(res, 'msg', rows[0]).reason).toMatch(/no primary key/);
  });

  it('disables grouped / aggregated results', async () => {
    const { res } = await resolve(db.from('orders').groupBy('customer_id').count('id', 'n'));
    expect(res.disabledReason).toMatch(/Grouped/);
  });

  it('disables derived tables and non-builder results', async () => {
    const { res } = await resolve(db.from(db.from('customers')));
    expect(res.disabledReason).toMatch(/derived table/);
    expect(resolveEditability(null, ['a'], await db.listTables()).disabledReason).toMatch(/query builder/);
  });

  it('supports aliased plain columns but not computed ones', async () => {
    const { rows, res } = await resolve(
      db.from('customers').select('id', 'name as customer_name', 'upper(city) as c'),
    );
    expect(getCellEditability(res, 'customer_name', rows[0])).toMatchObject({
      editable: true,
      target: { table: 'customers', column: 'name' },
    });
    expect(getCellEditability(res, 'c', rows[0]).editable).toBe(false);
  });

  it('maps joined results back to each table', async () => {
    const { rows, res } = await resolve(
      db
        .from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .select(['customers.id as cid', 'customers.name', 'orders.id as oid', 'orders.total']),
    );
    expect(getCellEditability(res, 'name', rows[0]).target?.table).toBe('customers');
    expect(getCellEditability(res, 'total', rows[0]).target?.table).toBe('orders');
    expect(res.source?.primaryKeys.get('orders')).toEqual([{ column: 'id', resultColumn: 'oid' }]);
  });

  it('blocks only the joined table whose PK is missing', async () => {
    const { rows, res } = await resolve(
      db
        .from('customers')
        .join('orders', 'customers.id', 'orders.customer_id')
        .select(['customers.id as cid', 'customers.name', 'orders.total']),
    );
    expect(getCellEditability(res, 'name', rows[0]).editable).toBe(true);
    expect(getCellEditability(res, 'total', rows[0]).editable).toBe(false);
  });

  it('handles unqualified joins without a select (colliding names are qualified)', async () => {
    const { rows, res } = await resolve(
      db.from('customers').join('orders', 'customers.id', 'orders.customer_id'),
    );
    expect(getCellEditability(res, 'name', rows[0]).target?.table).toBe('customers');
    expect(getCellEditability(res, 'customers.id', rows[0]).target?.table).toBe('customers');
    expect(getCellEditability(res, 'orders.id', rows[0]).target?.table).toBe('orders');
    expect(getCellEditability(res, 'total', rows[0]).target?.table).toBe('orders');
  });

  it('disables cells of unmatched LEFT JOIN rows', async () => {
    await db.insert('customers', { id: 2, name: 'Bob', city: null });
    const { rows, res } = await resolve(
      db
        .from('customers')
        .leftJoin('orders', 'customers.id', 'orders.customer_id')
        .select(['customers.id as cid', 'customers.name', 'orders.id as oid', 'orders.total'])
        .orderBy('customers.id'),
    );
    const bob = rows.find((r: any) => r.cid === 2);
    expect(getCellEditability(res, 'name', bob).editable).toBe(true);
    expect(getCellEditability(res, 'total', bob).editable).toBe(false);
  });

  it('parses typed input and enforces NOT NULL', () => {
    const int = { type: DataType.INT32, notNull: false, isPrimaryKey: false, column: 'n' };
    expect(parseCellInput('42', int, false)).toEqual({ ok: true, value: 42 });
    expect(parseCellInput('4.2', int, false).ok).toBe(false);
    expect(parseCellInput('', int, true)).toEqual({ ok: true, value: null });
    expect(parseCellInput('', { ...int, notNull: true }, true).ok).toBe(false);
    expect(parseCellInput('9007199254740993', { ...int, type: DataType.INT64 }, false)).toEqual({
      ok: true,
      value: 9007199254740993n,
    });
    expect(parseCellInput('abc', { ...int, type: DataType.FLOAT64 }, false).ok).toBe(false);
  });

  it('applies a PK edit via db.update filtered by the old key', async () => {
    const n = await db.update('customers', { id: 1 }, { id: 5, name: 'Alicia' });
    expect(n).toBe(1);
    expect(await db.from('customers').toArray()).toEqual([{ id: 5, name: 'Alicia', city: 'Beirut' }]);
  });
});
