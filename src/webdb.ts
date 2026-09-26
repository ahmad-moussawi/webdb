import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
} from "./constants.js";
import {
  ColumnDefinition,
  TableMeta,
  DbRow,
  TableNotFoundError,
  ColumnFlag,
} from "./types.js";
import { IVfsAdapter } from "./storage/vfs.js";
import { MemoryVfsAdapter } from "./storage/memory.js";
import { IndexedDbVfsAdapter } from "./storage/idb.js";
import { OpfsVfsAdapter } from "./storage/opfs.js";
import { BufferPool } from "./engine/buffer_pool.js";
import {
  initPage1,
  readPage1Header,
  createTable as catalogCreateTable,
  loadTableMeta,
  findTableSlot,
  readTableDescriptor,
  writeTableDescriptor,
  listTableDescriptors,
  IPageProvider,
  readCatalogPageHeader,
} from "./engine/catalog.js";
import {
  insertRowIntoPage,
  getNextPageId,
  setNextPageId,
  serializeRow,
  deserializeRow,
} from "./engine/page.js";
import {
  createVmContext,
  resetVmContext,
  vm_step,
  VmContext,
} from "./engine/vm.js";
import {
  compileQuery,
  QueryFilter,
  disassembleBytecode,
  formatDisassembly,
} from "./engine/compiler.js";
import {
  QueryBuilder,
  ExplainOutput,
  IDatabaseQueryExecutor,
  QueryExecutionOptions,
} from "./query_builder.js";

export {
  QueryBuilder,
  ExplainOutput,
  IDatabaseQueryExecutor,
  QueryExecutionOptions,
};

export interface WebDbOptions {
  name: string;
  storage?: "memory" | "idb" | "opfs";
  vfs?: IVfsAdapter;
  slotCount?: number;
  maxQueryMemory?: number;
}

export class WebDB implements IDatabaseQueryExecutor {
  readonly vfs: IVfsAdapter;
  readonly pool: BufferPool;
  private vmCtx: VmContext;

  private constructor(vfs: IVfsAdapter, pool: BufferPool) {
    this.vfs = vfs;
    this.pool = pool;
    this.vmCtx = createVmContext();
  }

  static async open(options: WebDbOptions): Promise<WebDB> {
    const storageType = options.storage || "memory";
    let vfs: IVfsAdapter;
    if (options.vfs) {
      vfs = options.vfs;
    } else if (storageType === "idb") {
      vfs = new IndexedDbVfsAdapter(options.name);
    } else if (storageType === "opfs") {
      vfs = new OpfsVfsAdapter(options.name);
    } else {
      vfs = new MemoryVfsAdapter();
    }

    const pool = new BufferPool({
      vfs,
      slotCount: options.slotCount ?? DEFAULT_SLOT_COUNT,
      maxQueryMemory: options.maxQueryMemory ?? DEFAULT_MAX_QUERY_MEMORY,
    });

    // Check if Page 1 exists in storage
    const page1Data = await vfs.readPage(1);
    if (!page1Data) {
      // Initialize Page 1 in slot 0
      initPage1(pool.getSlotDataView(0));
      pool.markDirty(0);
      await pool.flushSlot(0);
    } else {
      // Load Page 1 into slot 0
      pool.getPageBytesInSlot(0).set(page1Data);
      pool.clearDirty(0);
      // Validate Page 1 header & checksum
      readPage1Header(pool.getSlotDataView(0), true);

      // Section 6.2: Pre-load and permanently pin all column catalog pages for active tables
      const tableDescriptors = listTableDescriptors(pool.getSlotDataView(0));
      for (const desc of tableDescriptors) {
        let catPageId = desc.colCatalogPageId;
        while (catPageId !== 0) {
          const slot = await pool.acquireAndPinPage(catPageId);
          const view = pool.getSlotDataView(slot);
          const header = readCatalogPageHeader(view, 0);
          catPageId = header.nextColCatalogPageId;
        }
      }
    }

    return new WebDB(vfs, pool);
  }

