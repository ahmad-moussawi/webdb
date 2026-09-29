import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
  MAX_INDEXES_PAGE1,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_LEAF_DATA,
} from "../../constants.ts";
import {
  ColumnDefinition,
  ColumnMeta,
  TableMeta,
  DbRow,
  TableNotFoundError,
  ColumnFlag,
  DataType,
  VmStatus,
  QueryTimeoutError,
  InvalidBytecodeError,
  QueryArenaExhaustedError,
  TooManyCursorsError,
  UniqueConstraintViolationError,
  NotNullConstraintError,
  IndexFlag,
  IndexOptions,
  ColumnNotFoundError,
  IndexNotFoundError,
  IndexAlreadyExistsError,
  TooManyIndexesError,
  IndexDescriptor,
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
  catalog_list_table_indexes,
  catalog_find_index_by_name,
  catalog_find_free_index_slot,
  catalog_write_index_descriptor,
  catalog_delete_index_descriptor,
  catalog_delete_table_descriptor,
  catalog_read_index_descriptor,
  catalog_increment_schema_version,
  catalog_increment_change_counter,
  catalog_update_page1_checksum,
  page_get_type,
  page_get_cell_count,
  page_get_cell_offset,
  page_insert_row,
  page_get_next_page_id,
  page_set_next_page_id,
  page_serialize_row,
  page_deserialize_row,
  page_init_index_leaf,
  page_insert_index_leaf_cell,
  page_binary_search_index_leaf,
  serialize_composite_key,
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
  GroupKey,
  AggExpr,
  QueryPlan,
  JoinPlan,
  disassembleBytecode,
  formatDisassembly,
} from "../compiler/compiler.ts";
import { ParsedSelectExpr, deriveDefaultAlias } from "../compiler/expr_parser.ts";
import {
  QueryBuilder,
  type ExplainOutput,
  type IDatabaseQueryExecutor,
  type QueryExecutionOptions,
  type JoinClause,
} from "./query_builder.ts";

