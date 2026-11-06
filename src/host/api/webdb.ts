import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  DEFAULT_SLOT_COUNT,
  DEFAULT_MAX_QUERY_MEMORY,
  MAX_INDEXES_PAGE1,
  MAX_TABLES_PAGE1,
  MAX_COLUMNS_PER_CATALOG_PAGE,
  MAX_COLUMNS_PER_TABLE,
  MAX_NAME_LENGTH,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_LEAF_DATA,
  HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
} from "../../constants.ts";
import {
  ColumnDefinition,
  ColumnMeta,
  TableMeta,
  DbRow,
  DbValue,
  TableNotFoundError,
  TableAlreadyExistsError,
  ColumnFlag,
  DataType,
  VmStatus,
  QueryTimeoutError,
  InvalidBytecodeError,
  QueryArenaExhaustedError,
  TooManyCursorsError,
  TooManyColumnsError,
  TooManyTablesError,
  UniqueConstraintViolationError,
  NotNullConstraintError,
  IndexFlag,
  IndexOptions,
  AlterTableOperation,
  IdentifierTooLongError,
  ColumnAlreadyExistsError,
  CannotDropColumnError,
  ColumnNotFoundError,
  IndexNotFoundError,
  IndexAlreadyExistsError,
  TooManyIndexesError,
  IndexDescriptor,
  InvalidDatabaseError,
  CorruptPageError,
  TransactionOptions,
  UpsertOptions,
  MutationRecord,
  Changeset,
  TableChangeEvent,
  SyncState,
  BeforeCommitHook,
  CommitHook,
  TableSubscriptionCallback,
} from "../../types/index.ts";
import { IVfsAdapter } from "../storage/vfs.ts";
import { MemoryVfsAdapter } from "../storage/memory.ts";
import { IndexedDbVfsAdapter } from "../storage/idb.ts";
import { OpfsVfsAdapter } from "../storage/opfs.ts";
import { Io } from "../storage/io.ts";
import { computePageChecksum } from "../storage/crc32.ts";
import {
  BufferPoolDriver,
  createWasmMemory,
  TransactionCoordinator,
  recoverFromWal,
} from "../driver/index.js";
import {
  catalog_init_page1,
  catalog_read_page1_header,
  catalog_get_total_pages,
  catalog_create_table,
  catalog_load_table_meta,
  catalog_find_table_slot,
  catalog_find_free_table_slot,
  catalog_read_table_descriptor,
  catalog_write_table_descriptor,
  catalog_list_table_descriptors,
  catalog_read_page_header,
  catalog_write_column_meta,
  catalog_map_column_location,
  catalog_list_table_indexes,
  catalog_list_all_indexes,
  catalog_get_index_slot_capacity,
  catalog_append_index_overflow_page,
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
  page_delete_row,
  page_update_row,
  page_get_next_page_id,
  page_set_next_page_id,
  page_serialize_row,
  page_deserialize_row,
  page_init_index_leaf,
  page_insert_index_leaf_cell,
  page_delete_index_leaf_cell,
  page_binary_search_index_leaf,
  serialize_composite_key,
  sql_like_match,
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
import {
  ParsedSelectExpr,
  deriveDefaultAlias,
  evalExprNode,
} from "../compiler/expr_parser.ts";
import { QueryPlanner } from "../compiler/planner/index.ts";
import {
  QueryBuilder,
  type ExplainOutput,
  type IDatabaseQueryExecutor,
  type QueryExecutionOptions,
  type JoinClause,
} from "./query_builder.ts";
import {
  liveQuery,
  notifyLiveQueryTableRead,
  getActiveLiveQueryTracker,
  trackLiveQueryPromise,
  type LiveQueryController,
  type LiveQueryOptions,
  type LiveQueryState,
  type LiveQueryFn,
} from "./live_query.ts";

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

import { createWasmCore, type WasmCoreExports } from "../../core/index.ts";

export interface WebDbOptions {
  name: string;
  storage?: "memory" | "idb" | "opfs";
  vfs?: IVfsAdapter;
  slotCount?: number;
  maxQueryMemory?: number;
  core?: "js" | "wasm";
  wasmBinary?: ArrayBuffer | Uint8Array;
  planner?: QueryPlanner;
  initialData?: Uint8Array | ArrayBuffer;
}

export class WebDB implements IDatabaseQueryExecutor {
  readonly vfs: IVfsAdapter;
  readonly io: Io;
  readonly driver: BufferPoolDriver;
  readonly coreMode: "js" | "wasm";
  readonly wasmCore?: WasmCoreExports;
  private planner?: QueryPlanner;

  /**
   * Alias to driver for callers/tests that inspect the buffer pool.
   */
  get pool(): BufferPoolDriver {
    return this.driver;
  }

  readonly coordinator: TransactionCoordinator;
  currentLeaseId: number | null = null;
  private vmCtx: VmContext;
  private udfs: Map<string, { id: number; def: UdfDefinition }> = new Map();
  private nextUdfId = 1;
  private tableMetaCache: Map<string, TableMeta> = new Map();
  private tableTailPages: Map<string, number> = new Map();
  private indexTailPages: Map<number, number> = new Map();

  // Sync & Reactive state
  private beforeCommitHooks: Set<BeforeCommitHook> = new Set();
  private commitHooks: Set<CommitHook> = new Set();
  private subscriptions: Set<{
    tables: Set<string> | "*";
    callback: TableSubscriptionCallback;
  }> = new Set();
  private activeTxChanges: MutationRecord[] = [];
  private activeTxOrigin: string = "local";
  private activeTxMeta?: Record<string, any>;
  private activeTxId: number = 0;
  private nextAutoTxId: number = 1_000_000;
  private isRunningBeforeCommit: boolean = false;
  private broadcastChannel: BroadcastChannel | null = null;
  private readonly instanceId: string =
    Math.random().toString(36).slice(2) + Date.now().toString(36);

  private constructor(
    vfs: IVfsAdapter,
    io: Io,
    driver: BufferPoolDriver,
    coordinator: TransactionCoordinator,
    coreMode: "js" | "wasm" = "js",
    wasmCore?: WasmCoreExports,
    planner?: QueryPlanner,
    dbName?: string,
  ) {
    this.vfs = vfs;
    this.io = io;
    this.driver = driver;
    this.coordinator = coordinator;
    this.coreMode = coreMode;
    this.wasmCore = wasmCore;
    this.planner = planner;
    this.vmCtx = createVmContext();
    this.vmCtx._fastHostMode = true;

    this.coordinator.setOnCrossTabInvalidated(async () => {
      this.tableMetaCache.clear();
      this.tableTailPages.clear();
      this.indexTailPages.clear();

      await WebDB.pinAllCatalogPages(this.driver);
    });

    if (typeof BroadcastChannel !== "undefined" && dbName) {
      const channelName = `webdb_sync_${vfs.name}_${dbName}`;
      this.broadcastChannel = new BroadcastChannel(channelName);
      this.broadcastChannel.onmessage = (ev: MessageEvent) => {
        const data = ev.data;
        if (!data || data.senderId === this.instanceId) return;
        const { tables, origin, meta, changeCounter, schemaVersion } = data;
        this.coordinator.leaseQueue
          .enqueue(async () => {
            await this.coordinator.syncCrossTabState(true);
            this.notifySubscriptions({
              tables: Array.isArray(tables) ? tables : [],
              origin: origin ?? "remote",
              meta,
              changeCounter:
                typeof changeCounter === "number"
                  ? changeCounter
                  : this.getSyncState().changeCounter,
              schemaVersion:
                typeof schemaVersion === "number"
                  ? schemaVersion
                  : this.getSyncState().schemaVersion,
              crossTab: true,
            });
          })
          .catch(() => {});
      };
    }
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
    const memory = createWasmMemory(
      Math.max(slotCount, DEFAULT_SLOT_COUNT),
      maxQueryMemory,
    );
    const procEnv = (globalThis as any).process?.env?.WEBDB_CORE;
    const envCore: "js" | "wasm" | undefined =
      procEnv === "wasm" || procEnv === "js"
        ? procEnv
        : (globalThis as any).__WEBDB_DEFAULT_CORE__;
    const coreMode = options.core ?? envCore ?? "js";
    let wasmCore: WasmCoreExports | undefined;
    if (coreMode === "wasm") {
      wasmCore = createWasmCore(
        memory,
        options.wasmBinary ? new Uint8Array(options.wasmBinary) : undefined,
      );
    }

    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount,
      maxQueryMemory,
      useDefaultLayoutOffsets: true,
    });

    const crossTabLockName =
      options.name && vfs.name !== "memory"
        ? `webdb_lock_${vfs.name}_${options.name}`
        : undefined;

    const coordinator = new TransactionCoordinator(
      vfs,
      driver,
      io,
      crossTabLockName,
    );

    driver.setTransactionCoordinator(coordinator);

    await coordinator.leaseQueue.enqueue(async () => {
      // Section 6: Crash Recovery Protocol & Startup WAL Replay
      await recoverFromWal(vfs);

      // Check if Page 1 exists in storage
      const [page1Data] = await vfs.readPages([1]);
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

        // Section 6.2: Pre-load and permanently pin all overflow & column catalog pages for active tables
        await WebDB.pinAllCatalogPages(driver);
      }
      coordinator.recordDiskPage1State();
    });

    const dbInstance = new WebDB(
      vfs,
      io,
      driver,
      coordinator,
      coreMode,
      wasmCore,
      options.planner,
      options.name,
    );

    if (options.initialData) {
      await dbInstance.importBinary(options.initialData);
    }

    return dbInstance;
  }

  private static async pinAllCatalogPages(
    driver: BufferPoolDriver,
  ): Promise<void> {
    const page1View = driver.getSlotDataView(0);

    // 1. Pin chained table descriptor overflow catalog pages
    let tableCatPageId = page1View.getUint32(
      HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
      true,
    );
    while (tableCatPageId !== 0) {
      const slot = await driver.acquireAndPinPage(tableCatPageId);
      const view = driver.getSlotDataView(slot);
      const header = catalog_read_page_header(view, 0);
      tableCatPageId = header.nextColCatalogPageId;
    }

    // 2. Pin chained index descriptor overflow catalog pages
    let idxCatPageId = page1View.getUint32(
      HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
      true,
    );
    while (idxCatPageId !== 0) {
      const slot = await driver.acquireAndPinPage(idxCatPageId);
      const view = driver.getSlotDataView(slot);
      const header = catalog_read_page_header(view, 0);
      idxCatPageId = header.nextColCatalogPageId;
    }

    // 3. Pin column catalog pages for all active tables
    const tableDescriptors = catalog_list_table_descriptors(page1View);
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

  getPlanner(): QueryPlanner | undefined {
    return this.planner;
  }

  setPlanner(planner?: QueryPlanner): this {
    this.planner = planner;
    return this;
  }

  private validateIdentifier(
    identifier: string,
    label: string = "Identifier",
  ): void {
    if (
      !identifier ||
      typeof identifier !== "string" ||
      identifier.length === 0
    ) {
      throw new Error(`${label} cannot be empty`);
    }
    if (identifier.length > MAX_NAME_LENGTH) {
      throw new IdentifierTooLongError(identifier, MAX_NAME_LENGTH);
    }
  }

  async createTable(
    name: string,
    columns: ColumnDefinition[],
  ): Promise<TableMeta> {
    return this.coordinator.leaseQueue.enqueue(
      () => this._createTableInternal(name, columns),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _createTableInternal(
    name: string,
    columns: ColumnDefinition[],
  ): Promise<TableMeta> {
    this.validateIdentifier(name, "Table name");
    if (columns.length === 0) {
      throw new Error("Table must have at least one column");
    }
    if (columns.length > MAX_COLUMNS_PER_TABLE) {
      throw new TooManyColumnsError(columns.length, MAX_COLUMNS_PER_TABLE);
    }

    const seenColNames = new Set<string>();
    let hasPk = false;
    for (const col of columns) {
      this.validateIdentifier(col.name, "Column name");
      if (seenColNames.has(col.name)) {
        throw new ColumnAlreadyExistsError(col.name, name);
      }
      seenColNames.add(col.name);
      const flagsNum =
        typeof (col as any).flags === "number" ? (col as any).flags : 0;
      if (
        col.primaryKey ||
        col.flags?.primaryKey ||
        (flagsNum & ColumnFlag.PRIMARY_KEY) !== 0
      ) {
        hasPk = true;
      }
    }

    const page1View = this.pool.getSlotDataView(0);
    if (catalog_find_table_slot(page1View, name) !== -1) {
      throw new TableAlreadyExistsError(name);
    }

    const needsTableOverflowPage =
      catalog_find_free_table_slot(page1View) === -1 ? 1 : 0;
    const numCatPages = Math.ceil(
      columns.length / MAX_COLUMNS_PER_CATALOG_PAGE,
    );
    const needsPkIndexPage = hasPk ? 1 : 0;
    const totalPagesToAllocate =
      1 + numCatPages + needsPkIndexPage + needsTableOverflowPage;

    const preAllocatedPages: number[] = [];
    for (let i = 0; i < totalPagesToAllocate; i++) {
      preAllocatedPages.push(await this.driver.allocateAndPinPage());
    }

    let allocCursor = 0;
    // Dynamic pager provider for table creation backed by pre-allocated pinned buffer pool slots
    const pager: IPageProvider = {
      allocateNewPage: () => {
        if (allocCursor < preAllocatedPages.length) {
          return preAllocatedPages[allocCursor++];
        }
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

    let table: TableMeta;
    try {
      table = catalog_create_table(page1View, pager, name, columns);
    } catch (err) {
      for (const pId of preAllocatedPages) {
        this.driver.forceUnpinPage(pId);
        await this.driver.freePage(pId, true);
      }
      throw err;
    }

    // Unpin data root page and PK index root page (column catalog pages stay permanently pinned)
    this.driver.unpinPage(table.rootPageId);
    for (const idx of table.indexes ?? []) {
      if (idx.rootPageId > 1) {
        this.driver.unpinPage(idx.rootPageId);
      }
    }

    // Ensure column catalog pages for this new table remain permanently pinned
    let catPageId = table.colCatalogPageId;
    while (catPageId !== 0) {
      const slot = await this.driver.acquirePage(catPageId);
      if (!this.pool.isSlotPinned(slot)) {
        this.pool.pinSlot(slot);
      }
      const header = catalog_read_page_header(
        this.pool.getSlotDataView(slot),
        0,
      );
      catPageId = header.nextColCatalogPageId;
    }

    // Flush modified pages if autocommit (not in transaction)
    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }
    this.tableMetaCache.delete(name.toLowerCase());
    return table;
  }

  getTable(tableName: string): Promise<TableMeta> {
    const callerTracker = getActiveLiveQueryTracker();
    notifyLiveQueryTableRead(this, tableName);
    const promise = this.coordinator.leaseQueue.enqueue(
      () => this._getTableInternal(tableName),
      this.currentLeaseId ?? undefined,
    );
    return trackLiveQueryPromise(promise, callerTracker);
  }

  private async _getTableInternal(tableName: string): Promise<TableMeta> {
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

  listTables(): Promise<TableMeta[]> {
    const callerTracker = getActiveLiveQueryTracker();
    notifyLiveQueryTableRead(this, "*");
    const promise = this.coordinator.leaseQueue.enqueue(async () => {
      const page1View = this.pool.getSlotDataView(0);
      const descriptors = catalog_list_table_descriptors(page1View);
      const tables: TableMeta[] = [];

      for (const desc of descriptors) {
        tables.push(await this._getTableInternal(desc.name));
      }

      return tables;
    }, this.currentLeaseId ?? undefined);
    return trackLiveQueryPromise(promise, callerTracker);
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
    return this.coordinator.leaseQueue.enqueue(
      () => this._dropTableInternal(tableName),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _dropTableInternal(tableName: string): Promise<void> {
    this.tableMetaCache.delete(tableName.toLowerCase());
    this.tableTailPages.delete(tableName);

    const page1View = this.pool.getSlotDataView(0);
    const slotIdx = catalog_find_table_slot(page1View, tableName);
    if (slotIdx === -1) {
      throw new TableNotFoundError(tableName);
    }

    const desc = catalog_read_table_descriptor(page1View, slotIdx)!;

    // 1a. Free embedded primary key index tree if present
    if (desc.pkRootPageId && desc.pkRootPageId > 1) {
      await this.freeTableTreePages(desc.pkRootPageId);
      this.indexTailPages.delete(desc.pkRootPageId);
    }

    // 1b. Cascade drop all secondary indexes belonging to this table (across Page 1 & overflow pages)
    const totalIdxSlots = catalog_get_index_slot_capacity(page1View);
    for (let slot = 0; slot < totalIdxSlots; slot++) {
      const idx = catalog_read_index_descriptor(page1View, slot);
      if (
        idx &&
        (idx.tableId === desc.tableId ||
          idx.name
            .toLowerCase()
            .startsWith(`idx_${tableName.toLowerCase()}_`) ||
          idx.name.toLowerCase() === `pk_${tableName.toLowerCase()}`)
      ) {
        if (idx.rootPageId > 1 && idx.rootPageId !== desc.pkRootPageId) {
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
    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    if (this.vmCtx.table?.name.toLowerCase() === tableName.toLowerCase()) {
      this.vmCtx.table = null;
    }
  }

  async renameTable(oldName: string, newName: string): Promise<TableMeta> {
    return this.coordinator.leaseQueue.enqueue(
      () => this._renameTableInternal(oldName, newName),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _renameTableInternal(
    oldName: string,
    newName: string,
  ): Promise<TableMeta> {
    this.validateIdentifier(newName, "Table name");
    const page1View = this.pool.getSlotDataView(0);
    const slotIdx = catalog_find_table_slot(page1View, oldName);
    if (slotIdx === -1) {
      throw new TableNotFoundError(oldName);
    }

    if (oldName === newName) {
      return this._getTableInternal(newName);
    }

    if (catalog_find_table_slot(page1View, newName) !== -1) {
      throw new TableAlreadyExistsError(newName);
    }

    const desc = catalog_read_table_descriptor(page1View, slotIdx)!;
    desc.name = newName;
    catalog_write_table_descriptor(page1View, slotIdx, desc);

    // Update auto-generated PK and secondary index names belonging to this table
    const oldPkName = `pk_${oldName}`;
    const oldIdxPrefix = `idx_${oldName}_`;
    const totalIdxSlots = catalog_get_index_slot_capacity(page1View);
    for (let i = 0; i < totalIdxSlots; i++) {
      const idx = catalog_read_index_descriptor(page1View, i);
      if (idx && idx.tableId === desc.tableId) {
        let updatedName: string | null = null;
        if (idx.name === oldPkName) {
          updatedName = `pk_${newName}`;
        } else if (idx.name.startsWith(oldIdxPrefix)) {
          updatedName = `idx_${newName}_${idx.name.slice(oldIdxPrefix.length)}`;
        }
        if (
          updatedName &&
          updatedName.length <= MAX_NAME_LENGTH &&
          !catalog_find_index_by_name(page1View, updatedName)
        ) {
          idx.name = updatedName;
          catalog_write_index_descriptor(page1View, i, idx);
        }
      }
    }

    catalog_increment_schema_version(page1View);
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);

    this.tableMetaCache.delete(oldName.toLowerCase());
    this.tableMetaCache.delete(newName.toLowerCase());
    const tailPage = this.tableTailPages.get(oldName);
    if (tailPage !== undefined) {
      this.tableTailPages.delete(oldName);
      this.tableTailPages.set(newName, tailPage);
    }
    if (this.vmCtx.table?.name.toLowerCase() === oldName.toLowerCase()) {
      this.vmCtx.table = null;
    }

    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    return this._getTableInternal(newName);
  }

  async renameColumn(
    tableName: string,
    oldColumnName: string,
    newColumnName: string,
  ): Promise<TableMeta> {
    return this.coordinator.leaseQueue.enqueue(
      () => this._renameColumnInternal(tableName, oldColumnName, newColumnName),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _renameColumnInternal(
    tableName: string,
    oldColumnName: string,
    newColumnName: string,
  ): Promise<TableMeta> {
    this.validateIdentifier(newColumnName, "Column name");
    const table = await this._getTableInternal(tableName);
    const colIdx = table.columns.findIndex((c) => c.name === oldColumnName);
    if (colIdx === -1) {
      throw new ColumnNotFoundError(oldColumnName, tableName);
    }

    if (oldColumnName === newColumnName) {
      return table;
    }

    if (
      table.columns.some((c, idx) => idx !== colIdx && c.name === newColumnName)
    ) {
      throw new ColumnAlreadyExistsError(newColumnName, tableName);
    }

    const { pageChainIdx, colIdxInPage } = catalog_map_column_location(colIdx);
    let catPageId = table.colCatalogPageId;
    for (let p = 0; p < pageChainIdx; p++) {
      const slot = await this.driver.acquirePage(catPageId);
      const header = catalog_read_page_header(
        this.pool.getSlotDataView(slot),
        0,
      );
      catPageId = header.nextColCatalogPageId;
    }

    const catSlot = await this.driver.acquirePage(catPageId);
    const catView = this.pool.getSlotDataView(catSlot);
    const updatedCol: ColumnMeta = {
      ...table.columns[colIdx],
      name: newColumnName,
    };
    catalog_write_column_meta(catView, 0, colIdxInPage, updatedCol);
    const chk = computePageChecksum(this.pool.getPageBytesInSlot(catSlot));
    catView.setUint32(12, chk, true);
    this.pool.markDirty(catSlot);

    const page1View = this.pool.getSlotDataView(0);
    catalog_increment_schema_version(page1View);
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);

    this.tableMetaCache.delete(tableName.toLowerCase());
    if (this.vmCtx.table?.name.toLowerCase() === tableName.toLowerCase()) {
      this.vmCtx.table = null;
    }

    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    return this._getTableInternal(tableName);
  }

  async addColumn(
    tableName: string,
    column: ColumnDefinition,
    options?: { defaultValue?: DbValue },
  ): Promise<TableMeta> {
    this.validateIdentifier(column.name, "Column name");
    const defaultVal: DbValue =
      options?.defaultValue !== undefined
        ? options.defaultValue
        : (column as any).defaultValue !== undefined
          ? (column as any).defaultValue
          : null;

    return this._executeTableRebuildAtomic(tableName, (table) => {
      if (table.columns.some((c) => c.name === column.name)) {
        throw new ColumnAlreadyExistsError(column.name, tableName);
      }
      if (table.columns.length + 1 > MAX_COLUMNS_PER_TABLE) {
        throw new TooManyColumnsError(
          table.columns.length + 1,
          MAX_COLUMNS_PER_TABLE,
        );
      }

      const rawFlags =
        typeof (column as any).flags === "number" ? (column as any).flags : 0;
      const isPk =
        !!column.primaryKey ||
        !!column.flags?.primaryKey ||
        (rawFlags & ColumnFlag.PRIMARY_KEY) !== 0;
      const isAutoInc =
        !!column.autoInc ||
        !!column.flags?.autoInc ||
        (rawFlags & ColumnFlag.AUTO_INC) !== 0;
      const isIndexed =
        !!column.indexed ||
        !!column.flags?.indexed ||
        (rawFlags & ColumnFlag.INDEXED) !== 0;

      if (
        isPk &&
        table.columns.some((c) => (c.flags & ColumnFlag.PRIMARY_KEY) !== 0)
      ) {
        throw new Error(
          `Cannot add a PRIMARY KEY column "${column.name}" to table "${tableName}" because it already has a primary key`,
        );
      }

      const existingColDefs: ColumnDefinition[] = table.columns.map((c) => ({
        name: c.name,
        type: c.type,
        flags: {
          primaryKey: (c.flags & ColumnFlag.PRIMARY_KEY) !== 0,
          notNull: (c.flags & ColumnFlag.NOT_NULL) !== 0,
          indexed: (c.flags & ColumnFlag.INDEXED) !== 0,
          autoInc: (c.flags & ColumnFlag.AUTO_INC) !== 0,
        },
      }));

      return {
        newColumns: [...existingColDefs, column],
        transformRow: (row: DbRow) => {
          const nextRow: DbRow = { ...row };
          if (!isAutoInc || defaultVal !== null) {
            nextRow[column.name] = defaultVal;
          }
          return nextRow;
        },
        keepIndex: () => true,
        newAutoIndexCol: isIndexed && !isPk ? column.name : undefined,
      };
    });
  }

  async dropColumn(tableName: string, columnName: string): Promise<TableMeta> {
    this.validateIdentifier(columnName, "Column name");

    return this._executeTableRebuildAtomic(tableName, (table) => {
      const colIdx = table.columns.findIndex((c) => c.name === columnName);
      if (colIdx === -1) {
        throw new ColumnNotFoundError(columnName, tableName);
      }
      if (table.columns.length <= 1) {
        throw new CannotDropColumnError(
          `Cannot drop column "${columnName}" from table "${tableName}": table must have at least one column`,
        );
      }

      const targetCol = table.columns[colIdx];
      if ((targetCol.flags & ColumnFlag.PRIMARY_KEY) !== 0) {
        throw new CannotDropColumnError(
          `Cannot drop PRIMARY KEY column "${columnName}" from table "${tableName}"`,
        );
      }

      const newColumns: ColumnDefinition[] = table.columns
        .filter((c) => c.name !== columnName)
        .map((c) => ({
          name: c.name,
          type: c.type,
          flags: {
            primaryKey: (c.flags & ColumnFlag.PRIMARY_KEY) !== 0,
            notNull: (c.flags & ColumnFlag.NOT_NULL) !== 0,
            indexed: (c.flags & ColumnFlag.INDEXED) !== 0,
            autoInc: (c.flags & ColumnFlag.AUTO_INC) !== 0,
          },
        }));

      return {
        newColumns,
        transformRow: (row: DbRow) => {
          const nextRow: DbRow = { ...row };
          delete nextRow[columnName];
          return nextRow;
        },
        keepIndex: (colNames: string[]) => !colNames.includes(columnName),
      };
    });
  }

  async alterTable(
    tableName: string,
    operation: AlterTableOperation,
  ): Promise<TableMeta> {
    switch (operation.type) {
      case "renameTable":
        return this.renameTable(tableName, operation.newName);
      case "renameColumn":
        return this.renameColumn(tableName, operation.from, operation.to);
      case "addColumn":
        return this.addColumn(tableName, operation.column, {
          defaultValue: operation.defaultValue,
        });
      case "dropColumn":
        return this.dropColumn(tableName, operation.column);
      default:
        throw new Error(
          `Unsupported alterTable operation: ${(operation as any)?.type}`,
        );
    }
  }

  private async _executeTableRebuildAtomic(
    tableName: string,
    prepare: (table: TableMeta) => {
      newColumns: ColumnDefinition[];
      transformRow: (row: DbRow) => DbRow;
      keepIndex: (colNames: string[]) => boolean;
      newAutoIndexCol?: string;
    },
  ): Promise<TableMeta> {
    if (!this.coordinator.isInTransaction()) {
      return this.transaction((tx) =>
        tx._rebuildTableSchemaInternal(tableName, prepare),
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const savepoint = await this.coordinator.captureSavepoint();
      try {
        return await this._rebuildTableSchemaInternal(tableName, prepare);
      } catch (err) {
        this.tableMetaCache.clear();
        this.tableTailPages.clear();
        this.indexTailPages.clear();
        await this.coordinator.restoreSavepoint(savepoint);
        throw err;
      }
    }, this.currentLeaseId ?? undefined);
  }

  private async _rebuildTableSchemaInternal(
    tableName: string,
    prepare: (table: TableMeta) => {
      newColumns: ColumnDefinition[];
      transformRow: (row: DbRow) => DbRow;
      keepIndex: (colNames: string[]) => boolean;
      newAutoIndexCol?: string;
    },
  ): Promise<TableMeta> {
    const table = await this._getTableInternal(tableName);
    const { newColumns, transformRow, keepIndex, newAutoIndexCol } =
      prepare(table);

    // 1. Read all existing rows across the table's data pages
    const migratedRows: DbRow[] = [];
    let currentPageId = table.rootPageId;
    while (currentPageId !== 0) {
      let pageSlot = await this.driver.acquirePage(currentPageId);
      let pageView = this.pool.getSlotDataView(pageSlot);
      const cellCount = page_get_cell_count(pageView, 0);
      const nextPageId = page_get_next_page_id(pageView, 0);

      for (let i = 0; i < cellCount; i++) {
        pageSlot = await this.driver.acquirePage(currentPageId);
        pageView = this.pool.getSlotDataView(pageSlot);
        const cellOffset = page_get_cell_offset(pageView, 0, i);
        const row = page_deserialize_row(table.columns, pageView, cellOffset);
        if (row) {
          migratedRows.push(transformRow(row));
        }
      }

      currentPageId = nextPageId;
    }

    // 2. Capture autoIncNext and surviving secondary indexes
    const savedAutoIncNext = table.autoIncNext;
    const page1View = this.pool.getSlotDataView(0);
    const existingIndexes = catalog_list_table_indexes(
      page1View,
      table.tableId,
    );
    const survivingSecondaryIndexes: Array<{
      name: string;
      colNames: string[];
      unique: boolean;
    }> = [];

    for (const idx of existingIndexes) {
      if ((idx.flags & IndexFlag.PRIMARY) !== 0) continue;
      const colNames = idx.columnIndices
        .slice(0, idx.columnCount)
        .map((cIdx) => table.columns[cIdx]?.name)
        .filter((n): n is string => typeof n === "string");
      if (colNames.length === idx.columnCount && keepIndex(colNames)) {
        survivingSecondaryIndexes.push({
          name: idx.name,
          colNames,
          unique: (idx.flags & IndexFlag.UNIQUE) !== 0,
        });
      }
    }

    // 3. Drop old table and recreate with the new column layout
    await this._dropTableInternal(tableName);
    await this._createTableInternal(tableName, newColumns);

    // 4. Recreate surviving secondary indexes
    for (const idxSpec of survivingSecondaryIndexes) {
      await this._createIndexInternal(tableName, idxSpec.colNames, {
        name: idxSpec.name,
        unique: idxSpec.unique,
      });
    }

    if (
      newAutoIndexCol &&
      !survivingSecondaryIndexes.some(
        (idx) =>
          idx.colNames.length === 1 && idx.colNames[0] === newAutoIndexCol,
      )
    ) {
      await this._createIndexInternal(tableName, newAutoIndexCol);
    }

    // 5. Re-insert migrated rows
    if (migratedRows.length > 0) {
      await this._insertManyInternal(tableName, migratedRows, false);
    }

    // 6. Restore autoIncNext sequence if needed
    const newSlotIdx = catalog_find_table_slot(page1View, tableName);
    if (newSlotIdx !== -1) {
      const newDesc = catalog_read_table_descriptor(page1View, newSlotIdx)!;
      if (savedAutoIncNext > newDesc.autoIncNext) {
        newDesc.autoIncNext = savedAutoIncNext;
        catalog_write_table_descriptor(page1View, newSlotIdx, newDesc);
        catalog_update_page1_checksum(page1View);
        this.pool.markDirty(0);
      }
    }

    this.tableMetaCache.delete(tableName.toLowerCase());
    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    return this._getTableInternal(tableName);
  }

  async createIndex(
    tableName: string,
    columns: string | string[],
    options?: IndexOptions,
  ): Promise<void> {
    return this.coordinator.leaseQueue.enqueue(
      () => this._createIndexInternal(tableName, columns, options),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _createIndexInternal(
    tableName: string,
    columns: string | string[],
    options?: IndexOptions,
  ): Promise<void> {
    const table = await this._getTableInternal(tableName);
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

    const indexName = options?.name ?? `idx_${tableName}_${colNames.join("_")}`;

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
      throw new IndexAlreadyExistsError(duplicateColIndex.name || indexName);
    }

    // Allocate and initialize index root page
    const indexRootPageId = await this.driver.allocateAndPinPage();
    const indexSlot = this.pool.getResidentSlot(indexRootPageId);
    const indexView = this.pool.getSlotDataView(indexSlot);
    page_init_index_leaf(indexView, 0, 0);
    this.pool.markDirty(indexSlot);
    this.pool.unpinSlot(indexSlot);

    const isUnique = !!options?.unique;
    const seenUniqueKeys = isUnique
      ? new Set<string | number | bigint>()
      : null;

    // Backfill: iterate all data pages and insert existing rows into new index
    let currentPageId = table.rootPageId;
    while (currentPageId !== 0) {
      let pageSlot = this.pool.getResidentSlot(currentPageId);
      if (pageSlot !== -1) {
        this.pool.setRefBit(pageSlot, 1);
      } else {
        pageSlot = await this.driver.acquirePage(currentPageId);
      }
      let pageView = this.pool.getSlotDataView(pageSlot);
      const cellCount = page_get_cell_count(pageView, 0);
      const nextPageId = page_get_next_page_id(pageView, 0);

      for (let i = 0; i < cellCount; i++) {
        pageSlot = this.pool.getResidentSlot(currentPageId);
        if (pageSlot !== -1) {
          this.pool.setRefBit(pageSlot, 1);
        } else {
          pageSlot = await this.driver.acquirePage(currentPageId);
        }
        pageView = this.pool.getSlotDataView(pageSlot);
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
            if (seenUniqueKeys !== null) {
              const setKey =
                keyVal instanceof Uint8Array
                  ? Array.from(keyVal).join(",")
                  : keyVal;
              if (seenUniqueKeys.has(setKey)) {
                await this.freeTableTreePages(indexRootPageId);
                this.indexTailPages.delete(indexRootPageId);
                throw new UniqueConstraintViolationError(
                  `Duplicate key value violates unique constraint "${indexName}" on table "${tableName}"`,
                );
              }
              seenUniqueKeys.add(setKey);
            }

            await this.insertIntoIndex(indexRootPageId, keyType, keyVal, rowid);
          }
        }
      }

      currentPageId = nextPageId;
    }

    let freeSlot = catalog_find_free_index_slot(page1View);
    if (freeSlot === -1) {
      const overflowPageId = await this.driver.allocateAndPinPage();
      freeSlot = catalog_append_index_overflow_page(page1View, overflowPageId);
      if (freeSlot === -1) {
        throw new TooManyIndexesError(MAX_INDEXES_PAGE1 + 1, MAX_INDEXES_PAGE1);
      }
      this.pool.markDirty(0);
    }

    // Write index descriptor into catalog (Page 1 or overflow catalog page)
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
    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }
  }

  async dropIndex(indexName: string): Promise<void> {
    return this.coordinator.leaseQueue.enqueue(
      () => this._dropIndexInternal(indexName),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _dropIndexInternal(indexName: string): Promise<void> {
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

    if (found.slotIdx >= 0) {
      catalog_delete_index_descriptor(page1View, found.slotIdx);
    } else {
      const tSlot = -found.slotIdx - 1;
      const tDesc = catalog_read_table_descriptor(page1View, tSlot);
      if (tDesc) {
        tDesc.pkRootPageId = undefined;
        tDesc.pkColumnCount = undefined;
        tDesc.pkFlags = undefined;
        tDesc.pkColumnIndices = undefined;
        catalog_write_table_descriptor(page1View, tSlot, tDesc);
      }
    }
    catalog_increment_schema_version(page1View);
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);
    this.tableMetaCache.clear();
    this.indexTailPages.clear();
    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }
  }

  async listIndexes(tableName?: string): Promise<IndexDescriptor[]> {
    return this.coordinator.leaseQueue.enqueue(async () => {
      const page1View = this.pool.getSlotDataView(0);
      if (tableName) {
        const table = await this._getTableInternal(tableName);
        return catalog_list_table_indexes(page1View, table.tableId);
      }
      return catalog_list_all_indexes(page1View);
    }, this.currentLeaseId ?? undefined);
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
    excludedRowids?: Set<bigint>,
  ): Promise<boolean> {
    const searchFn = this.wasmCore
      ? this.wasmCore.page_binary_search_index_leaf
      : page_binary_search_index_leaf;
    let currIdxPageId = rootPageId;
    while (currIdxPageId !== 0) {
      let slot = this.pool.getResidentSlot(currIdxPageId);
      if (slot !== -1) {
        this.pool.setRefBit(slot, 1);
      } else {
        slot = await this.driver.acquirePage(currIdxPageId);
      }
      const view = this.pool.getSlotDataView(slot);
      const cellCount = page_get_cell_count(view, 0);
      if (cellCount > 0) {
        const search = searchFn(view, 0, keyType, keyVal);
        if (search.found) {
          const cellOff = page_get_cell_offset(view, 0, search.slot_idx);
          const kLen = view.getUint16(cellOff, true);
          const foundRowid = view.getBigInt64(cellOff + 2 + kLen, true);
          if (!excludedRowids || !excludedRowids.has(foundRowid)) {
            return true;
          }
        }
      }
      currIdxPageId = page_get_next_page_id(view, 0);
    }
    return false;
  }

  private async deleteFromIndex(
    rootPageId: number,
    keyType: DataType,
    keyVal: any,
    rowid: bigint,
  ): Promise<boolean> {
    const searchFn = this.wasmCore
      ? this.wasmCore.page_binary_search_index_leaf
      : page_binary_search_index_leaf;
    const deleteFn = this.wasmCore
      ? this.wasmCore.page_delete_index_leaf_cell
      : page_delete_index_leaf_cell;
    let currIdxPageId = rootPageId;
    while (currIdxPageId !== 0) {
      let slot = this.pool.getResidentSlot(currIdxPageId);
      if (slot !== -1) {
        this.pool.setRefBit(slot, 1);
      } else {
        slot = await this.driver.acquirePage(currIdxPageId);
      }
      const view = this.pool.getSlotDataView(slot);
      const cellCount = page_get_cell_count(view, 0);
      if (cellCount > 0) {
        const search = searchFn(view, 0, keyType, keyVal, rowid);
        if (search.found) {
          deleteFn(view, 0, search.slot_idx);
          this.pool.markDirty(slot);
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
    const insertIdxFn = this.wasmCore
      ? this.wasmCore.page_insert_index_leaf_cell
      : page_insert_index_leaf_cell;
    let idxPageId = this.indexTailPages.get(rootPageId) ?? rootPageId;
    let idxSlot = this.pool.getResidentSlot(idxPageId);
    if (idxSlot !== -1) {
      this.pool.setRefBit(idxSlot, 1);
    } else {
      idxSlot = await this.driver.acquirePage(idxPageId);
    }
    let idxView = this.pool.getSlotDataView(idxSlot);

    while (true) {
      const nextIdxPageId = page_get_next_page_id(idxView, 0);
      if (nextIdxPageId === 0) break;
      idxPageId = nextIdxPageId;
      idxSlot = this.pool.getResidentSlot(idxPageId);
      if (idxSlot !== -1) {
        this.pool.setRefBit(idxSlot, 1);
      } else {
        idxSlot = await this.driver.acquirePage(idxPageId);
      }
      idxView = this.pool.getSlotDataView(idxSlot);
    }
    this.indexTailPages.set(rootPageId, idxPageId);

    let idxInsertRes = insertIdxFn(
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
          idxInsertRes = insertIdxFn(
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

  private cloneRow(row: DbRow): DbRow {
    const out: DbRow = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v instanceof Uint8Array ? v.slice() : v;
    }
    return out;
  }

  private valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if ((a === null || a === undefined) && (b === null || b === undefined)) {
      return true;
    }
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    if (
      (typeof a === "number" && typeof b === "bigint") ||
      (typeof a === "bigint" && typeof b === "number")
    ) {
      return BigInt(a) === BigInt(b);
    }
    if (
      (typeof a === "boolean" && typeof b === "number") ||
      (typeof a === "number" && typeof b === "boolean")
    ) {
      return Number(a) === Number(b);
    }
    return false;
  }

  private extractPrimaryKey(table: TableMeta, row: DbRow): DbValue | DbValue[] {
    const pkCols = table.columns.filter(
      (c) => (c.flags & ColumnFlag.PRIMARY_KEY) !== 0,
    );
    if (pkCols.length === 1) {
      return (row[pkCols[0].name] ?? null) as DbValue;
    }
    if (pkCols.length > 1) {
      return pkCols.map((c) => (row[c.name] ?? null) as DbValue);
    }
    if (table.columns.length === 1) {
      return (row[table.columns[0].name] ?? null) as DbValue;
    }
    return table.columns.map((c) => (row[c.name] ?? null) as DbValue);
  }

  private serializePkKey(
    pk: DbValue | DbValue[] | Record<string, DbValue>,
  ): string {
    const formatOne = (v: DbValue): string => {
      if (v === null || v === undefined) return "null";
      if (v instanceof Uint8Array) return `b:${Array.from(v).join(",")}`;
      return `${typeof v}:${String(v)}`;
    };
    if (Array.isArray(pk)) {
      return `[${pk.map(formatOne).join("|")}]`;
    }
    if (pk !== null && typeof pk === "object" && !(pk instanceof Uint8Array)) {
      const keys = Object.keys(pk).sort();
      return `{${keys.map((k) => `${k}:${formatOne(pk[k])}`).join("|")}}`;
    }
    return formatOne(pk as DbValue);
  }

  private buildChangeset(
    txId: number,
    origin: string,
    meta: Record<string, any> | undefined,
    changes: MutationRecord[],
  ): Changeset {
    const { changeCounter, schemaVersion } = this.getSyncState();
    const tables = Array.from(new Set(changes.map((c) => c.table)));

    return {
      txId,
      origin,
      meta,
      changeCounter,
      schemaVersion,
      tables,
      changes,
      coalesced: (): MutationRecord[] => {
        const map = new Map<string, MutationRecord>();
        for (const rec of changes) {
          const key = `${rec.table.toLowerCase()}::${this.serializePkKey(rec.pk)}`;
          const prev = map.get(key);
          if (!prev) {
            map.set(key, {
              table: rec.table,
              op: rec.op,
              pk: Array.isArray(rec.pk) ? [...rec.pk] : rec.pk,
              oldRow: rec.oldRow ? this.cloneRow(rec.oldRow) : undefined,
              newRow: rec.newRow ? this.cloneRow(rec.newRow) : undefined,
              changedColumns: rec.changedColumns
                ? [...rec.changedColumns]
                : undefined,
            });
            continue;
          }

          if (prev.op === "insert" && rec.op === "update") {
            map.set(key, {
              table: rec.table,
              op: "insert",
              pk: Array.isArray(rec.pk) ? [...rec.pk] : rec.pk,
              newRow: rec.newRow ? this.cloneRow(rec.newRow) : prev.newRow,
            });
          } else if (prev.op === "insert" && rec.op === "delete") {
            map.delete(key);
          } else if (prev.op === "update" && rec.op === "update") {
            const oldRow = prev.oldRow!;
            const newRow = rec.newRow
              ? this.cloneRow(rec.newRow)
              : prev.newRow!;
            const changedColumns = Object.keys(newRow).filter(
              (col) => !this.valuesEqual(oldRow[col], newRow[col]),
            );
            map.set(key, {
              table: rec.table,
              op: "update",
              pk: Array.isArray(rec.pk) ? [...rec.pk] : rec.pk,
              oldRow,
              newRow,
              changedColumns,
            });
          } else if (prev.op === "update" && rec.op === "delete") {
            map.set(key, {
              table: rec.table,
              op: "delete",
              pk: Array.isArray(prev.pk) ? [...prev.pk] : prev.pk,
              oldRow: prev.oldRow,
            });
          } else if (prev.op === "delete" && rec.op === "insert") {
            const oldRow = prev.oldRow!;
            const newRow = rec.newRow ? this.cloneRow(rec.newRow) : {};
            const changedColumns = Object.keys(newRow).filter(
              (col) => !this.valuesEqual(oldRow[col], newRow[col]),
            );
            map.set(key, {
              table: rec.table,
              op: "update",
              pk: Array.isArray(rec.pk) ? [...rec.pk] : rec.pk,
              oldRow,
              newRow,
              changedColumns,
            });
          } else {
            map.set(key, {
              table: rec.table,
              op: rec.op,
              pk: Array.isArray(rec.pk) ? [...rec.pk] : rec.pk,
              oldRow: rec.oldRow ? this.cloneRow(rec.oldRow) : undefined,
              newRow: rec.newRow ? this.cloneRow(rec.newRow) : undefined,
              changedColumns: rec.changedColumns
                ? [...rec.changedColumns]
                : undefined,
            });
          }
        }
        return Array.from(map.values());
      },
    };
  }

  private notifySubscriptions(event: TableChangeEvent): void {
    if (this.subscriptions.size === 0) return;
    const isWildcardOrImport =
      event.origin === "import" || event.tables.includes("*");
    if (!isWildcardOrImport && event.tables.length === 0) return;
    const lowerChanged = new Set(event.tables.map((t) => t.toLowerCase()));
    for (const sub of this.subscriptions) {
      if (sub.tables === "*" || isWildcardOrImport) {
        sub.callback(event);
      } else {
        for (const t of lowerChanged) {
          if (sub.tables.has(t)) {
            sub.callback(event);
            break;
          }
        }
      }
    }
  }

  private emitCommitAndSubscriptions(changeset: Changeset): void {
    if (changeset.changes.length === 0) return;

    for (const hook of this.commitHooks) {
      hook(changeset);
    }

    const tables = changeset.tables;
    const { changeCounter, schemaVersion } = changeset;

    this.notifySubscriptions({
      tables,
      origin: changeset.origin,
      meta: changeset.meta,
      changeCounter,
      schemaVersion,
      crossTab: false,
      changeset,
    });

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          senderId: this.instanceId,
          tables,
          origin: changeset.origin,
          meta: changeset.meta,
          changeCounter,
          schemaVersion,
        });
      } catch {
        // Ignore broadcast errors
      }
    }
  }

  onBeforeCommit(hook: BeforeCommitHook): () => void {
    this.beforeCommitHooks.add(hook);
    return () => {
      this.beforeCommitHooks.delete(hook);
    };
  }

  onCommit(hook: CommitHook): () => void {
    this.commitHooks.add(hook);
    return () => {
      this.commitHooks.delete(hook);
    };
  }

  subscribe(
    tables: string | string[] | "*",
    callback: TableSubscriptionCallback,
  ): () => void {
    const entry = {
      tables:
        tables === "*"
          ? ("*" as const)
          : new Set(
              (Array.isArray(tables) ? tables : [tables]).map((t) =>
                t.toLowerCase(),
              ),
            ),
      callback,
    };
    this.subscriptions.add(entry);
    return () => {
      this.subscriptions.delete(entry);
    };
  }

  /**
   * Creates a reactive LiveQueryController bound to this WebDB instance.
   * Automatically tracks accessed tables (or uses `options.tables`) and re-runs
   * `queryFn` whenever those tables change locally or across tabs.
   */
  liveQuery<T = DbRow[]>(
    queryFn: LiveQueryFn<T>,
    callbackOrOptions?:
      | ((data: T, state: LiveQueryState<T>) => void)
      | LiveQueryOptions<T>,
    options?: LiveQueryOptions<T>,
  ): LiveQueryController<T> {
    const isCallback = typeof callbackOrOptions === "function";
    const resolvedOptions: LiveQueryOptions<T> = {
      db: this,
      ...(isCallback ? options : callbackOrOptions),
    };
    return isCallback
      ? liveQuery<T>(queryFn, callbackOrOptions, resolvedOptions)
      : liveQuery<T>(queryFn, resolvedOptions);
  }

  getSyncState(): SyncState {
    const page1View = this.pool.getSlotDataView(0);
    const header = catalog_read_page1_header(page1View, false);
    return {
      changeCounter: header.changeCounter,
      schemaVersion: header.schemaVersion,
    };
  }

  private validateFilterColumns(
    table: TableMeta,
    filters: QueryFilter[],
  ): void {
    const validCols = new Set(table.columns.map((c) => c.name));
    const checkExpr = (expr: any) => {
      if (!expr) return;
      if (expr.type === "col" && expr.name !== "*") {
        if (!validCols.has(expr.name)) {
          throw new ColumnNotFoundError(expr.name, table.name);
        }
      } else if (expr.type === "binary") {
        checkExpr(expr.left);
        checkExpr(expr.right);
      } else if (expr.type === "fn" && Array.isArray(expr.args)) {
        for (const a of expr.args) checkExpr(a);
      }
    };
    const checkFilter = (f: QueryFilter) => {
      if (f.colName && !validCols.has(f.colName)) {
        throw new ColumnNotFoundError(f.colName, table.name);
      }
      if (f.expr) checkExpr(f.expr);
      if (f.child) checkFilter(f.child);
      if (f.children) {
        for (const c of f.children) checkFilter(c);
      }
    };
    for (const f of filters) checkFilter(f);
  }

  private matchesFilter(table: TableMeta, row: DbRow, f: QueryFilter): boolean {
    switch (f.type) {
      case "and":
        return (f.children ?? []).every((c) =>
          this.matchesFilter(table, row, c),
        );
      case "or":
        return (f.children ?? []).some((c) =>
          this.matchesFilter(table, row, c),
        );
      case "not":
        return f.child ? !this.matchesFilter(table, row, f.child) : true;
      case "null": {
        const val = f.expr
          ? evalExprNode(f.expr, row, (name) => this.getUdf(name)?.def.call)
          : row[f.colName!];
        const isNull = val === null || val === undefined;
        return f.isNull ? isNull : !isNull;
      }
      case "in": {
        const val = f.expr
          ? evalExprNode(f.expr, row, (name) => this.getUdf(name)?.def.call)
          : row[f.colName!];
        if (val === null || val === undefined) return false;
        const list = f.values ?? [];
        const found = list.some((item) => this.valuesEqual(val, item));
        return f.notIn ? !found : found;
      }
      case "expr": {
        if (!f.expr) return true;
        const val = evalExprNode(
          f.expr,
          row,
          (name) => this.getUdf(name)?.def.call,
        );
        return Boolean(val) && val !== 0;
      }
      case "cmp": {
        const left = f.expr
          ? evalExprNode(f.expr, row, (name) => this.getUdf(name)?.def.call)
          : row[f.colName!];
        const right = f.value;
        if (
          left === null ||
          left === undefined ||
          right === null ||
          right === undefined
        ) {
          return false;
        }
        const op = String(f.op ?? "=")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
        switch (op) {
          case "=":
          case "==":
            return this.valuesEqual(left, right);
          case "!=":
          case "<>":
            return !this.valuesEqual(left, right);
          case "<":
            return typeof left === "string" && typeof right === "string"
              ? left < right
              : Number(left) < Number(right);
          case "<=":
            return typeof left === "string" && typeof right === "string"
              ? left <= right
              : Number(left) <= Number(right);
          case ">":
            return typeof left === "string" && typeof right === "string"
              ? left > right
              : Number(left) > Number(right);
          case ">=":
            return typeof left === "string" && typeof right === "string"
              ? left >= right
              : Number(left) >= Number(right);
          case "like":
            return sql_like_match(String(left), String(right));
          case "not like":
            return !sql_like_match(String(left), String(right));
          case "contains":
            return String(left).includes(String(right));
          case "starts_with":
            return String(left).startsWith(String(right));
          case "ends_with":
            return String(left).endsWith(String(right));
          default:
            return this.valuesEqual(left, right);
        }
      }
      default:
        return true;
    }
  }

  private matchesFilters(
    table: TableMeta,
    row: DbRow,
    filters: QueryFilter[],
  ): boolean {
    for (const f of filters) {
      if (!this.matchesFilter(table, row, f)) return false;
    }
    return true;
  }

  /**
   * Deletes a sorted list of cell indices on `pageId` while maintaining exact
   * secondary index `rowid` pointers for both the deleted cells and any surviving
   * cells on `pageId` whose slot index shifts left.
   */
  private async deleteCellsOnDataPageAndShiftIndexes(
    table: TableMeta,
    indexes: IndexDescriptor[],
    pageId: number,
    deletedCellIndicesAsc: number[],
    allCellsOnPage: Array<{ cellIdx: number; row: DbRow }>,
  ): Promise<void> {
    if (deletedCellIndicesAsc.length === 0) return;
    const deletedSet = new Set(deletedCellIndicesAsc);

    if (indexes.length > 0) {
      // 1. Remove index entries for all deleted cells at their original cellIdx
      for (const delIdx of deletedCellIndicesAsc) {
        const entry = allCellsOnPage[delIdx];
        if (!entry) continue;
        const oldRowid = (BigInt(pageId) << 16n) | BigInt(delIdx);
        for (const idx of indexes) {
          const { keyVal, keyType } = this.extractIndexKey(
            table.columns,
            idx,
            entry.row,
          );
          if (keyVal !== undefined && keyVal !== null) {
            await this.deleteFromIndex(
              idx.rootPageId,
              keyType,
              keyVal,
              oldRowid,
            );
          }
        }
      }

      // 2. Shift index entries for surviving cells whose slot index moves left
      let newCellIdx = 0;
      for (let origIdx = 0; origIdx < allCellsOnPage.length; origIdx++) {
        if (deletedSet.has(origIdx)) continue;
        if (newCellIdx !== origIdx) {
          const survivingRow = allCellsOnPage[origIdx].row;
          const prevRowid = (BigInt(pageId) << 16n) | BigInt(origIdx);
          const shiftedRowid = (BigInt(pageId) << 16n) | BigInt(newCellIdx);
          for (const idx of indexes) {
            const { keyVal, keyType } = this.extractIndexKey(
              table.columns,
              idx,
              survivingRow,
            );
            if (keyVal !== undefined && keyVal !== null) {
              await this.deleteFromIndex(
                idx.rootPageId,
                keyType,
                keyVal,
                prevRowid,
              );
              await this.insertIntoIndex(
                idx.rootPageId,
                keyType,
                keyVal,
                shiftedRowid,
              );
            }
          }
        }
        newCellIdx++;
      }
    }

    // 3. Delete target cells from the data page in descending order of slot index
    const slot = await this.driver.acquirePage(pageId);
    const view = this.pool.getSlotDataView(slot);
    for (let k = deletedCellIndicesAsc.length - 1; k >= 0; k--) {
      page_delete_row(view, 0, deletedCellIndicesAsc[k]);
    }
    this.pool.markDirty(slot);
  }

  private normalizeWhereOrPkFilters(
    table: TableMeta,
    whereOrPk: DbValue | Partial<DbRow>,
  ): QueryFilter[] {
    if (
      whereOrPk !== null &&
      typeof whereOrPk === "object" &&
      !(whereOrPk instanceof Uint8Array)
    ) {
      const filters: QueryFilter[] = [];
      for (const [colName, val] of Object.entries(whereOrPk)) {
        if (val === undefined) continue;
        if (val === null) {
          filters.push({ type: "null", colName, isNull: true });
        } else {
          filters.push({ type: "cmp", colName, op: "=", value: val });
        }
      }
      return filters;
    }

    const pkCol = table.columns.find(
      (c) => (c.flags & ColumnFlag.PRIMARY_KEY) !== 0,
    );
    if (!pkCol) {
      throw new Error(
        `Table "${table.name}" does not have a primary key column for scalar lookup`,
      );
    }
    return [{ type: "cmp", colName: pkCol.name, op: "=", value: whereOrPk }];
  }

  async insert(
    tableName: string,
    row: DbRow,
    options?: TransactionOptions,
  ): Promise<void> {
    await this.insertMany(tableName, [row], options);
  }

  async insertMany(
    tableName: string,
    rows: DbRow[],
    options?: TransactionOptions,
  ): Promise<void> {
    if (!rows || rows.length === 0) return;
    if (
      !this.coordinator.isInTransaction() &&
      this.beforeCommitHooks.size > 0
    ) {
      await this.transaction(async (tx) => {
        await tx._insertManyInternal(tableName, rows, true);
      }, options);
      return;
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const inTx = this.coordinator.isInTransaction();
      const shouldTrackChanges =
        inTx ||
        this.commitHooks.size > 0 ||
        this.beforeCommitHooks.size > 0 ||
        this.subscriptions.size > 0;
      const recorded = await this._insertManyInternal(
        tableName,
        rows,
        shouldTrackChanges,
      );
      if (!inTx) {
        if (recorded.length > 0) {
          const changeset = this.buildChangeset(
            this.nextAutoTxId++,
            options?.origin ?? "local",
            options?.meta,
            recorded,
          );
          this.emitCommitAndSubscriptions(changeset);
        } else if (this.broadcastChannel) {
          const { changeCounter, schemaVersion } = this.getSyncState();
          try {
            this.broadcastChannel.postMessage({
              senderId: this.instanceId,
              tables: [tableName],
              origin: options?.origin ?? "local",
              meta: options?.meta,
              changeCounter,
              schemaVersion,
            });
          } catch {
            // Ignore closed BroadcastChannel
          }
        }
      }
    }, this.currentLeaseId ?? undefined);
  }

  private async _insertManyInternal(
    tableName: string,
    rows: DbRow[],
    trackChanges: boolean = true,
  ): Promise<MutationRecord[]> {
    if (!rows || rows.length === 0) return [];
    const table = await this._getTableInternal(tableName);
    const page1View = this.pool.getSlotDataView(0);
    const indexes = catalog_list_table_indexes(page1View, table.tableId);
    const uniqueIndexes = indexes.filter(
      (idx) => (idx.flags & (IndexFlag.UNIQUE | IndexFlag.PRIMARY)) !== 0,
    );

    const autoIncCol = table.columns.find(
      (c) => (c.flags & ColumnFlag.AUTO_INC) !== 0,
    );

    const requiredPkCols = table.columns.filter(
      (c) =>
        (c.flags & ColumnFlag.PRIMARY_KEY) !== 0 &&
        (c.flags & ColumnFlag.AUTO_INC) === 0,
    );

    // Check which unique indexes already contain entries prior to this batch
    const nonEmptyUniqueRootIds = new Set<number>();
    for (const idx of uniqueIndexes) {
      let rSlot = this.pool.getResidentSlot(idx.rootPageId);
      if (rSlot !== -1) {
        this.pool.setRefBit(rSlot, 1);
      } else {
        rSlot = await this.driver.acquirePage(idx.rootPageId);
      }
      const rView = this.pool.getSlotDataView(rSlot);
      if (
        page_get_cell_count(rView, 0) > 0 ||
        page_get_next_page_id(rView, 0) !== 0
      ) {
        nonEmptyUniqueRootIds.add(idx.rootPageId);
      }
    }

    // Pass 1: Pre-validate all rows in the batch (NOT NULL, uniqueness, row serialization size)
    // before mutating any data pages, index pages, or auto-increment counters.
    const batchUniqueSets: Map<string, Set<any>> = new Map();
    for (const idx of uniqueIndexes) {
      batchUniqueSets.set(idx.name, new Set());
    }

    let tentativeAutoInc = table.autoIncNext;
    const preparedRows: Array<{
      row: DbRow;
      effectiveRow: DbRow;
      rowBytes: Uint8Array;
      assignedAutoInc?: number;
    }> = new Array(rows.length);

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const origRow = rows[rIdx];

      // 1. Primary Key NOT NULL validation
      for (let p = 0; p < requiredPkCols.length; p++) {
        const cName = requiredPkCols[p].name;
        if (origRow[cName] === undefined || origRow[cName] === null) {
          throw new NotNullConstraintError(cName, tableName);
        }
      }

      // 2. Tentative Auto-Inc calculation
      let assignedAutoInc: number | undefined;
      let effectiveRow: DbRow;
      if (trackChanges) {
        effectiveRow = {};
        for (let cIdx = 0; cIdx < table.columns.length; cIdx++) {
          const cName = table.columns[cIdx].name;
          effectiveRow[cName] =
            origRow[cName] !== undefined ? origRow[cName] : null;
        }
        if (
          autoIncCol &&
          (origRow[autoIncCol.name] === undefined ||
            origRow[autoIncCol.name] === null)
        ) {
          assignedAutoInc = Number(tentativeAutoInc);
          tentativeAutoInc += 1n;
          effectiveRow[autoIncCol.name] = assignedAutoInc;
        }
      } else if (
        autoIncCol &&
        (origRow[autoIncCol.name] === undefined ||
          origRow[autoIncCol.name] === null)
      ) {
        assignedAutoInc = Number(tentativeAutoInc);
        tentativeAutoInc += 1n;
        effectiveRow = { ...origRow, [autoIncCol.name]: assignedAutoInc };
      } else {
        effectiveRow = origRow;
      }

      // 3. Uniqueness constraint probe (intra-batch and existing index pages)
      for (let u = 0; u < uniqueIndexes.length; u++) {
        const idx = uniqueIndexes[u];
        const { keyVal, keyType } = this.extractIndexKey(
          table.columns,
          idx,
          effectiveRow,
        );
        if (keyVal !== undefined && keyVal !== null) {
          const setKey =
            keyVal instanceof Uint8Array
              ? Array.from(keyVal).join(",")
              : keyVal;
          const set = batchUniqueSets.get(idx.name)!;
          if (set.has(setKey)) {
            throw new UniqueConstraintViolationError(
              `Duplicate key value violates unique constraint "${idx.name}" on table "${tableName}"`,
            );
          }
          set.add(setKey);

          if (nonEmptyUniqueRootIds.has(idx.rootPageId)) {
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
      }

      // 4. Pre-serialize row (validates row size <= 2048 bytes before any page mutation)
      const rowBytes = page_serialize_row(table.columns, effectiveRow);
      preparedRows[rIdx] = {
        row: origRow,
        effectiveRow,
        rowBytes,
        assignedAutoInc,
      };
    }

    // Commit tentative auto-inc after full batch validation succeeds
    table.autoIncNext = tentativeAutoInc;

    // Fast resolution of tail data page
    let currentPageId = this.tableTailPages.get(tableName) ?? table.rootPageId;
    let slot = this.pool.getResidentSlot(currentPageId);
    if (slot !== -1) {
      this.pool.setRefBit(slot, 1);
    } else {
      slot = await this.driver.acquirePage(currentPageId);
    }
    let view = this.pool.getSlotDataView(slot);

    while (true) {
      const nextPageId = page_get_next_page_id(view, 0);
      if (nextPageId === 0) break;
      currentPageId = nextPageId;
      slot = this.pool.getResidentSlot(currentPageId);
      if (slot !== -1) {
        this.pool.setRefBit(slot, 1);
      } else {
        slot = await this.driver.acquirePage(currentPageId);
      }
      view = this.pool.getSlotDataView(slot);
    }
    this.tableTailPages.set(tableName, currentPageId);

    const recordedChanges: MutationRecord[] = [];
    const insertRowFn = this.wasmCore
      ? this.wasmCore.page_insert_row
      : page_insert_row;

    // Pass 2: Apply validated row insertions to data pages and secondary indexes
    for (let rIdx = 0; rIdx < preparedRows.length; rIdx++) {
      const { row, effectiveRow, rowBytes, assignedAutoInc } =
        preparedRows[rIdx];
      if (autoIncCol && assignedAutoInc !== undefined) {
        row[autoIncCol.name] = assignedAutoInc;
      }

      // 4. Data page insertion (re-acquire currentPageId in case index insertion evicted it)
      slot = this.pool.getResidentSlot(currentPageId);
      if (slot !== -1) {
        this.pool.setRefBit(slot, 1);
      } else {
        slot = await this.driver.acquirePage(currentPageId);
      }
      view = this.pool.getSlotDataView(slot);
      let targetPageId = currentPageId;
      let insertSlot = insertRowFn(
        view,
        0,
        rowBytes,
        this.pool.pageScratchpadOffset,
      );

      if (insertSlot === -1) {
        const prevSlot = slot;
        this.pool.pinSlot(prevSlot);
        try {
          const newPageId = await this.driver.allocateAndPinPage();
          const newSlot = this.pool.getResidentSlot(newPageId);
          try {
            page_set_next_page_id(view, 0, newPageId);
            this.pool.markDirty(prevSlot);

            const newView = this.pool.getSlotDataView(newSlot);
            insertSlot = insertRowFn(
              newView,
              0,
              rowBytes,
              this.pool.pageScratchpadOffset,
            );
            if (insertSlot === -1) {
              throw new Error(
                "Unexpected error: row does not fit in empty page",
              );
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
          this.pool.unpinSlot(prevSlot);
        }
      } else {
        this.pool.markDirty(slot);
      }

      // 5. Index insertion
      const rowid = (BigInt(targetPageId) << 16n) | BigInt(insertSlot);
      for (let iIdx = 0; iIdx < indexes.length; iIdx++) {
        const idx = indexes[iIdx];
        const { keyVal, keyType } = this.extractIndexKey(
          table.columns,
          idx,
          effectiveRow,
        );
        if (keyVal !== undefined && keyVal !== null) {
          await this.insertIntoIndex(idx.rootPageId, keyType, keyVal, rowid);
        }
      }

      if (trackChanges) {
        const rec: MutationRecord = {
          table: table.name,
          op: "insert",
          pk: this.extractPrimaryKey(table, effectiveRow),
          newRow: this.cloneRow(effectiveRow),
        };
        recordedChanges.push(rec);
        if (this.coordinator.isInTransaction()) {
          this.activeTxChanges.push(rec);
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
      // Keep the cached TableMeta (returned by getTable/listTables) in sync with Page 1
      const cachedMeta = this.tableMetaCache.get(tableName.toLowerCase());
      if (cachedMeta) cachedMeta.rowCountEstimate = desc.rowCountEstimate;
      catalog_increment_change_counter(page1View);
      catalog_update_page1_checksum(page1View);
      this.pool.markDirty(0);
    }

    // 7. Flush once for the whole batch if autocommit (not in transaction)
    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    return recordedChanges;
  }

  async update(
    tableName: string,
    whereOrPk: DbValue | Partial<DbRow>,
    patch: Partial<DbRow>,
    options?: TransactionOptions,
  ): Promise<number> {
    if (
      !this.coordinator.isInTransaction() &&
      this.beforeCommitHooks.size > 0
    ) {
      return this.transaction(
        (tx) => tx.update(tableName, whereOrPk, patch, options),
        options,
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const table = await this._getTableInternal(tableName);
      const filters = this.normalizeWhereOrPkFilters(table, whereOrPk);
      const inTx = this.coordinator.isInTransaction();
      const { count, changes } = await this._executeUpdateInternal(
        tableName,
        filters,
        patch,
      );
      if (!inTx && changes.length > 0) {
        const changeset = this.buildChangeset(
          this.nextAutoTxId++,
          options?.origin ?? "local",
          options?.meta,
          changes,
        );
        this.emitCommitAndSubscriptions(changeset);
      }
      return count;
    }, this.currentLeaseId ?? undefined);
  }

  async executeUpdate(
    tableName: string,
    filters: QueryFilter[],
    patch: Partial<DbRow>,
    options?: TransactionOptions,
  ): Promise<number> {
    if (
      !this.coordinator.isInTransaction() &&
      this.beforeCommitHooks.size > 0
    ) {
      return this.transaction(
        (tx) => tx.executeUpdate(tableName, filters, patch, options),
        options,
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const inTx = this.coordinator.isInTransaction();
      const { count, changes } = await this._executeUpdateInternal(
        tableName,
        filters,
        patch,
      );
      if (!inTx && changes.length > 0) {
        const changeset = this.buildChangeset(
          this.nextAutoTxId++,
          options?.origin ?? "local",
          options?.meta,
          changes,
        );
        this.emitCommitAndSubscriptions(changeset);
      }
      return count;
    }, this.currentLeaseId ?? undefined);
  }

  private async _executeUpdateInternal(
    tableName: string,
    filters: QueryFilter[],
    patch: Partial<DbRow>,
  ): Promise<{ count: number; changes: MutationRecord[] }> {
    const table = await this._getTableInternal(tableName);
    this.validateFilterColumns(table, filters);

    const validColMap = new Map(table.columns.map((c) => [c.name, c]));
    for (const k of Object.keys(patch)) {
      if (!validColMap.has(k)) {
        throw new ColumnNotFoundError(k, tableName);
      }
    }

    const page1View = this.pool.getSlotDataView(0);
    const indexes = catalog_list_table_indexes(page1View, table.tableId);
    const uniqueIndexes = indexes.filter(
      (idx) => (idx.flags & (IndexFlag.UNIQUE | IndexFlag.PRIMARY)) !== 0,
    );

    interface PageCellsSnapshot {
      pageId: number;
      allCells: Array<{ cellIdx: number; row: DbRow }>;
      matches: Array<{
        cellIdx: number;
        oldRow: DbRow;
        newRow: DbRow;
        changedColumns: string[];
        newRowBytes: Uint8Array;
      }>;
    }

    const pageSnapshots: PageCellsSnapshot[] = [];
    const updatingRowids = new Set<bigint>();
    let totalMatched = 0;

    // Pass 1: Scan pages, identify matching rows, build newRow, validate NOT NULL & row size
    let currPageId = table.rootPageId;
    while (currPageId !== 0) {
      const slot = await this.driver.acquirePage(currPageId);
      const view = this.pool.getSlotDataView(slot);
      const cellCount = page_get_cell_count(view, 0);
      const nextPageId = page_get_next_page_id(view, 0);

      const allCells: Array<{ cellIdx: number; row: DbRow }> = [];
      const matches: PageCellsSnapshot["matches"] = [];

      for (let i = 0; i < cellCount; i++) {
        const off = page_get_cell_offset(view, 0, i);
        const row = page_deserialize_row(table.columns, view, off);
        allCells.push({ cellIdx: i, row });

        if (this.matchesFilters(table, row, filters)) {
          const newRow: DbRow = { ...row };
          for (const [k, v] of Object.entries(patch)) {
            if (v !== undefined) {
              newRow[k] = v;
            }
          }

          // Primary Key NOT NULL check
          for (const c of table.columns) {
            if ((c.flags & ColumnFlag.PRIMARY_KEY) !== 0) {
              if (newRow[c.name] === null || newRow[c.name] === undefined) {
                throw new NotNullConstraintError(c.name, tableName);
              }
            }
          }

          const changedColumns = table.columns
            .map((c) => c.name)
            .filter((col) => !this.valuesEqual(row[col], newRow[col]));
          const newRowBytes = page_serialize_row(table.columns, newRow);

          matches.push({
            cellIdx: i,
            oldRow: row,
            newRow,
            changedColumns,
            newRowBytes,
          });
          updatingRowids.add((BigInt(currPageId) << 16n) | BigInt(i));
          totalMatched++;
        }
      }

      if (matches.length > 0) {
        pageSnapshots.push({ pageId: currPageId, allCells, matches });
      }
      currPageId = nextPageId;
    }

    if (totalMatched === 0) {
      return { count: 0, changes: [] };
    }

    // Pass 2: Validate UNIQUE constraints across all matched rows before mutating any page
    for (const idx of uniqueIndexes) {
      const batchSeenKeys = new Set<any>();
      for (const ps of pageSnapshots) {
        for (const m of ps.matches) {
          const { keyVal, keyType } = this.extractIndexKey(
            table.columns,
            idx,
            m.newRow,
          );
          if (keyVal !== undefined && keyVal !== null) {
            const setKey =
              keyVal instanceof Uint8Array
                ? Array.from(keyVal).join(",")
                : keyVal;
            if (batchSeenKeys.has(setKey)) {
              throw new UniqueConstraintViolationError(
                `Duplicate key value violates unique constraint "${idx.name}" on table "${tableName}"`,
              );
            }
            batchSeenKeys.add(setKey);

            const conflict = await this.probeIndexUnique(
              idx.rootPageId,
              keyType,
              keyVal,
              updatingRowids,
            );
            if (conflict) {
              throw new UniqueConstraintViolationError(
                `Duplicate key value violates unique constraint "${idx.name}" on table "${tableName}"`,
              );
            }
          }
        }
      }
    }

    // Pass 3: Apply updates (in-place when fitting on page, or delete + tail-insert on page overflow)
    const recordedChanges: MutationRecord[] = [];
    const overflowUpdates: Array<{
      oldRow: DbRow;
      newRow: DbRow;
      changedColumns: string[];
      newRowBytes: Uint8Array;
    }> = [];

    for (const ps of pageSnapshots) {
      const overflowIndicesOnPage: number[] = [];

      for (const m of ps.matches) {
        const slot = await this.driver.acquirePage(ps.pageId);
        const view = this.pool.getSlotDataView(slot);
        const res = page_update_row(
          view,
          0,
          m.cellIdx,
          m.newRowBytes,
          this.pool.pageScratchpadOffset,
        );

        if (res) {
          this.pool.markDirty(slot);
          ps.allCells[m.cellIdx].row = m.newRow;

          const rowid = (BigInt(ps.pageId) << 16n) | BigInt(m.cellIdx);
          for (const idx of indexes) {
            const oldKey = this.extractIndexKey(table.columns, idx, m.oldRow);
            const newKey = this.extractIndexKey(table.columns, idx, m.newRow);
            if (!this.valuesEqual(oldKey.keyVal, newKey.keyVal)) {
              if (oldKey.keyVal !== undefined && oldKey.keyVal !== null) {
                await this.deleteFromIndex(
                  idx.rootPageId,
                  oldKey.keyType,
                  oldKey.keyVal,
                  rowid,
                );
              }
              if (newKey.keyVal !== undefined && newKey.keyVal !== null) {
                await this.insertIntoIndex(
                  idx.rootPageId,
                  newKey.keyType,
                  newKey.keyVal,
                  rowid,
                );
              }
            }
          }

          const rec: MutationRecord = {
            table: table.name,
            op: "update",
            pk: this.extractPrimaryKey(table, m.newRow),
            oldRow: this.cloneRow(m.oldRow),
            newRow: this.cloneRow(m.newRow),
            changedColumns: m.changedColumns,
          };
          recordedChanges.push(rec);
          if (this.coordinator.isInTransaction()) {
            this.activeTxChanges.push(rec);
          }
        } else {
          overflowIndicesOnPage.push(m.cellIdx);
          overflowUpdates.push(m);
        }
      }

      if (overflowIndicesOnPage.length > 0) {
        await this.deleteCellsOnDataPageAndShiftIndexes(
          table,
          indexes,
          ps.pageId,
          overflowIndicesOnPage,
          ps.allCells,
        );
      }
    }

    // Re-insert any overflowed rows onto the table's tail page
    if (overflowUpdates.length > 0) {
      let currentPageId =
        this.tableTailPages.get(tableName) ?? table.rootPageId;
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

      for (const m of overflowUpdates) {
        slot = await this.driver.acquirePage(currentPageId);
        view = this.pool.getSlotDataView(slot);
        let targetPageId = currentPageId;
        let insertSlot = page_insert_row(
          view,
          0,
          m.newRowBytes,
          this.pool.pageScratchpadOffset,
        );

        if (insertSlot === -1) {
          const prevSlot = slot;
          this.pool.pinSlot(prevSlot);
          try {
            const newPageId = await this.driver.allocateAndPinPage();
            const newSlot = this.pool.getResidentSlot(newPageId);
            try {
              page_set_next_page_id(view, 0, newPageId);
              this.pool.markDirty(prevSlot);

              const newView = this.pool.getSlotDataView(newSlot);
              insertSlot = page_insert_row(
                newView,
                0,
                m.newRowBytes,
                this.pool.pageScratchpadOffset,
              );
              this.pool.markDirty(newSlot);
              currentPageId = newPageId;
              targetPageId = newPageId;
              this.tableTailPages.set(tableName, newPageId);
            } finally {
              this.pool.unpinSlot(newSlot);
            }
          } finally {
            this.pool.unpinSlot(prevSlot);
          }
        } else {
          this.pool.markDirty(slot);
        }

        const newRowid = (BigInt(targetPageId) << 16n) | BigInt(insertSlot);
        for (const idx of indexes) {
          const { keyVal, keyType } = this.extractIndexKey(
            table.columns,
            idx,
            m.newRow,
          );
          if (keyVal !== undefined && keyVal !== null) {
            await this.insertIntoIndex(
              idx.rootPageId,
              keyType,
              keyVal,
              newRowid,
            );
          }
        }

        const rec: MutationRecord = {
          table: table.name,
          op: "update",
          pk: this.extractPrimaryKey(table, m.newRow),
          oldRow: this.cloneRow(m.oldRow),
          newRow: this.cloneRow(m.newRow),
          changedColumns: m.changedColumns,
        };
        recordedChanges.push(rec);
        if (this.coordinator.isInTransaction()) {
          this.activeTxChanges.push(rec);
        }
      }
    }

    // Update Page 1 change counter
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);

    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    return { count: totalMatched, changes: recordedChanges };
  }

  async delete(
    tableName: string,
    whereOrPk: DbValue | Partial<DbRow>,
    options?: TransactionOptions,
  ): Promise<number> {
    if (
      !this.coordinator.isInTransaction() &&
      this.beforeCommitHooks.size > 0
    ) {
      return this.transaction(
        (tx) => tx.delete(tableName, whereOrPk, options),
        options,
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const table = await this._getTableInternal(tableName);
      const filters = this.normalizeWhereOrPkFilters(table, whereOrPk);
      const inTx = this.coordinator.isInTransaction();
      const { count, changes } = await this._executeDeleteInternal(
        tableName,
        filters,
      );
      if (!inTx && changes.length > 0) {
        const changeset = this.buildChangeset(
          this.nextAutoTxId++,
          options?.origin ?? "local",
          options?.meta,
          changes,
        );
        this.emitCommitAndSubscriptions(changeset);
      }
      return count;
    }, this.currentLeaseId ?? undefined);
  }

  async executeDelete(
    tableName: string,
    filters: QueryFilter[],
    options?: TransactionOptions,
  ): Promise<number> {
    if (
      !this.coordinator.isInTransaction() &&
      this.beforeCommitHooks.size > 0
    ) {
      return this.transaction(
        (tx) => tx.executeDelete(tableName, filters, options),
        options,
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const inTx = this.coordinator.isInTransaction();
      const { count, changes } = await this._executeDeleteInternal(
        tableName,
        filters,
      );
      if (!inTx && changes.length > 0) {
        const changeset = this.buildChangeset(
          this.nextAutoTxId++,
          options?.origin ?? "local",
          options?.meta,
          changes,
        );
        this.emitCommitAndSubscriptions(changeset);
      }
      return count;
    }, this.currentLeaseId ?? undefined);
  }

  private async _executeDeleteInternal(
    tableName: string,
    filters: QueryFilter[],
  ): Promise<{ count: number; changes: MutationRecord[] }> {
    const table = await this._getTableInternal(tableName);
    this.validateFilterColumns(table, filters);

    const page1View = this.pool.getSlotDataView(0);
    const indexes = catalog_list_table_indexes(page1View, table.tableId);

    const recordedChanges: MutationRecord[] = [];
    let totalDeleted = 0;

    let currPageId = table.rootPageId;
    while (currPageId !== 0) {
      const slot = await this.driver.acquirePage(currPageId);
      const view = this.pool.getSlotDataView(slot);
      const cellCount = page_get_cell_count(view, 0);
      const nextPageId = page_get_next_page_id(view, 0);

      if (cellCount > 0) {
        const allCells: Array<{ cellIdx: number; row: DbRow }> = [];
        const deletedIndices: number[] = [];

        for (let i = 0; i < cellCount; i++) {
          const off = page_get_cell_offset(view, 0, i);
          const row = page_deserialize_row(table.columns, view, off);
          allCells.push({ cellIdx: i, row });

          if (this.matchesFilters(table, row, filters)) {
            deletedIndices.push(i);
            const rec: MutationRecord = {
              table: table.name,
              op: "delete",
              pk: this.extractPrimaryKey(table, row),
              oldRow: this.cloneRow(row),
            };
            recordedChanges.push(rec);
            if (this.coordinator.isInTransaction()) {
              this.activeTxChanges.push(rec);
            }
          }
        }

        if (deletedIndices.length > 0) {
          totalDeleted += deletedIndices.length;
          await this.deleteCellsOnDataPageAndShiftIndexes(
            table,
            indexes,
            currPageId,
            deletedIndices,
            allCells,
          );
        }
      }

      currPageId = nextPageId;
    }

    if (totalDeleted === 0) {
      return { count: 0, changes: [] };
    }

    const slotIdx = catalog_find_table_slot(page1View, tableName);
    if (slotIdx !== -1) {
      const desc = catalog_read_table_descriptor(page1View, slotIdx)!;
      desc.rowCountEstimate = Math.max(0, desc.rowCountEstimate - totalDeleted);
      catalog_write_table_descriptor(page1View, slotIdx, desc);
      const cachedMeta = this.tableMetaCache.get(tableName.toLowerCase());
      if (cachedMeta) cachedMeta.rowCountEstimate = desc.rowCountEstimate;
    }
    catalog_increment_change_counter(page1View);
    catalog_update_page1_checksum(page1View);
    this.pool.markDirty(0);

    if (!this.coordinator.isInTransaction()) {
      await this.driver.flushAllDirty();
    }

    return { count: totalDeleted, changes: recordedChanges };
  }

  async upsert(
    tableName: string,
    row: DbRow,
    options?: UpsertOptions,
  ): Promise<"inserted" | "updated" | "ignored"> {
    const res = await this.upsertMany(tableName, [row], options);
    if (res.inserted > 0) return "inserted";
    if (res.updated > 0) return "updated";
    return "ignored";
  }

  async upsertMany(
    tableName: string,
    rows: DbRow[],
    options?: UpsertOptions,
  ): Promise<{ inserted: number; updated: number; ignored: number }> {
    if (!rows || rows.length === 0) {
      return { inserted: 0, updated: 0, ignored: 0 };
    }

    if (
      !this.coordinator.isInTransaction() &&
      (this.beforeCommitHooks.size > 0 || rows.length > 1)
    ) {
      return this.transaction(
        (tx) => tx._upsertManyInLease(tableName, rows, options),
        options,
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const inTx = this.coordinator.isInTransaction();
      const startChanges: MutationRecord[] = [];
      const res = await this._upsertManyInLease(
        tableName,
        rows,
        options,
        inTx ? undefined : startChanges,
      );
      if (!inTx && startChanges.length > 0) {
        const changeset = this.buildChangeset(
          this.nextAutoTxId++,
          options?.origin ?? "local",
          options?.meta,
          startChanges,
        );
        this.emitCommitAndSubscriptions(changeset);
      }
      return res;
    }, this.currentLeaseId ?? undefined);
  }

  private async _upsertManyInLease(
    tableName: string,
    rows: DbRow[],
    options?: UpsertOptions,
    standaloneCollector?: MutationRecord[],
  ): Promise<{ inserted: number; updated: number; ignored: number }> {
    const table = await this._getTableInternal(tableName);
    const validCols = new Set(table.columns.map((c) => c.name));

    let conflictCols: string[];
    if (options?.conflictTarget) {
      conflictCols = Array.isArray(options.conflictTarget)
        ? options.conflictTarget
        : [options.conflictTarget];
      for (const col of conflictCols) {
        if (!validCols.has(col)) {
          throw new ColumnNotFoundError(col, tableName);
        }
      }
    } else {
      conflictCols = table.columns
        .filter((c) => (c.flags & ColumnFlag.PRIMARY_KEY) !== 0)
        .map((c) => c.name);
      if (conflictCols.length === 0) {
        throw new Error(
          `Cannot upsert on table "${tableName}" without a primary key or explicit conflictTarget`,
        );
      }
    }

    const mode = options?.mode ?? "merge";
    let inserted = 0;
    let updated = 0;
    let ignored = 0;

    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!validCols.has(k)) {
          throw new ColumnNotFoundError(k, tableName);
        }
      }

      const hasAllConflictKeys = conflictCols.every(
        (c) => row[c] !== undefined && row[c] !== null,
      );

      let existingRow: DbRow | null = null;
      let conflictFilters: QueryFilter[] = [];

      if (hasAllConflictKeys) {
        conflictFilters = conflictCols.map((colName) => ({
          type: "cmp" as const,
          colName,
          op: "=" as const,
          value: row[colName],
        }));
        existingRow = await this.findFirstMatchingRow(table, conflictFilters);
      }

      if (!existingRow) {
        const insChanges = await this._insertManyInternal(
          tableName,
          [row],
          true,
        );
        if (standaloneCollector) {
          standaloneCollector.push(...insChanges);
        }
        inserted++;
      } else {
        if (mode === "ignore") {
          ignored++;
          continue;
        }
        if (options?.where) {
          const shouldUpdate = options.where(
            this.cloneRow(existingRow),
            this.cloneRow(row),
          );
          if (!shouldUpdate) {
            ignored++;
            continue;
          }
        }

        const patch: Partial<DbRow> = {};
        if (mode === "replace") {
          for (const c of table.columns) {
            if (row[c.name] !== undefined) {
              patch[c.name] = row[c.name];
            } else if ((c.flags & ColumnFlag.PRIMARY_KEY) !== 0) {
              patch[c.name] = existingRow[c.name];
            } else {
              patch[c.name] = null;
            }
          }
        } else {
          for (const [k, v] of Object.entries(row)) {
            if (v !== undefined) {
              patch[k] = v;
            }
          }
        }

        const { changes: updChanges } = await this._executeUpdateInternal(
          tableName,
          conflictFilters,
          patch,
        );
        if (standaloneCollector) {
          standaloneCollector.push(...updChanges);
        }
        updated++;
      }
    }

    return { inserted, updated, ignored };
  }

  private async findFirstMatchingRow(
    table: TableMeta,
    filters: QueryFilter[],
  ): Promise<DbRow | null> {
    let currPageId = table.rootPageId;
    while (currPageId !== 0) {
      const slot = await this.driver.acquirePage(currPageId);
      const view = this.pool.getSlotDataView(slot);
      const cellCount = page_get_cell_count(view, 0);
      const nextPageId = page_get_next_page_id(view, 0);

      for (let i = 0; i < cellCount; i++) {
        const off = page_get_cell_offset(view, 0, i);
        const row = page_deserialize_row(table.columns, view, off);
        if (this.matchesFilters(table, row, filters)) {
          return row;
        }
      }
      currPageId = nextPageId;
    }
    return null;
  }

  async transaction<T>(
    callback: (tx: WebDB) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const lease = await this.coordinator.begin();
    const leaseId = lease.leaseId;
    this.activeTxChanges = [];
    this.activeTxOrigin = options?.origin ?? "local";
    this.activeTxMeta = options?.meta;
    this.activeTxId = lease.txId;

    const txProxy: WebDB = new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === "currentLeaseId") {
          return leaseId;
        }
        if (prop === "transaction") {
          return async <U>(
            cb: (nestedTx: WebDB) => Promise<U>,
            _nestedOpts?: TransactionOptions,
          ): Promise<U> => {
            const savepoint = await this.coordinator.captureSavepoint();
            const savedChangesLen = this.activeTxChanges.length;
            try {
              return await cb(txProxy);
            } catch (err) {
              this.activeTxChanges.length = savedChangesLen;
              this.tableMetaCache.clear();
              this.tableTailPages.clear();
              this.indexTailPages.clear();
              await this.coordinator.restoreSavepoint(savepoint);
              throw err;
            }
          };
        }
        if (prop === "checkpoint") {
          return () => this.checkpoint();
        }
        if (prop === "from") {
          return (tableOrSubquery: string | QueryBuilder) => {
            const qb = new QueryBuilder(txProxy, tableOrSubquery);
            if (target.planner) {
              qb.withPlanner(target.planner);
            }
            return qb;
          };
        }
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return val.bind(txProxy);
        }
        return val;
      },
    });

    try {
      const res = await callback(txProxy);

      if (
        this.activeTxChanges.length > 0 &&
        this.beforeCommitHooks.size > 0 &&
        !this.isRunningBeforeCommit
      ) {
        const preCommitChangeset = this.buildChangeset(
          this.activeTxId,
          this.activeTxOrigin,
          this.activeTxMeta,
          [...this.activeTxChanges],
        );
        this.isRunningBeforeCommit = true;
        try {
          for (const hook of this.beforeCommitHooks) {
            await hook(preCommitChangeset, txProxy);
          }
        } finally {
          this.isRunningBeforeCommit = false;
        }
      }

      const finalChanges = [...this.activeTxChanges];
      const finalOrigin = this.activeTxOrigin;
      const finalMeta = this.activeTxMeta;
      const finalTxId = this.activeTxId;

      this.activeTxChanges = [];
      this.activeTxOrigin = "local";
      this.activeTxMeta = undefined;

      await this.coordinator.commit(leaseId);

      if (finalChanges.length > 0) {
        const committedChangeset = this.buildChangeset(
          finalTxId,
          finalOrigin,
          finalMeta,
          finalChanges,
        );
        this.emitCommitAndSubscriptions(committedChangeset);
      }

      return res;
    } catch (err) {
      this.activeTxChanges = [];
      this.activeTxOrigin = "local";
      this.activeTxMeta = undefined;
      this.isRunningBeforeCommit = false;
      // Clear caches so rollback doesn't leave stale cached table pointers
      this.tableMetaCache.clear();
      this.tableTailPages.clear();
      this.indexTailPages.clear();
      await this.coordinator.rollback(leaseId);
      throw err;
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

  from(tableOrSubquery: string | QueryBuilder): QueryBuilder {
    const qb = new QueryBuilder(this, tableOrSubquery);
    notifyLiveQueryTableRead(this, qb.getReferencedTables());
    return qb;
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
      planner?: QueryPlanner;
    },
  ): Promise<ExplainOutput> {
    return this.coordinator.leaseQueue.enqueue(
      () => this._explainQueryInternal(tableName, filters, options),
      this.currentLeaseId ?? undefined,
    );
  }

  private async _explainQueryInternal(
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
      planner?: QueryPlanner;
    },
  ): Promise<ExplainOutput> {
    const table = await this._getTableInternal(tableName);

    const joinPlans: JoinPlan[] = [];
    if (options?.joins && options.joins.length > 0) {
      if (1 + options.joins.length > 16) {
        throw new TooManyCursorsError(1 + options.joins.length, 16);
      }
      for (let i = 0; i < options.joins.length; i++) {
        const j = options.joins[i];
        const joinedTable = await this._getTableInternal(j.table);
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
      planner: options?.planner ?? this.planner,
    });
    const executionTables: TableMeta[] =
      (bytecode as any).allTables ??
      (joinPlans.length > 0
        ? [table, ...joinPlans.map((j) => j.table)]
        : [table]);
    const drivingTable = executionTables[0];
    const instructions = disassembleBytecode(bytecode, drivingTable);
    const assembly = formatDisassembly(instructions);
    const indexScan =
      (bytecode as any).indexScan ?? (bytecode as any).table0Scan;
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

    const decoratedJoins = options?.joins?.map((j) => {
      const scanInfo = joinedTableScans?.find(
        (s) => s.tableName.toLowerCase() === j.table.toLowerCase(),
      );
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
        table: drivingTable.name,
        rootPageId: drivingTable.rootPageId,
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
        estimatedCost: (bytecode as any).estimatedCost,
        estimatedRows: (bytecode as any).estimatedRows,
        joinOrder: (bytecode as any).joinOrder,
        isOrderSatisfied:
          (bytecode as any).isOrderSatisfied ??
          (bytecode as any).planMetrics?.isOrderSatisfied ??
          false,
        sortCostAvoided:
          (bytecode as any).planMetrics?.sortCostAvoided ?? undefined,
      },
      bytecodeSize: bytecode.byteLength,
      instructions,
      assembly,
    };
  }

  executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: QueryExecutionOptions,
  ): Promise<DbRow[]> {
    const callerTracker = getActiveLiveQueryTracker();
    const referencedTables = [
      tableName,
      ...(options.joins ? options.joins.map((j) => j.table) : []),
    ];
    notifyLiveQueryTableRead(this, referencedTables);
    const promise = this.coordinator.leaseQueue.enqueue(
      () => this._executeQueryInternal(tableName, filters, options),
      this.currentLeaseId ?? undefined,
    );
    return trackLiveQueryPromise(promise, callerTracker);
  }

  private async _executeQueryInternal(
    tableName: string,
    filters: QueryFilter[],
    options: QueryExecutionOptions,
  ): Promise<DbRow[]> {
    const table = await this._getTableInternal(tableName);

    const joinedTablesMeta: TableMeta[] = [];
    const joinPlans: JoinPlan[] = [];
    if (options.joins && options.joins.length > 0) {
      if (1 + options.joins.length > 16) {
        throw new TooManyCursorsError(1 + options.joins.length, 16);
      }
      for (let i = 0; i < options.joins.length; i++) {
        const j = options.joins[i];
        const joinedTable = await this._getTableInternal(j.table);
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

    let orderBy = options.orderBy;
    if (!orderBy && options.sortCol) {
      orderBy = [{ colName: options.sortCol, direction: options.sortDir }];
    }

    const hasUdfs = this.udfs.size > 0;
    const plan: QueryPlan = {
      table,
      joinedTables: joinPlans.length > 0 ? joinPlans : undefined,
      filters,
      orderBy,
      groupBy: options.groupBy,
      aggregates: options.aggregates,
      having: options.having,
      selectExprs: options.selectExprs,
      udfNameMap: hasUdfs ? this.getUdfMap() : undefined,
      udfDefs: hasUdfs ? this.getUdfDefs() : undefined,
      limit: options.limit !== null ? options.limit : undefined,
      offset: options.offset !== null ? options.offset : undefined,
      planner: options.planner ?? this.planner,
    };

    const bytecode = compileQuery(plan);

    const executionTables: TableMeta[] = (bytecode as any).allTables ?? [
      table,
      ...joinedTablesMeta,
    ];

    resetVmContext(this.vmCtx, executionTables[0], executionTables);
    if ((bytecode as any).inSets) {
      this.vmCtx.inSets = (bytecode as any).inSets;
    }
    const keyInfos = (bytecode as any).keyInfos ?? plan.keyInfos;
    if (keyInfos) {
      this.vmCtx.keyInfos = keyInfos;
    }

    if (hasUdfs) {
      const udfsRecord: Record<number, (...args: any[]) => any> = {};
      for (const entry of this.udfs.values()) {
        udfsRecord[entry.id] = entry.def.call;
      }
      this.vmCtx.udfs = udfsRecord;
    } else {
      this.vmCtx.udfs = undefined;
    }

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
            typeof gItem === "string"
              ? gItem
              : (gItem.colName ??
                (gItem.expr ? deriveDefaultAlias(gItem.expr) : "group_key"));
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
            agg.alias ??
            (agg.colName ? `${agg.func}_${agg.colName}` : agg.func);
          const aggType =
            agg.func === "count" ? DataType.INT32 : DataType.FLOAT64;
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
    const stepFn = this.wasmCore ? this.wasmCore.vm_step : vm_step;
    while (true) {
      const status = stepFn(this.vmCtx, this.pool.view, bytecode);

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
        this.vmCtx.resultOffset = 0;
        this.vmCtx.resultCount = 0;
        // Temporarily pin any currently resident active cursor pages so acquiring fault_page_id
        // does not evict the page a cursor is actively transitioning from.
        const pinnedCursorSlots: number[] = [];
        const cursors = this.vmCtx.cursors ?? [this.vmCtx.cursor];
        for (const c of cursors) {
          if (c && c.pageId > 1) {
            const s = this.pool.getResidentSlot(c.pageId);
            if (s > 0) {
              this.pool.pinSlot(s);
              pinnedCursorSlots.push(s);
            }
          }
        }
        try {
          await this.driver.acquirePage(this.vmCtx.fault_page_id);
        } finally {
          for (const s of pinnedCursorSlots) {
            this.pool.unpinSlot(s);
          }
        }
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

    Object.defineProperty(rows, "isOrderSatisfied", {
      value: (bytecode as any).isOrderSatisfied ?? false,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    return rows;
  }

  /**
   * Deduplicated Monotonic Checkpointing (Section 4.3):
   * Replays committed WAL frames and resident memory slots to main storage,
   * flushes main storage, and truncates WAL to 0.
   */
  async checkpoint(): Promise<{ pagesWritten: number }> {
    return this.coordinator.checkpoint();
  }

  /**
   * Exports the entire database as a self-contained binary image (totalPages * 4096 bytes)
   * with verified IEEE 802.3 CRC32 checksums on every page.
   */
  async exportBinary(): Promise<Uint8Array> {
    return this.coordinator.leaseQueue.enqueue(async () => {
      if (!this.coordinator.isInTransaction()) {
        await this.coordinator.executeCheckpoint();
        await this.driver.flushAllDirty();
      }

      const page1View = this.pool.getSlotDataView(0);
      const totalPages = catalog_get_total_pages(page1View);
      const out = new Uint8Array(totalPages * PAGE_SIZE);

      // Copy Page 1 from Slot 0 and stamp valid Page 1 CRC32 checksum
      out.set(this.pool.getPageBytesInSlot(0), 0);
      const outPage1View = new DataView(out.buffer, out.byteOffset, PAGE_SIZE);
      catalog_update_page1_checksum(outPage1View, 0);

      // Copy Pages 2..totalPages
      const missingPageIds: number[] = [];
      for (let p = 2; p <= totalPages; p++) {
        if (
          this.pool.getResidentSlot(p) === -1 &&
          !this.coordinator.hasSpilledPage(p)
        ) {
          missingPageIds.push(p);
        }
      }
      const diskPages =
        missingPageIds.length > 0
          ? await this.vfs.readPages(missingPageIds)
          : [];
      const diskPageMap = new Map<number, Uint8Array | null>();
      for (let i = 0; i < missingPageIds.length; i++) {
        diskPageMap.set(missingPageIds[i], diskPages[i] ?? null);
      }

      for (let p = 2; p <= totalPages; p++) {
        const offset = (p - 1) * PAGE_SIZE;
        const slice = out.subarray(offset, offset + PAGE_SIZE);
        const residentSlot = this.pool.getResidentSlot(p);

        if (residentSlot !== -1) {
          slice.set(this.pool.getPageBytesInSlot(residentSlot));
        } else if (this.coordinator.hasSpilledPage(p)) {
          slice.set(this.coordinator.getSpilledPage(p)!);
        } else {
          const diskPage = diskPageMap.get(p);
          if (diskPage) {
            slice.set(diskPage);
          }
        }

        // Stamp CRC32 checksum at page header offset 12..15
        const chk = computePageChecksum(slice);
        new DataView(slice.buffer, slice.byteOffset, PAGE_SIZE).setUint32(
          12,
          chk,
          true,
        );
      }

      return out;
    }, this.currentLeaseId ?? undefined);
  }

  /**
   * Validates and atomically imports a binary WebDB database image (totalPages * 4096 bytes),
   * replacing all pages, resetting the WAL, and pinning the imported schema catalog.
   */
  async importBinary(data: Uint8Array | ArrayBuffer): Promise<void> {
    if (this.coordinator.isInTransaction()) {
      throw new Error(
        "Cannot import binary database while a transaction is active",
      );
    }

    return this.coordinator.leaseQueue.enqueue(async () => {
      const bytes =
        data instanceof Uint8Array
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);

      // Pass 1: Pre-validate binary image size, Page 1 header, magic bytes, version, and all page CRC32 checksums
      if (bytes.byteLength < PAGE_SIZE || bytes.byteLength % PAGE_SIZE !== 0) {
        throw new InvalidDatabaseError(
          `Invalid database binary size (${bytes.byteLength} bytes): must be a non-zero multiple of ${PAGE_SIZE} bytes`,
        );
      }

      const numPages = bytes.byteLength / PAGE_SIZE;
      const page1Slice = bytes.subarray(0, PAGE_SIZE);
      const page1View = new DataView(
        page1Slice.buffer,
        page1Slice.byteOffset,
        PAGE_SIZE,
      );

      const header = catalog_read_page1_header(page1View, true);
      if (header.pageSize !== PAGE_SIZE) {
        throw new InvalidDatabaseError(
          `Invalid database page size ${header.pageSize} (expected ${PAGE_SIZE})`,
        );
      }
      if (header.totalPages !== numPages) {
        throw new InvalidDatabaseError(
          `Database page count mismatch: header specifies ${header.totalPages} pages, but binary image contains ${numPages} pages`,
        );
      }

      for (let p = 2; p <= numPages; p++) {
        const offset = (p - 1) * PAGE_SIZE;
        const pageSlice = bytes.subarray(offset, offset + PAGE_SIZE);
        const view = new DataView(
          pageSlice.buffer,
          pageSlice.byteOffset,
          PAGE_SIZE,
        );
        const storedChk = view.getUint32(12, true);
        if (storedChk !== 0) {
          const computedChk = computePageChecksum(pageSlice);
          if (computedChk !== storedChk) {
            throw new CorruptPageError(p, storedChk, computedChk);
          }
        }
      }

      // Capture pre-import table names for change notifications
      const oldPage1View = this.pool.getSlotDataView(0);
      const oldTables = catalog_list_table_descriptors(oldPage1View).map(
        (d) => d.name,
      );

      // Pass 2: Atomically replace storage, reset buffer pool & WAL, and pin imported catalog pages
      const pagesToWrite: Array<{ pageId: number; data: Uint8Array }> = [];
      for (let p = 1; p <= numPages; p++) {
        const offset = (p - 1) * PAGE_SIZE;
        pagesToWrite.push({
          pageId: p,
          data: bytes.subarray(offset, offset + PAGE_SIZE).slice(),
        });
      }

      for (let slot = 1; slot < this.pool.slotCount; slot++) {
        this.pool.forceUnpinSlot(slot);
        this.pool.unassignSlot(slot);
        this.pool.clearDirty(slot);
        this.pool.getPageBytesInSlot(slot).fill(0);
      }

      this.pool.getPageBytesInSlot(0).set(pagesToWrite[0].data);
      this.pool.clearDirty(0);

      await this.vfs.writePages(pagesToWrite);
      await this.vfs.flush?.();
      await this.coordinator.resetWalAfterImport();

      this.tableMetaCache.clear();
      this.tableTailPages.clear();
      this.indexTailPages.clear();
      this.vmCtx.table = null;

      await WebDB.pinAllCatalogPages(this.driver);

      const newPage1View = this.pool.getSlotDataView(0);
      const newTables = catalog_list_table_descriptors(newPage1View).map(
        (d) => d.name,
      );
      const affectedTables = Array.from(new Set([...oldTables, ...newTables]));

      this.notifySubscriptions({
        tables: affectedTables,
        origin: "import",
        changeCounter: header.changeCounter,
        schemaVersion: header.schemaVersion,
        crossTab: false,
      });

      if (this.broadcastChannel) {
        try {
          this.broadcastChannel.postMessage({
            senderId: this.instanceId,
            tables: affectedTables,
            origin: "import",
            changeCounter: header.changeCounter,
            schemaVersion: header.schemaVersion,
          });
        } catch {
          // Ignore broadcast errors
        }
      }
    });
  }

  async close(): Promise<void> {
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
    this.beforeCommitHooks.clear();
    this.commitHooks.clear();
    this.subscriptions.clear();
    await this.coordinator.close();
    await this.driver.flushAllDirty();
    await this.vfs.close?.();
  }
}