  async createTable(
    name: string,
    columns: ColumnDefinition[],
  ): Promise<TableMeta> {
    const page1View = this.pool.getSlotDataView(0);

    // Dynamic pager provider for table creation
    const pager: IPageProvider = {
      allocateNewPage: () => {
        const currentTotal = page1View.getUint32(12, true);
        const newPageId = currentTotal + 1;
        page1View.setUint32(12, newPageId, true);
        this.pool.markDirty(0);
        return newPageId;
      },
      getPageBytes: (pageId: number) => {
        let slot = this.pool.getResidentSlot(pageId);
        if (slot === -1) {
          slot = pageId <= this.pool.slotCount ? pageId - 1 : 1;
          this.pool.setSlotToPage(slot, pageId);
        }
        return this.pool.getPageBytesInSlot(slot);
      },
      markPageDirty: (pageId: number) => {
        const slot = this.pool.getResidentSlot(pageId);
        if (slot !== -1) {
          this.pool.markDirty(slot);
        }
      },
    };

    const table = catalogCreateTable(page1View, pager, name, columns);

    // Permanently pin column catalog pages for this new table
    let catPageId = table.colCatalogPageId;
    while (catPageId !== 0) {
      const slot = await this.pool.acquireAndPinPage(catPageId);
      const header = readCatalogPageHeader(this.pool.getSlotDataView(slot), 0);
      catPageId = header.nextColCatalogPageId;
    }

    // Flush modified pages
    await this.pool.flushAllDirty();
    return table;
  }

  async getTable(tableName: string): Promise<TableMeta> {
    const page1View = this.pool.getSlotDataView(0);
    const slotIdx = findTableSlot(page1View, tableName);

    if (slotIdx === -1) {
      throw new TableNotFoundError(tableName);
    }

    const desc = readTableDescriptor(page1View, slotIdx)!;
    let catPageId = desc.colCatalogPageId;

    while (catPageId !== 0) {
      await this.pool.acquirePage(catPageId);
      const slot = this.pool.getResidentSlot(catPageId);
      const header = readCatalogPageHeader(this.pool.getSlotDataView(slot), 0);
      catPageId = header.nextColCatalogPageId;
    }

    const pager = {
      getPageBytes: (pageId: number) => {
        const slot = this.pool.getResidentSlot(pageId);
        if (slot !== -1) return this.pool.getPageBytesInSlot(slot);
        return new Uint8Array(PAGE_SIZE);
      },
    };
    return loadTableMeta(page1View, pager, tableName);
  }

  async insert(tableName: string, row: DbRow): Promise<void> {
    const table = await this.getTable(tableName);
    const page1View = this.pool.getSlotDataView(0);

    // Auto-Inc handling: if table has AUTO_INC column and row lacks it, assign next
    const autoIncCol = table.columns.find(
      (c) => (c.flags & ColumnFlag.AUTO_INC) !== 0,
    );
    if (
      autoIncCol &&
      (row[autoIncCol.name] === undefined || row[autoIncCol.name] === null)
    ) {
      row[autoIncCol.name] = Number(table.autoIncNext);
      // Increment autoIncNext on Page 1 TableDescriptor
      const slotIdx = findTableSlot(page1View, tableName);
      if (slotIdx !== -1) {
        const desc = readTableDescriptor(page1View, slotIdx)!;
        desc.autoIncNext += 1n;
        writeTableDescriptor(page1View, slotIdx, desc);
        this.pool.markDirty(0);
      }
    }

    const rowBytes = serializeRow(table.columns, row);

    // Navigate to the tail data page for this table
    let currentPageId = table.rootPageId;
    let slot = await this.pool.acquirePage(currentPageId);
    let view = this.pool.getSlotDataView(slot);

    while (true) {
      const nextPageId = getNextPageId(view, 0);
      if (nextPageId === 0) break;
      currentPageId = nextPageId;
      slot = await this.pool.acquirePage(currentPageId);
      view = this.pool.getSlotDataView(slot);
    }

    // Attempt insertion into current page
    let insertSlot = insertRowIntoPage(
      view,
      0,
      rowBytes,
      this.pool.pageScratchpadOffset,
    );

    if (insertSlot === -1) {
      // Pin current slot so allocatePage cannot evict it during page expansion
      this.pool.pinSlot(slot);
      try {
        const newPageId = await this.pool.allocateAndPinPage();
        const newSlot = this.pool.getResidentSlot(newPageId);
        try {
          // Link current page -> new page
          setNextPageId(view, 0, newPageId);
          this.pool.markDirty(slot);

          // Insert row into new page
          const newView = this.pool.getSlotDataView(newSlot);
          insertSlot = insertRowIntoPage(
            newView,
            0,
            rowBytes,
            this.pool.pageScratchpadOffset,
          );
          if (insertSlot === -1) {
            throw new Error("Unexpected error: row does not fit in empty page");
          }
          this.pool.markDirty(newSlot);
        } finally {
          this.pool.unpinSlot(newSlot);
        }
      } finally {
        this.pool.unpinSlot(slot);
      }
    } else {
      this.pool.markDirty(slot);
    }

    // Update row count estimate
    const slotIdx = findTableSlot(page1View, tableName);
    if (slotIdx !== -1) {
      const desc = readTableDescriptor(page1View, slotIdx)!;
      desc.rowCountEstimate += 1;
      writeTableDescriptor(page1View, slotIdx, desc);
      this.pool.markDirty(0);
    }

    // Durably flush modified pages
    await this.pool.flushAllDirty();
  }

