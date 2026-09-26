import { describe, it, expect } from 'vitest';
import {
  createVmContext,
  resetVmContext,
} from '../src/shared/index.js';
import {
  vm_step,
  page_init,
  page_insert_row,
  page_serialize_row,
} from '../src/core/index.js';
import { compileQuery } from '../src/host/compiler/compiler.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
  VmStatus,
} from '../src/types/index.js';
import {
  TOTAL_MEMORY_BYTES,
} from '../src/constants.js';

describe('Bytecode Virtual Machine (VDBE)', () => {
  const table: TableMeta = {
    tableId: 1,
    flags: 1,
    rootPageId: 2,
    colCatalogPageId: 0,
    columnCount: 3,
    rowCountEstimate: 0,
    autoIncNext: 1n,
    name: 'products',
    columns: [
      { type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY, colOffset: 0, name: 'id' },
      { type: DataType.TEXT, flags: ColumnFlag.NONE, colOffset: 0, name: 'title' },
      { type: DataType.FLOAT64, flags: ColumnFlag.NONE, colOffset: 4, name: 'price' },
    ],
  };

  it('compiles and executes a bytecode plan to filter and emit matching rows', () => {
    const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
    const view = new DataView(buffer);

    // Initialize root page at page 2 (offset = (2 - 1) * 4096 = 4096)
    page_init(view, 4096);

    const row1 = page_serialize_row(table, { id: 1, title: 'Laptop', price: 999.99 });
    const row2 = page_serialize_row(table, { id: 2, title: 'Mouse', price: 29.50 });
    const row3 = page_serialize_row(table, { id: 3, title: 'Keyboard', price: 85.00 });

    page_insert_row(view, 4096, row1);
    page_insert_row(view, 4096, row2);
    page_insert_row(view, 4096, row3);

    // Filter: price > 50.00
    const bytecode = compileQuery({
      table,
      filters: [{ type: 'cmp', colName: 'price', op: '>', value: 50.0 }],
    });

    const ctx = createVmContext();
    resetVmContext(ctx, table);

    const status = vm_step(ctx, view, bytecode);

    expect(status).toBe(VmStatus.DONE);
    expect(ctx.resultCount).toBe(2); // Laptop (999.99) and Keyboard (85.00)
  });
});
