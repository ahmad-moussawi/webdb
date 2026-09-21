import { describe, it, expect } from 'vitest';
import {
  createVmContext,
  resetVmContext,
  vm_step,
} from '../src/engine/vm.js';
import {
  initPage,
  insertRowIntoPage,
  serializeRow,
} from '../src/engine/page.js';
import { compileQuery } from '../src/engine/compiler.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
  VmStatus,
} from '../src/types.js';
import {
  PAGE_SIZE,
  TOTAL_MEMORY_BYTES,
} from '../src/constants.js';

describe('Bytecode Virtual Machine (VDBE)', () => {
  const table: TableMeta = {
    tableId: 1,
    columnCount: 3,
    rootPageId: 2,
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
    initPage(view, 4096);

    const row1 = serializeRow(table, { id: 1, title: 'Laptop', price: 999.99 });
    const row2 = serializeRow(table, { id: 2, title: 'Mouse', price: 29.50 });
    const row3 = serializeRow(table, { id: 3, title: 'Keyboard', price: 85.00 });

    insertRowIntoPage(view, 4096, row1);
    insertRowIntoPage(view, 4096, row2);
    insertRowIntoPage(view, 4096, row3);

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
