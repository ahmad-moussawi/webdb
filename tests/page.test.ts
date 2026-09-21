import { describe, it, expect } from 'vitest';
import {
  initPage,
  insertRowIntoPage,
  getCellCount,
  serializeRow,
  deserializeRow,
  getTableLayout,
} from '../src/engine/page.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
  RowSizeLimitExceededError,
  NotNullConstraintError,
} from '../src/types.js';
import { PAGE_SIZE } from '../src/constants.js';

describe('Slotted Page & Row Format', () => {
  const table: TableMeta = {
    tableId: 1,
    columnCount: 4,
    rootPageId: 2,
    name: 'users',
    columns: [
      { type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY | ColumnFlag.NOT_NULL, colOffset: 0, name: 'id' },
      { type: DataType.TEXT, flags: ColumnFlag.NOT_NULL, colOffset: 0, name: 'name' },
      { type: DataType.INT32, flags: ColumnFlag.NONE, colOffset: 4, name: 'age' },
      { type: DataType.FLOAT64, flags: ColumnFlag.NONE, colOffset: 8, name: 'score' },
    ],
  };

  it('initializes an empty slotted page with 4KB size', () => {
    const buffer = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buffer);
    initPage(view, 0);

    expect(getCellCount(view, 0)).toBe(0);
    expect(view.getUint16(4, true)).toBe(PAGE_SIZE); // cell_content_offset starts at 4096
  });

  it('serializes and deserializes records with dynamic null-bitmap', () => {
    const buffer = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buffer);
    initPage(view, 0);

    const row1 = { id: 1, name: 'Alice', age: 30, score: 98.5 };
    const row2 = { id: 2, name: 'Bob', age: null, score: null };

    const bytes1 = serializeRow(table, row1);
    const bytes2 = serializeRow(table, row2);

    expect(bytes1.byteLength).toBeGreaterThan(0);
    expect(bytes2.byteLength).toBeLessThan(bytes1.byteLength); // Null columns save bytes

    const slot0 = insertRowIntoPage(view, 0, bytes1);
    const slot1 = insertRowIntoPage(view, 0, bytes2);

    expect(slot0).toBe(0);
    expect(slot1).toBe(1);
    expect(getCellCount(view, 0)).toBe(2);

    const offset0 = view.getUint16(12 + 0, true);
    const offset1 = view.getUint16(12 + 2, true);

    const decoded1 = deserializeRow(view, offset0, table);
    const decoded2 = deserializeRow(view, offset1, table);

    expect(decoded1).toEqual({ id: 1, name: 'Alice', age: 30, score: 98.5 });
    expect(decoded2).toEqual({ id: 2, name: 'Bob', age: null, score: null });
  });

  it('enforces strict NOT NULL constraints at serialization time', () => {
    const invalidRow = { id: 1, name: null, age: 25 }; // name is NOT NULL
    expect(() => serializeRow(table, invalidRow as any)).toThrow(NotNullConstraintError);
  });

  it('enforces strict 2048-byte max row limit with RowSizeLimitExceededError', () => {
    // Construct a large row exceeding 2048 bytes
    const largeName = 'X'.repeat(2100);
    const largeRow = { id: 99, name: largeName, age: 20, score: 50.0 };

    expect(() => serializeRow(table, largeRow)).toThrow(RowSizeLimitExceededError);
  });
});