  from(tableName: string): QueryBuilder {
    return new QueryBuilder(this, tableName);
  }

  async explainQuery(
    tableName: string,
    filters: QueryFilter[],
  ): Promise<ExplainOutput> {
    const table = await this.getTable(tableName);
    const bytecode = compileQuery({ table, filters });
    const instructions = disassembleBytecode(bytecode, table);
    const assembly = formatDisassembly(instructions);

    return {
      plan: {
        table: table.name,
        rootPageId: table.rootPageId,
        scanType: "TableScan",
        filters,
      },
      bytecodeSize: bytecode.byteLength,
      instructions,
      assembly,
    };
  }

  async executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: {
      limit: number | null;
      offset: number | null;
      sortCol: string | null;
      sortDir: "asc" | "desc";
    },
  ): Promise<DbRow[]> {
    const table = await this.getTable(tableName);

    // Pre-load all data pages for this table into buffer pool before running VM
    let currPageId = table.rootPageId;
    while (currPageId !== 0) {
      const slot = await this.pool.acquirePage(currPageId);
      const view = this.pool.getSlotDataView(slot);
      currPageId = getNextPageId(view, 0);
    }

    const bytecode = compileQuery({ table, filters });

    resetVmContext(this.vmCtx, table);
    vm_step(this.vmCtx, this.pool.view, bytecode);

    // Hydrate rows from Output Result Buffer
    let rows: DbRow[] = [];
    let currentOffset = 0;

    for (let i = 0; i < this.vmCtx.resultCount; i++) {
      const rowLen = this.pool.view.getUint16(
        RESULT_BUFFER_OFFSET + currentOffset,
        true,
      );
      const rowRecordOffset = RESULT_BUFFER_OFFSET + currentOffset + 2;

      const record = deserializeRow(
        table.columns,
        this.pool.view,
        rowRecordOffset,
      );
      rows.push(record);

      currentOffset += 2 + rowLen;
    }

    // Apply Sorting with SQLite-compatible 3VL NULL handling:
    // Collation rule: NULL is smaller than any other value!
    if (options.sortCol) {
      const col = options.sortCol;
      const asc = options.sortDir === "asc";

      rows.sort((a, b) => {
        const valA = a[col];
        const valB = b[col];

        if (valA === valB) return 0;
        if (valA === null || valA === undefined) return asc ? -1 : 1;
        if (valB === null || valB === undefined) return asc ? 1 : -1;

        if (typeof valA === "number" && typeof valB === "number") {
          return asc ? valA - valB : valB - valA;
        }
        if (typeof valA === "string" && typeof valB === "string") {
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return (valA as any) > (valB as any) ? (asc ? 1 : -1) : asc ? -1 : 1;
      });
    }

    // Apply Offset
    if (options.offset && options.offset > 0) {
      rows = rows.slice(options.offset);
    }

    // Apply Limit
    if (options.limit !== null && options.limit >= 0) {
      rows = rows.slice(0, options.limit);
    }

    return rows;
  }

  async close(): Promise<void> {
    await this.pool.flushAllDirty();
    await this.vfs.close();
  }
}
