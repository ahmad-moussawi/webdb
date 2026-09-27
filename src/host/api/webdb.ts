import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
} from "../../constants.ts";
import {
  ColumnDefinition,
  TableMeta,
  DbRow,
  TableNotFoundError,
  ColumnFlag,
  DataType,
  VmStatus,
  QueryTimeoutError,
  InvalidBytecodeError,
  QueryArenaExhaustedError,
} from "../../types/index.ts";
import { IVfsAdapter } from "../storage/vfs.ts";
import { MemoryVfsAdapter } from "../storage/memory.ts";
import { IndexedDbVfsAdapter } from "../storage/idb.ts";
import { OpfsVfsAdapter } from "../storage/opfs.ts";
import { Io } from "../storage/io.ts";
import {
  BufferPoolDriver,
  createWasmMemory,
} from "../driver/buffer_pool_driver.ts";
import {
  catalog_init_page1,
  catalog_read_page1_header,
  catalog_create_table,
  catalog_load_table_meta,
  catalog_find_table_slot,
  catalog_read_table_descriptor,
  catalog_write_table_descriptor,
  catalog_list_table_descriptors,
  catalog_read_page_header,
  page_insert_row,
  page_get_next_page_id,
  page_set_next_page_id,
  page_serialize_row,
  page_deserialize_row,
} from "../../core/index.ts";
import {
  createVmContext,
  resetVmContext,
  VmContext,
  IPageProvider,
} from "../../shared/index.ts";
import { vm_step } from "../../core/index.ts";
import {
  compileQuery,
  QueryFilter,
  SortKey,
  AggExpr,
  QueryPlan,
  disassembleBytecode,
  formatDisassembly,
} from "../compiler/compiler.ts";
import {
  QueryBuilder,
  type ExplainOutput,
  type IDatabaseQueryExecutor,
  type QueryExecutionOptions,
} from "./query_builder.ts";

