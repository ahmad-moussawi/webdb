import { describe, it, expect } from 'vitest';
import {
  serializeRow,
  deserializeRow,
} from '../src/engine/page.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
} from '../src/types.js';
import { UuidCodec, UlidCodec } from '../src/engine/codecs.js';

describe('Test Suite 4: SQLite 3VL NULL & Data Type Serialization (tests/nulls_encoding.test.ts)', () => {
  const table: TableMeta = {
    tableId: 1,
    columnCount: 6,
    rootPageId: 2,
    colCatalogPageId: 3,
    name: 'types_test',
    flags: 1,
    rowCountEstimate: 0,
    autoIncNext: 1n,
    columns: [
      { type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY, colOffset: 0, name: 'id' },
      { type: DataType.INT32, flags: ColumnFlag.NONE, colOffset: 4, name: 'int_val' },
      { type: DataType.INT64, flags: ColumnFlag.NONE, colOffset: 8, name: 'big_val' },
      { type: DataType.FLOAT64, flags: ColumnFlag.NONE, colOffset: 16, name: 'float_val' },
      { type: DataType.UUID, flags: ColumnFlag.NONE, colOffset: 24, name: 'uuid_val' },
      { type: DataType.TEXT, flags: ColumnFlag.NONE, colOffset: 40, name: 'text_val' },
    ],
  };

  it('1. Zero-Byte NULL Storage: Rows with NULL columns occupy strictly fewer bytes', () => {
    const fullRow = {
      id: 1,
      int_val: 42,
      big_val: 9999999999n,
      float_val: 3.14159,
      uuid_val: '550e8400-e29b-41d4-a716-446655440000',
      text_val: 'hello world',
    };

    const nullRow = {
      id: 2,
      int_val: null,
      big_val: null,
      float_val: null,
      uuid_val: null,
      text_val: null,
    };

    const fullBytes = serializeRow(table, fullRow);
    const nullBytes = serializeRow(table, nullRow);

    // In fullRow: 4B int + 8B big + 8B float + 16B uuid + 4B varTable + 11B text = 51 bytes of payload
    // In nullRow: 0 bytes of fixed payload, 4B varTable (len=0), 0B text payload
    expect(nullBytes.byteLength).toBeLessThan(fullBytes.byteLength);
    expect(fullBytes.byteLength - nullBytes.byteLength).toBeGreaterThanOrEqual(47);

    // Assert round-trip deserialization preserves nulls perfectly
    const view = new DataView(nullBytes.buffer);
    const decoded = deserializeRow(table, view, 0);

    expect(decoded.id).toBe(2);
    expect(decoded.int_val).toBeNull();
    expect(decoded.big_val).toBeNull();
    expect(decoded.float_val).toBeNull();
    expect(decoded.uuid_val).toBeNull();
    expect(decoded.text_val).toBeNull();
  });

  it('2. Type Range Safety (INT32, INT64, FLOAT64, UUID, ULID)', () => {
    const uuidStr = '550e8400-e29b-41d4-a716-446655440000';
    const ulidStr = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const testTable: TableMeta = {
      tableId: 2,
      columnCount: 5,
      rootPageId: 3,
      colCatalogPageId: 4,
      name: 'range_table',
      flags: 1,
      rowCountEstimate: 0,
      autoIncNext: 1n,
      columns: [
        { type: DataType.INT32, flags: 0, colOffset: 0, name: 'i32' },
        { type: DataType.INT64, flags: 0, colOffset: 4, name: 'i64' },
        { type: DataType.FLOAT64, flags: 0, colOffset: 12, name: 'f64' },
        { type: DataType.UUID, flags: 0, colOffset: 20, name: 'uid' },
        { type: DataType.ULID, flags: 0, colOffset: 36, name: 'ulid' },
      ],
    };

    // Test minimum values
    const minRow = {
      i32: -2147483648,
      i64: -9223372036854775808n,
      f64: -Number.MAX_VALUE,
      uid: uuidStr,
      ulid: ulidStr,
    };
    const minBytes = serializeRow(testTable, minRow);
    const minDecoded = deserializeRow(testTable, new DataView(minBytes.buffer), 0);

    expect(minDecoded.i32).toBe(-2147483648);
    expect(minDecoded.i64).toBe(-9223372036854775808n);
    expect(minDecoded.f64).toBe(-Number.MAX_VALUE);
    expect(minDecoded.uid).toBe(uuidStr);
    expect(minDecoded.ulid).toBe(ulidStr);

    // Test maximum values
    const maxRow = {
      i32: 2147483647,
      i64: 9223372036854775807n,
      f64: Number.MAX_VALUE,
      uid: uuidStr,
      ulid: ulidStr,
    };
    const maxBytes = serializeRow(testTable, maxRow);
    const maxDecoded = deserializeRow(testTable, new DataView(maxBytes.buffer), 0);

    expect(maxDecoded.i32).toBe(2147483647);
    expect(maxDecoded.i64).toBe(9223372036854775807n);
    expect(maxDecoded.f64).toBe(Number.MAX_VALUE);
    expect(maxDecoded.uid).toBe(uuidStr);
    expect(maxDecoded.ulid).toBe(ulidStr);
  });

  it('3. Empty String vs. NULL Text are strictly distinguished', () => {
    const textTable: TableMeta = {
      tableId: 3,
      columnCount: 2,
      rootPageId: 4,
      colCatalogPageId: 5,
      name: 'str_table',
      flags: 1,
      rowCountEstimate: 0,
      autoIncNext: 1n,
      columns: [
        { type: DataType.INT32, flags: 0, colOffset: 0, name: 'id' },
        { type: DataType.TEXT, flags: 0, colOffset: 0, name: 'txt' },
      ],
    };

    const emptyRow = { id: 1, txt: '' }; // Non-null empty string
    const nullRow = { id: 2, txt: null }; // NULL

    const emptyBytes = serializeRow(textTable, emptyRow);
    const nullBytes = serializeRow(textTable, nullRow);

    const emptyDecoded = deserializeRow(textTable, new DataView(emptyBytes.buffer), 0);
    const nullDecoded = deserializeRow(textTable, new DataView(nullBytes.buffer), 0);

    expect(emptyDecoded.txt).toBe('');
    expect(emptyDecoded.txt).not.toBeNull();

    expect(nullDecoded.txt).toBeNull();
  });
});
