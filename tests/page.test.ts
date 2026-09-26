import { describe, it, expect } from 'vitest';
import {
  page_init,
  page_insert_row,
  page_get_cell_count,
  page_get_cell_offset,
  page_serialize_row,
  page_deserialize_row,
} from '../src/core/index.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
  RowSizeLimitExceededError,
  NotNullConstraintError,
} from '../src/types/index.js';
import { PAGE_SIZE } from '../src/constants.js';

describe('Slotted Page & Row Format', () => {
  const table: TableMeta = {
    tableId: 1,
    flags: 1,
    rootPageId: 2,
    colCatalogPageId: 0,
    columnCount: 4,
    rowCountEstimate: 0,
    autoIncNext: 1n,
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
    page_init(view, 0);

    expect(page_get_cell_count(view, 0)).toBe(0);
    expect(view.getUint16(4, true)).toBe(PAGE_SIZE); // cell_content_offset starts at 4096
  });

  it('serializes and deserializes records with dynamic null-bitmap', () => {
    const buffer = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buffer);
    page_init(view, 0);

    const row1 = { id: 1, name: 'Alice', age: 30, score: 98.5 };
    const row2 = { id: 2, name: 'Bob', age: null, score: null };

    const bytes1 = page_serialize_row(table, row1);
    const bytes2 = page_serialize_row(table, row2);

    expect(bytes1.byteLength).toBeGreaterThan(0);
    expect(bytes2.byteLength).toBeLessThan(bytes1.byteLength); // Null columns save bytes

    const slot0 = page_insert_row(view, 0, bytes1);
    const slot1 = page_insert_row(view, 0, bytes2);

    expect(slot0).toBe(0);
    expect(slot1).toBe(1);
    expect(page_get_cell_count(view, 0)).toBe(2);

    const offset0 = page_get_cell_offset(view, 0, 0);
    const offset1 = page_get_cell_offset(view, 0, 1);

    const decoded1 = page_deserialize_row(view, offset0, table);
    const decoded2 = page_deserialize_row(view, offset1, table);

    expect(decoded1).toEqual({ id: 1, name: 'Alice', age: 30, score: 98.5 });
    expect(decoded2).toEqual({ id: 2, name: 'Bob', age: null, score: null });
  });

  it('enforces strict NOT NULL constraints at serialization time', () => {
    const invalidRow = { id: 1, name: null, age: 25 }; // name is NOT NULL
    expect(() => page_serialize_row(table, invalidRow as any)).toThrow(NotNullConstraintError);
  });

  it('enforces strict 2048-byte max row limit with RowSizeLimitExceededError', () => {
    // Construct a large row exceeding 2048 bytes
    const largeName = 'X'.repeat(2100);
    const largeRow = { id: 99, name: largeName, age: 20, score: 50.0 };

    expect(() => page_serialize_row(table, largeRow)).toThrow(RowSizeLimitExceededError);
  });
});