export {
  QueryBuilder,
  type ExplainOutput,
  type IDatabaseQueryExecutor,
  type QueryExecutionOptions,
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
  readonly io: Io;
  readonly driver: BufferPoolDriver;

  /**
   * Alias to driver for callers/tests that inspect the buffer pool.
   */
  get pool(): BufferPoolDriver {
    return this.driver;
  }

  private vmCtx: VmContext;

  private constructor(vfs: IVfsAdapter, io: Io, driver: BufferPoolDriver) {
    this.vfs = vfs;
    this.io = io;
    this.driver = driver;
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

    const slotCount = options.slotCount ?? DEFAULT_SLOT_COUNT;
    const maxQueryMemory = options.maxQueryMemory ?? DEFAULT_MAX_QUERY_MEMORY;
    const memory = createWasmMemory(slotCount, maxQueryMemory);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount,
      maxQueryMemory,
    });

    // Check if Page 1 exists in storage
    const page1Data = await vfs.readPage(1);
    if (!page1Data) {
      // Initialize Page 1 in slot 0
      catalog_init_page1(driver.getSlotDataView(0));
      driver.markDirty(0);
      await driver.flushSlot(0);
    } else {
      // Load Page 1 into slot 0
      driver.getPageBytesInSlot(0).set(page1Data);
      driver.clearDirty(0);
      // Validate Page 1 header & checksum
      catalog_read_page1_header(driver.getSlotDataView(0), true);

      // Section 6.2: Pre-load and permanently pin all column catalog pages for active tables
      const tableDescriptors = catalog_list_table_descriptors(
        driver.getSlotDataView(0),
      );
      for (const desc of tableDescriptors) {
        let catPageId = desc.colCatalogPageId;
        while (catPageId !== 0) {
          const slot = await driver.acquireAndPinPage(catPageId);
          const view = driver.getSlotDataView(slot);
          const header = catalog_read_page_header(view, 0);
          catPageId = header.nextColCatalogPageId;
        }
      }
    }

    return new WebDB(vfs, io, driver);
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
          this.pool.assignSlot(slot, pageId);
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

    const table = catalog_create_table(page1View, pager, name, columns);

    // Permanently pin column catalog pages for this new table
    let catPageId = table.colCatalogPageId;
    while (catPageId !== 0) {
      const slot = await this.driver.acquireAndPinPage(catPageId);
      const header = catalog_read_page_header(
        this.pool.getSlotDataView(slot),
        0,
      );
      catPageId = header.nextColCatalogPageId;
    }

    // Flush modified pages
    await this.driver.flushAllDirty();
    return table;
  }

  async getTable(tableName: string): Promise<TableMeta> {
    const page1View = this.pool.getSlotDataView(0);
    const slotIdx = catalog_find_table_slot(page1View, tableName);

    if (slotIdx === -1) {
      throw new TableNotFoundError(tableName);
    }

    const desc = catalog_read_table_descriptor(page1View, slotIdx)!;
    let catPageId = desc.colCatalogPageId;

    while (catPageId !== 0) {
      await this.driver.acquirePage(catPageId);
      const slot = this.pool.getResidentSlot(catPageId);
      const header = catalog_read_page_header(
        this.pool.getSlotDataView(slot),
        0,
      );
      catPageId = header.nextColCatalogPageId;
    }

    const pager = {
      getPageBytes: (pageId: number) => {
        const slot = this.pool.getResidentSlot(pageId);
        if (slot !== -1) return this.pool.getPageBytesInSlot(slot);
        return new Uint8Array(PAGE_SIZE);
      },
    };
    return catalog_load_table_meta(page1View, pager, tableName);
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
      const slotIdx = catalog_find_table_slot(page1View, tableName);
      if (slotIdx !== -1) {
        const desc = catalog_read_table_descriptor(page1View, slotIdx)!;
        desc.autoIncNext += 1n;
        catalog_write_table_descriptor(page1View, slotIdx, desc);
        this.pool.markDirty(0);
      }
    }

    const rowBytes = page_serialize_row(table.columns, row);

    // Navigate to the tail data page for this table
    let currentPageId = table.rootPageId;
    let slot = await this.driver.acquirePage(currentPageId);
    let view = this.pool.getSlotDataView(slot);

    while (true) {
      const nextPageId = page_get_next_page_id(view, 0);
      if (nextPageId === 0) break;
      currentPageId = nextPageId;
      slot = await this.driver.acquirePage(currentPageId);
      view = this.pool.getSlotDataView(slot);
    }

    // Attempt insertion into current page
    let insertSlot = page_insert_row(
      view,
      0,
      rowBytes,
      this.pool.pageScratchpadOffset,
    );

    if (insertSlot === -1) {
      // Pin current slot so allocatePage cannot evict it during page expansion
      this.pool.pinSlot(slot);
      try {
        const newPageId = await this.driver.allocateAndPinPage();
        const newSlot = this.pool.getResidentSlot(newPageId);
        try {
          // Link current page -> new page
          page_set_next_page_id(view, 0, newPageId);
          this.pool.markDirty(slot);

          // Insert row into new page
          const newView = this.pool.getSlotDataView(newSlot);
          insertSlot = page_insert_row(
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
    const slotIdx = catalog_find_table_slot(page1View, tableName);
    if (slotIdx !== -1) {
      const desc = catalog_read_table_descriptor(page1View, slotIdx)!;
      desc.rowCountEstimate += 1;
      catalog_write_table_descriptor(page1View, slotIdx, desc);
      this.pool.markDirty(0);
    }

    // Durably flush modified pages
    await this.driver.flushAllDirty();
  }

  from(tableName: string): QueryBuilder {
    return new QueryBuilder(this, tableName);
  }

  async explainQuery(
    tableName: string,
    filters: QueryFilter[],
    options?: {
      orderBy?: SortKey[];
      groupBy?: string[];
      aggregates?: AggExpr[];
    },
  ): Promise<ExplainOutput> {
    const table = await this.getTable(tableName);
    const bytecode = compileQuery({
      table,
      filters,
      orderBy: options?.orderBy,
      groupBy: options?.groupBy,
      aggregates: options?.aggregates,
    });
    const instructions = disassembleBytecode(bytecode, table);
    const assembly = formatDisassembly(instructions);

    return {
      plan: {
        table: table.name,
        rootPageId: table.rootPageId,
        scanType: "TableScan",
        filters,
        orderBy: options?.orderBy,
        groupBy: options?.groupBy,
        aggregates: options?.aggregates,
      },
      bytecodeSize: bytecode.byteLength,
      instructions,
      assembly,
    };
  }

  async executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: QueryExecutionOptions,
  ): Promise<DbRow[]> {
    const table = await this.getTable(tableName);

    // Pre-load all data pages for this table into buffer pool before running VM
    let currPageId = table.rootPageId;
    while (currPageId !== 0) {
      const slot = await this.driver.acquirePage(currPageId);
      const view = this.pool.getSlotDataView(slot);
      currPageId = page_get_next_page_id(view, 0);
    }

    let orderBy = options.orderBy;
    if (!orderBy && options.sortCol) {
      orderBy = [{ colName: options.sortCol, direction: options.sortDir }];
    }

    const plan: QueryPlan = {
      table,
      filters,
      orderBy,
      groupBy: options.groupBy,
      aggregates: options.aggregates,
    };

    const bytecode = compileQuery(plan);

    resetVmContext(this.vmCtx, table);
    if (plan.keyInfos) {
      this.vmCtx.keyInfos = plan.keyInfos;
    }

    // Determine output columns for page_deserialize_row
    let outputColumns = table.columns;
    if (plan.aggregates && plan.aggregates.length > 0) {
      outputColumns = [];
      const groupByCols = plan.groupBy ?? [];
      for (const gColName of groupByCols) {
        const col = table.columns.find((c) => c.name === gColName);
        if (col) {
          outputColumns.push(col);
        } else {
          outputColumns.push({
            name: gColName,
            type: DataType.TEXT,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          });
        }
      }
      for (let j = 0; j < plan.aggregates.length; j++) {
        const agg = plan.aggregates[j];
        const aggName =
          agg.alias ?? (agg.colName ? `${agg.func}_${agg.colName}` : agg.func);
        const aggType = agg.func === "count" ? DataType.INT32 : DataType.FLOAT64;
        outputColumns.push({
          name: aggName,
          type: aggType,
          flags: ColumnFlag.NONE,
          colOffset: 0,
        });
      }
    }

    let rows: DbRow[] = [];
    while (true) {
      const status = vm_step(this.vmCtx, this.pool.view, bytecode);

      // Hydrate rows from Output Result Buffer for current chunk
      let currentOffset = 0;
      for (let i = 0; i < this.vmCtx.resultCount; i++) {
        const rowLen = this.pool.view.getUint16(
          RESULT_BUFFER_OFFSET + currentOffset,
          true,
        );
        const rowRecordOffset = RESULT_BUFFER_OFFSET + currentOffset + 2;

        const record = page_deserialize_row(
          outputColumns,
          this.pool.view,
          rowRecordOffset,
        );
        rows.push(record);

        currentOffset += 2 + rowLen;
      }

      if (status === VmStatus.DONE) {
        break;
      } else if (status === VmStatus.BUFFER_FULL) {
        this.vmCtx.resultOffset = 0;
        this.vmCtx.resultCount = 0;
        this.vmCtx.status = VmStatus.RUNNING;
      } else if (status === VmStatus.PAGE_FAULT) {
        await this.driver.acquirePage(this.vmCtx.fault_page_id);
        this.vmCtx.status = VmStatus.RUNNING;
      } else if (status === VmStatus.ARENA_EXHAUSTED) {
        this.vmCtx.arenaOffset = 0;
        throw new QueryArenaExhaustedError();
      } else if (status === VmStatus.TIMEOUT) {
        throw new QueryTimeoutError();
      } else if (status === VmStatus.INVALID_BYTECODE) {
        throw new InvalidBytecodeError();
      } else {
        throw new Error(`VM execution error: status=${status}`);
      }
    }

    // Apply Offset
    if (options.offset && options.offset > 0) {
      rows = rows.slice(options.offset);
    }

    // Apply Limit
    if (options.limit !== null && options.limit !== undefined && options.limit >= 0) {
      rows = rows.slice(0, options.limit);
    }

    return rows;
  }

  async close(): Promise<void> {
    await this.driver.flushAllDirty();
    await this.vfs.close();
  }
}