export interface UdfDefinition {
  deterministic?: boolean;
  returnType?: DataType;
  call: (...args: any[]) => any;
}

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
  private udfs: Map<string, { id: number; def: UdfDefinition }> = new Map();
  private nextUdfId = 1;
  private tableMetaCache: Map<string, TableMeta> = new Map();
  private tableTailPages: Map<string, number> = new Map();
  private indexTailPages: Map<number, number> = new Map();
  private isTransacting = false;

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
    this.tableMetaCache.delete(name.toLowerCase());
    return table;
  }

  async getTable(tableName: string): Promise<TableMeta> {
    const key = tableName.toLowerCase();
    const cached = this.tableMetaCache.get(key);
    if (cached) {
      return cached;
    }

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
    const meta = catalog_load_table_meta(page1View, pager, tableName);
    this.tableMetaCache.set(key, meta);
    return meta;
  }

  async listTables(): Promise<TableMeta[]> {
    const page1View = this.pool.getSlotDataView(0);
    const descriptors = catalog_list_table_descriptors(page1View);
    const tables: TableMeta[] = [];
    for (const desc of descriptors) {
      tables.push(await this.getTable(desc.name));
    }
    return tables;
  }

  private async freeTableTreePages(rootPageId: number): Promise<void> {
    if (rootPageId <= 1) return;

    const toFree: number[] = [];
    const visited = new Set<number>();
    const queue = [rootPageId];

    while (queue.length > 0) {
      const pId = queue.shift()!;
      if (pId <= 1 || visited.has(pId)) continue;
      visited.add(pId);

      const slot = await this.driver.acquirePage(pId);
      const view = this.pool.getSlotDataView(slot);
      const pType = page_get_type(view, 0);

      // If page is already free, unpin resident slot if any and do not traverse or re-free
      if (pType === PAGE_TYPE_FREE) {
        this.driver.forceUnpinPage(pId);
        continue;
      }

      toFree.push(pId);

      if (
        pType === PAGE_TYPE_TABLE_INTERIOR ||
        pType === PAGE_TYPE_INDEX_INTERIOR
      ) {
        const cellCount = page_get_cell_count(view, 0);
        for (let i = 0; i < cellCount; i++) {
          const off = page_get_cell_offset(view, 0, i);
          if (off > 0 && off + 4 <= PAGE_SIZE) {
            const childId = view.getUint32(off, true);
            if (childId > 1 && !visited.has(childId)) {
              queue.push(childId);
            }
          }
        }
        const rightChildId = page_get_next_page_id(view, 0);
        if (rightChildId > 1 && !visited.has(rightChildId)) {
          queue.push(rightChildId);
        }
      } else if (
        pType === PAGE_TYPE_LEAF_DATA ||
        pType === PAGE_TYPE_INDEX_LEAF
      ) {
        const nextId = page_get_next_page_id(view, 0);
        if (nextId > 1 && !visited.has(nextId)) {
          queue.push(nextId);
        }
      }
    }

    for (const pId of toFree) {
      this.driver.forceUnpinPage(pId);
      await this.driver.freePage(pId, true);
    }
  }

  async dropTable(tableName: string): Promise<void> {
    this.tableMetaCache.delete(tableName.toLowerCase());
    this.tableTailPages.delete(tableName);

    const page1View = this.pool.getSlotDataView(0);
    const slotIdx = catalog_find_table_slot(page1View, tableName);
    if (slotIdx === -1) {
      throw new TableNotFoundError(tableName);
    }

    const desc = catalog_read_table_descriptor(page1View, slotIdx)!;

    // 1. Cascade drop all indexes belonging to this table
    for (let slot = 0; slot < MAX_INDEXES_PAGE1; slot++) {
      const idx = catalog_read_index_descriptor(page1View, slot);
      if (
        idx &&
        (idx.tableId === desc.tableId ||
          idx.name.toLowerCase().startsWith(`idx_${tableName.toLowerCase()}_`) ||
          idx.name.toLowerCase() === `pk_${tableName.toLowerCase()}`)
      ) {
        if (idx.rootPageId > 1) {
          await this.freeTableTreePages(idx.rootPageId);
          this.indexTailPages.delete(idx.rootPageId);
        }
        catalog_delete_index_descriptor(page1View, slot);
      }
    }

    // 2. Free all data pages belonging to this table
    if (desc.rootPageId > 1) {
      await this.freeTableTreePages(desc.rootPageId);
    }

    // 3. Free all column catalog pages belonging to this table
    let curCatPageId = desc.colCatalogPageId;
    while (curCatPageId > 1) {
      const slot = await this.driver.acquirePage(curCatPageId);
      const view = this.pool.getSlotDataView(slot);
      const pType = page_get_type(view, 0);
      if (pType === PAGE_TYPE_FREE) {
        this.driver.forceUnpinPage(curCatPageId);
        break;
      }
      const header = catalog_read_page_header(view, 0);
      const nextId = header.nextColCatalogPageId;
      this.driver.forceUnpinPage(curCatPageId);
      await this.driver.freePage(curCatPageId, true);
      curCatPageId = nextId;
    }

    // 4. Clear table descriptor in Page 1
    catalog_delete_table_descriptor(page1View, slotIdx);
    catalog_increment_schema_version(page1View);
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);
    await this.driver.flushAllDirty();

    if (this.vmCtx.table?.name.toLowerCase() === tableName.toLowerCase()) {
      this.vmCtx.table = null;
    }
  }

  async createIndex(
    tableName: string,
    columns: string | string[],
    options?: IndexOptions,
  ): Promise<void> {
    const table = await this.getTable(tableName);
    const colNames = Array.isArray(columns) ? columns : [columns];

    if (colNames.length === 0) {
      throw new Error(
        `At least one column must be specified for createIndex on table "${tableName}"`,
      );
    }
    if (colNames.length > 8) {
      throw new Error(
        `Maximum 8 columns allowed per index (requested ${colNames.length})`,
      );
    }

    const colIndices: number[] = [];
    for (const name of colNames) {
      const idx = table.columns.findIndex((c) => c.name === name);
      if (idx === -1) {
        throw new ColumnNotFoundError(name, tableName);
      }
      colIndices.push(idx);
    }

    const indexName = options?.name ?? `idx_${tableName}_${colNames.join('_')}`;

    const page1View = this.pool.getSlotDataView(0);

    // Prevent two indices with the same name across the catalog
    const existing = catalog_find_index_by_name(page1View, indexName);
    if (existing !== null) {
      throw new IndexAlreadyExistsError(indexName);
    }

    // Prevent creating the same index twice (same columns in the same order on the same table)
    const tableIndexes = catalog_list_table_indexes(page1View, table.tableId);
    const duplicateColIndex = tableIndexes.find((idx) => {
      if (idx.columnCount !== colIndices.length) return false;
      for (let i = 0; i < idx.columnCount; i++) {
        if (idx.columnIndices[i] !== colIndices[i]) return false;
      }
      return true;
    });
    if (duplicateColIndex) {
      throw new IndexAlreadyExistsError(
        duplicateColIndex.name || indexName,
      );
    }

    const freeSlot = catalog_find_free_index_slot(page1View);
    if (freeSlot === -1) {
      throw new TooManyIndexesError(MAX_INDEXES_PAGE1, MAX_INDEXES_PAGE1);
    }

    // Allocate and initialize index root page
    const indexRootPageId = await this.driver.allocateAndPinPage();
    const indexSlot = this.pool.getResidentSlot(indexRootPageId);
    const indexView = this.pool.getSlotDataView(indexSlot);
    page_init_index_leaf(indexView, 0, 0);
    this.pool.markDirty(indexSlot);
    this.pool.unpinSlot(indexSlot);

    const isUnique = !!options?.unique;

    // Backfill: iterate all data pages and insert existing rows into new index
    let currentPageId = table.rootPageId;
    while (currentPageId !== 0) {
      const pageSlot = await this.driver.acquirePage(currentPageId);
      const pageView = this.pool.getSlotDataView(pageSlot);
      const cellCount = page_get_cell_count(pageView, 0);

      for (let i = 0; i < cellCount; i++) {
        const cellOffset = page_get_cell_offset(pageView, 0, i);
        const row = page_deserialize_row(table.columns, pageView, cellOffset);
        if (row) {
          const rowid = (BigInt(currentPageId) << 16n) | BigInt(i);
          const { keyVal, keyType } = this.extractIndexKey(
            table.columns,
            { columnCount: colIndices.length, columnIndices: colIndices },
            row,
          );

          if (keyVal !== undefined && keyVal !== null) {
            if (isUnique) {
              const duplicate = await this.probeIndexUnique(
                indexRootPageId,
                keyType,
                keyVal,
              );
              if (duplicate) {
                await this.driver.freePage(indexRootPageId);
                throw new UniqueConstraintViolationError(
                  `Duplicate key value violates unique constraint "${indexName}" on table "${tableName}"`,
                );
              }
            }

            await this.insertIntoIndex(indexRootPageId, keyType, keyVal, rowid);
          }
        }
      }

      currentPageId = page_get_next_page_id(pageView, 0);
    }

    // Write index descriptor into Page 1 catalog
    const column_indices = [0, 0, 0, 0, 0, 0, 0, 0];
    const col_directions = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < colIndices.length && k < 8; k++) {
      column_indices[k] = colIndices[k];
    }

    const flags = isUnique ? IndexFlag.UNIQUE : 0;
    catalog_write_index_descriptor(page1View, freeSlot, {
      indexId: freeSlot + 1,
      tableId: table.tableId,
      rootPageId: indexRootPageId,
      columnCount: colIndices.length,
      flags,
      columnIndices: column_indices,
      colDirections: col_directions,
      name: indexName,
    });

    catalog_increment_schema_version(page1View);
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);
    this.tableMetaCache.delete(tableName.toLowerCase());
    this.indexTailPages.delete(indexRootPageId);
    await this.driver.flushAllDirty();
  }

  async dropIndex(indexName: string): Promise<void> {
    const page1View = this.pool.getSlotDataView(0);
    const found = catalog_find_index_by_name(page1View, indexName);
    if (!found) {
      throw new IndexNotFoundError(indexName);
    }

    // Free all pages in the index tree
    if (found.desc.rootPageId > 1) {
      await this.freeTableTreePages(found.desc.rootPageId);
      this.indexTailPages.delete(found.desc.rootPageId);
    }

    catalog_delete_index_descriptor(page1View, found.slotIdx);
    catalog_increment_schema_version(page1View);
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);
    this.tableMetaCache.clear();
    this.indexTailPages.clear();
    await this.driver.flushAllDirty();
  }

  async listIndexes(tableName?: string): Promise<IndexDescriptor[]> {
    const page1View = this.pool.getSlotDataView(0);
    if (tableName) {
      const table = await this.getTable(tableName);
      return catalog_list_table_indexes(page1View, table.tableId);
    }
    const allIndexes: IndexDescriptor[] = [];
    for (let i = 0; i < MAX_INDEXES_PAGE1; i++) {
      const desc = catalog_read_index_descriptor(page1View, i);
      if (desc) {
        allIndexes.push(desc);
      }
    }
    return allIndexes;
  }

  private extractIndexKey(
    columns: ColumnMeta[],
    idx: { columnCount: number; columnIndices: number[] },
    row: DbRow,
  ): { keyVal: any; keyType: DataType } {
    if (idx.columnCount === 1) {
      const col = columns[idx.columnIndices[0]];
      return { keyVal: row[col.name], keyType: col.type };
    }
    return {
      keyVal: serialize_composite_key(
        columns,
        idx.columnIndices,
        idx.columnCount,
        row,
      ),
      keyType: DataType.BLOB,
    };
  }

  private async probeIndexUnique(
    rootPageId: number,
    keyType: DataType,
    keyVal: any,
  ): Promise<boolean> {
    let currIdxPageId = rootPageId;
    while (currIdxPageId !== 0) {
      const slot = await this.driver.acquirePage(currIdxPageId);
      const view = this.pool.getSlotDataView(slot);
      const cellCount = page_get_cell_count(view, 0);
      if (cellCount > 0) {
        const search = page_binary_search_index_leaf(
          view,
          0,
          keyType,
          keyVal,
        );
        if (search.found) {
          return true;
        }
      }
      currIdxPageId = page_get_next_page_id(view, 0);
    }
    return false;
  }

  private async insertIntoIndex(
    rootPageId: number,
    keyType: DataType,
    keyVal: any,
    rowid: bigint,
  ): Promise<void> {
    let idxPageId = this.indexTailPages.get(rootPageId) ?? rootPageId;
    let idxSlot = await this.driver.acquirePage(idxPageId);
    let idxView = this.pool.getSlotDataView(idxSlot);

    while (true) {
      const nextIdxPageId = page_get_next_page_id(idxView, 0);
      if (nextIdxPageId === 0) break;
      idxPageId = nextIdxPageId;
      idxSlot = await this.driver.acquirePage(idxPageId);
      idxView = this.pool.getSlotDataView(idxSlot);
    }
    this.indexTailPages.set(rootPageId, idxPageId);

    let idxInsertRes = page_insert_index_leaf_cell(
      idxView,
      0,
      keyType,
      keyVal,
      rowid,
      this.pool.pageScratchpadOffset,
    );

    if (idxInsertRes === -1) {
      this.pool.pinSlot(idxSlot);
      try {
        const newIdxPageId = await this.driver.allocateAndPinPage();
        const newIdxSlot = this.pool.getResidentSlot(newIdxPageId);
        try {
          page_set_next_page_id(idxView, 0, newIdxPageId);
          this.pool.markDirty(idxSlot);

          const newIdxView = this.pool.getSlotDataView(newIdxSlot);
          page_init_index_leaf(newIdxView, 0, 0);
          idxInsertRes = page_insert_index_leaf_cell(
            newIdxView,
            0,
            keyType,
            keyVal,
            rowid,
            this.pool.pageScratchpadOffset,
          );
          if (idxInsertRes === -1) {
            throw new Error(
              "Unexpected error: index entry does not fit in empty page",
            );
          }
          this.pool.markDirty(newIdxSlot);
          this.indexTailPages.set(rootPageId, newIdxPageId);
        } finally {
          this.pool.unpinSlot(newIdxSlot);
        }
      } finally {
        this.pool.unpinSlot(idxSlot);
      }
    } else {
      this.pool.markDirty(idxSlot);
    }
  }

  async insert(tableName: string, row: DbRow): Promise<void> {
    await this.insertMany(tableName, [row]);
  }

  async insertMany(tableName: string, rows: DbRow[]): Promise<void> {
    if (!rows || rows.length === 0) return;
    const table = await this.getTable(tableName);
    const page1View = this.pool.getSlotDataView(0);
    const indexes = catalog_list_table_indexes(page1View, table.tableId);
    const uniqueIndexes = indexes.filter(
      (idx) => (idx.flags & (IndexFlag.UNIQUE | IndexFlag.PRIMARY)) !== 0,
    );

    const autoIncCol = table.columns.find(
      (c) => (c.flags & ColumnFlag.AUTO_INC) !== 0,
    );

    // Fast resolution of tail data page
    let currentPageId = this.tableTailPages.get(tableName) ?? table.rootPageId;
    let slot = await this.driver.acquirePage(currentPageId);
    let view = this.pool.getSlotDataView(slot);

    while (true) {
      const nextPageId = page_get_next_page_id(view, 0);
      if (nextPageId === 0) break;
      currentPageId = nextPageId;
      slot = await this.driver.acquirePage(currentPageId);
      view = this.pool.getSlotDataView(slot);
    }
    this.tableTailPages.set(tableName, currentPageId);

    // Batch duplicate tracking
    const batchUniqueSets: Map<string, Set<any>> = new Map();
    for (const idx of uniqueIndexes) {
      batchUniqueSets.set(idx.name, new Set());
    }

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];

      // 1. Primary Key NOT NULL validation
      for (const c of table.columns) {
        if ((c.flags & ColumnFlag.PRIMARY_KEY) !== 0) {
          if ((c.flags & ColumnFlag.AUTO_INC) === 0) {
            if (row[c.name] === undefined || row[c.name] === null) {
              throw new NotNullConstraintError(c.name, tableName);
            }
          }
        }
      }

      // 2. Auto-Inc
      if (
        autoIncCol &&
        (row[autoIncCol.name] === undefined || row[autoIncCol.name] === null)
      ) {
        row[autoIncCol.name] = Number(table.autoIncNext);
        table.autoIncNext += 1n;
      }

      // 3. Uniqueness constraint probe
      for (const idx of uniqueIndexes) {
        const { keyVal, keyType } = this.extractIndexKey(table.columns, idx, row);
        if (keyVal !== undefined && keyVal !== null) {
          const set = batchUniqueSets.get(idx.name)!;
          if (set.has(keyVal)) {
            throw new UniqueConstraintViolationError(
              `Duplicate key value violates unique constraint "${idx.name}" on table "${tableName}"`,
            );
          }
          set.add(keyVal);

          const duplicate = await this.probeIndexUnique(
            idx.rootPageId,
            keyType,
            keyVal,
          );
          if (duplicate) {
            throw new UniqueConstraintViolationError(
              `Duplicate key value violates unique constraint "${idx.name}" on table "${tableName}"`,
            );
          }
        }
      }

      // 4. Data page insertion
      const rowBytes = page_serialize_row(table.columns, row);
      let targetPageId = currentPageId;
      let insertSlot = page_insert_row(
        view,
        0,
        rowBytes,
        this.pool.pageScratchpadOffset,
      );

      if (insertSlot === -1) {
        this.pool.pinSlot(slot);
        try {
          const newPageId = await this.driver.allocateAndPinPage();
          const newSlot = this.pool.getResidentSlot(newPageId);
          try {
            page_set_next_page_id(view, 0, newPageId);
            this.pool.markDirty(slot);

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
            currentPageId = newPageId;
            targetPageId = newPageId;
            slot = newSlot;
            view = newView;
            this.tableTailPages.set(tableName, newPageId);
          } finally {
            this.pool.unpinSlot(newSlot);
          }
        } finally {
          this.pool.unpinSlot(slot);
        }
      } else {
        this.pool.markDirty(slot);
      }

      // 5. Index insertion
      const rowid = (BigInt(targetPageId) << 16n) | BigInt(insertSlot);
      for (const idx of indexes) {
        const { keyVal, keyType } = this.extractIndexKey(table.columns, idx, row);
        if (keyVal !== undefined && keyVal !== null) {
          await this.insertIntoIndex(idx.rootPageId, keyType, keyVal, rowid);
        }
      }
    }

    // 6. Update Page 1 table descriptor once for the batch
    const slotIdx = catalog_find_table_slot(page1View, tableName);
    if (slotIdx !== -1) {
      const desc = catalog_read_table_descriptor(page1View, slotIdx)!;
      desc.rowCountEstimate += rows.length;
      if (autoIncCol) {
        desc.autoIncNext = table.autoIncNext;
      }
      catalog_write_table_descriptor(page1View, slotIdx, desc);
      this.pool.markDirty(0);
    }

    // 7. Flush once for the whole batch
    if (!this.isTransacting) {
      await this.driver.flushAllDirty();
    }
  }

  async transaction<T>(callback: (tx: WebDB) => Promise<T>): Promise<T> {
    const pool = this.pool;
    const vfsSnap =
      this.vfs instanceof MemoryVfsAdapter ? this.vfs.snapshot() : null;

    const slotSnapshots = new Map<
      number,
      { pageId: number; dirty: boolean; data: Uint8Array }
    >();

    for (let slot = 0; slot < pool.slotCount; slot++) {
      const pageId = pool.getAssignedPage(slot);
      if (pageId > 0) {
        const dirty = pool.isDirty(slot);
        const data = new Uint8Array(pool.getPageBytesInSlot(slot));
        slotSnapshots.set(slot, { pageId, dirty, data });
      }
    }

    const prevTransacting = this.isTransacting;
    this.isTransacting = true;

    try {
      const res = await callback(this);
      if (!prevTransacting) {
        await this.driver.flushAllDirty();
      }
      return res;
    } catch (err) {
      // Clear caches so rollback doesn't leave stale cached table pointers
      this.tableMetaCache.clear();
      this.tableTailPages.clear();
      this.indexTailPages.clear();

      // Rollback: restore all buffer pool slots and page data
      for (let slot = 0; slot < pool.slotCount; slot++) {
        const snap = slotSnapshots.get(slot);
        if (snap) {
          pool.assignSlot(slot, snap.pageId);
          pool.getPageBytesInSlot(slot).set(snap.data);
          if (snap.dirty) {
            pool.markDirty(slot);
          } else {
            pool.clearDirty(slot);
          }
        } else {
          pool.unassignSlot(slot);
        }
      }

      if (vfsSnap && this.vfs instanceof MemoryVfsAdapter) {
        this.vfs.restoreSnapshot(vfsSnap);
      }

      throw err;
    } finally {
      this.isTransacting = prevTransacting;
    }
  }

  registerFunction(
    name: string,
    def: UdfDefinition | ((...args: any[]) => any),
  ): this {
    const normName = name.toLowerCase();
    const fnDef: UdfDefinition =
      typeof def === "function" ? { call: def } : { ...def };

    if (!fnDef.returnType) {
      try {
        const sample = fnDef.call(1, 1, 1, 1, 1);
        if (typeof sample === "number") {
          fnDef.returnType = Number.isInteger(sample)
            ? DataType.INT32
            : DataType.FLOAT64;
        } else if (typeof sample === "string") {
          fnDef.returnType = DataType.TEXT;
        }
      } catch {
        try {
          const sample = fnDef.call("", "", "", "", "");
          if (typeof sample === "number") {
            fnDef.returnType = Number.isInteger(sample)
              ? DataType.INT32
              : DataType.FLOAT64;
          } else if (typeof sample === "string") {
            fnDef.returnType = DataType.TEXT;
          }
        } catch {
          // Fall back if probing fails
        }
      }
    }

    let entry = this.udfs.get(normName);
    if (!entry) {
      entry = { id: this.nextUdfId++, def: fnDef };
      this.udfs.set(normName, entry);
    } else {
      entry.def = fnDef;
    }
    return this;
  }

  getUdf(name: string): { id: number; def: UdfDefinition } | undefined {
    return this.udfs.get(name.toLowerCase());
  }

  getUdfMap(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [name, entry] of this.udfs.entries()) {
      map.set(name, entry.id);
    }
    return map;
  }

  getUdfDefs(): Map<string, UdfDefinition> {
    const map = new Map<string, UdfDefinition>();
    for (const [name, entry] of this.udfs.entries()) {
      map.set(name, entry.def);
    }
    return map;
  }

  from(tableName: string): QueryBuilder {
    return new QueryBuilder(this, tableName);
  }

  async explainQuery(
    tableName: string,
    filters: QueryFilter[],
    options?: {
      orderBy?: SortKey[];
      groupBy?: (string | GroupKey)[];
      aggregates?: AggExpr[];
      having?: QueryFilter[];
      select?: any;
      selectExprs?: ParsedSelectExpr[];
      joins?: JoinClause[];
      limit?: number;
      offset?: number;
    },
  ): Promise<ExplainOutput> {
    const table = await this.getTable(tableName);

    const joinPlans: JoinPlan[] = [];
    if (options?.joins && options.joins.length > 0) {
      if (1 + options.joins.length > 16) {
        throw new TooManyCursorsError(1 + options.joins.length, 16);
      }
      for (let i = 0; i < options.joins.length; i++) {
        const j = options.joins[i];
        const joinedTable = await this.getTable(j.table);
        joinPlans.push({
          type: j.type,
          table: joinedTable,
          cursor: i + 1,
          leftCol: j.leftCol,
          op: j.op,
          rightCol: j.rightCol,
        });
      }
    }

    const bytecode = compileQuery({
      table,
      joinedTables: joinPlans.length > 0 ? joinPlans : undefined,
      filters,
      orderBy: options?.orderBy,
      groupBy: options?.groupBy,
      aggregates: options?.aggregates,
      having: options?.having,
      selectExprs: options?.selectExprs,
      udfNameMap: this.getUdfMap(),
      udfDefs: this.getUdfDefs(),
      limit: options?.limit,
      offset: options?.offset,
    });
    const instructions = disassembleBytecode(bytecode, table);
    const assembly = formatDisassembly(instructions);
    const indexScan = (bytecode as any).indexScan;
    const scanType = indexScan ? "IndexScan" : "TableScan";
    const indexName = indexScan ? indexScan.index.name : undefined;
    const joinedTableScans = (bytecode as any).joinedTableScans as
      | {
          tableIndex: number;
          tableName: string;
          scanType: "IndexScan" | "TableScan";
          indexName?: string;
        }[]
      | undefined;

    const decoratedJoins = options?.joins?.map((j, idx) => {
      const scanInfo = joinedTableScans?.[idx];
      if (scanInfo && scanInfo.scanType === "IndexScan") {
        return {
          ...j,
          scanType: scanInfo.scanType,
          indexName: scanInfo.indexName,
        };
      }
      return j;
    });

    return {
      plan: {
        table: table.name,
        rootPageId: table.rootPageId,
        scanType,
        indexName,
        filters,
        orderBy: options?.orderBy,
        groupBy: options?.groupBy,
        aggregates: options?.aggregates,
        having: options?.having,
        select: options?.select,
        joins: decoratedJoins,
        limit: options?.limit,
        offset: options?.offset,
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

    const joinedTablesMeta: TableMeta[] = [];
    const joinPlans: JoinPlan[] = [];
    if (options.joins && options.joins.length > 0) {
      if (1 + options.joins.length > 16) {
        throw new TooManyCursorsError(1 + options.joins.length, 16);
      }
      for (let i = 0; i < options.joins.length; i++) {
        const j = options.joins[i];
        const joinedTable = await this.getTable(j.table);
        joinedTablesMeta.push(joinedTable);
        joinPlans.push({
          type: j.type,
          table: joinedTable,
          cursor: i + 1,
          leftCol: j.leftCol,
          op: j.op,
          rightCol: j.rightCol,
        });
      }
    }

    // Pre-load all data pages and index pages for all tables into buffer pool before running VM
    for (const t of [table, ...joinedTablesMeta]) {
      let currPageId = t.rootPageId;
      while (currPageId !== 0) {
        const slot = await this.driver.acquirePage(currPageId);
        const view = this.pool.getSlotDataView(slot);
        currPageId = page_get_next_page_id(view, 0);
      }
      for (const idx of t.indexes ?? []) {
        let idxPageId = idx.rootPageId;
        while (idxPageId !== 0) {
          const slot = await this.driver.acquirePage(idxPageId);
          const view = this.pool.getSlotDataView(slot);
          idxPageId = page_get_next_page_id(view, 0);
        }
      }
    }

    let orderBy = options.orderBy;
    if (!orderBy && options.sortCol) {
      orderBy = [{ colName: options.sortCol, direction: options.sortDir }];
    }

    const plan: QueryPlan = {
      table,
      joinedTables: joinPlans.length > 0 ? joinPlans : undefined,
      filters,
      orderBy,
      groupBy: options.groupBy,
      aggregates: options.aggregates,
      having: options.having,
      selectExprs: options.selectExprs,
      udfNameMap: this.getUdfMap(),
      udfDefs: this.getUdfDefs(),
      limit: options.limit !== null ? options.limit : undefined,
      offset: options.offset !== null ? options.offset : undefined,
    };

    const bytecode = compileQuery(plan);

    resetVmContext(this.vmCtx, table, [table, ...joinedTablesMeta]);
    if ((bytecode as any).inSets) {
      this.vmCtx.inSets = (bytecode as any).inSets;
    }
    if (plan.keyInfos) {
      this.vmCtx.keyInfos = plan.keyInfos;
    }

    const udfsRecord: Record<number, (...args: any[]) => any> = {};
    for (const entry of this.udfs.values()) {
      udfsRecord[entry.id] = entry.def.call;
    }
    this.vmCtx.udfs = udfsRecord;

    // Determine output columns for page_deserialize_row
    let outputColumns =
      (bytecode as any).outputColumns ?? plan.outputColumns ?? table.columns;
    if (
      (plan.aggregates && plan.aggregates.length > 0) ||
      (plan.groupBy && plan.groupBy.length > 0)
    ) {
      if ((bytecode as any).outputColumns) {
        outputColumns = (bytecode as any).outputColumns;
      } else {
        outputColumns = [];
        const groupByCols = plan.groupBy ?? [];
        for (const gItem of groupByCols) {
          const gColName =
            typeof gItem === 'string'
              ? gItem
              : (gItem.colName ?? (gItem.expr ? deriveDefaultAlias(gItem.expr) : 'group_key'));
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
        for (let j = 0; j < (plan.aggregates?.length ?? 0); j++) {
          const agg = plan.aggregates![j];
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
    }

    this.vmCtx.outputColumns = outputColumns;

    const rows: DbRow[] = [];
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

    return rows;
  }

  async close(): Promise<void> {
    await this.driver.flushAllDirty();
    await this.vfs.close();
  }
}
