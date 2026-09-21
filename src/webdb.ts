import {
  PAGE_SIZE,
  DEFAULT_PAGE_SLOTS,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  TOTAL_MEMORY_BYTES,
} from './constants.js';
import {
  ColumnDefinition,
  TableMeta,
  DbRow,
  TableNotFoundError,
} from './types.js';
import { IVfsAdapter } from './storage/vfs.js';
import { MemoryVfsAdapter } from './storage/memory.js';
import { IndexedDbVfsAdapter } from './storage/idb.js';
import {
  initPage1,
  readPage1Header,
  getTotalPages,
  setTotalPages,
  findTableByName,
  addTableToCatalog,
} from './engine/catalog.js';
import {
  initPage,
  insertRowIntoPage,
  getNextPageId,
  setNextPageId,
  serializeRow,
  deserializeRow,
} from './engine/page.js';
import {
  createVmContext,
  resetVmContext,
  vm_step,
  VmContext,
} from './engine/vm.js';
import {
  compileQuery,
  ComparisonOp,
  QueryFilter,
} from './engine/compiler.js';

export interface WebDbOptions {
  name: string;
  storage?: 'memory' | 'idb';
}

export class QueryBuilder {
  private db: WebDB;
  private tableName: string;
  private filters: QueryFilter[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private sortCol: string | null = null;
  private sortDir: 'asc' | 'desc' = 'asc';

  constructor(db: WebDB, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  where(colName: string, op: ComparisonOp, value: any): this {
    this.filters.push({ type: 'cmp', colName, op, value });
    return this;
  }

  whereNull(colName: string): this {
    this.filters.push({ type: 'null', colName, isNull: true });
    return this;
  }

  whereNotNull(colName: string): this {
    this.filters.push({ type: 'null', colName, isNull: false });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  orderBy(colName: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.sortCol = colName;
    this.sortDir = direction;
    return this;
  }

  async toArray(): Promise<DbRow[]> {
    return this.db.executeQuery(this.tableName, this.filters, {
      limit: this.limitCount,
      offset: this.offsetCount,
      sortCol: this.sortCol,
      sortDir: this.sortDir,
    });
  }
}

export class WebDB {
  private vfs: IVfsAdapter;
  private buffer: ArrayBuffer;
  private view: DataView;
  private vmCtx: VmContext;

  private constructor(vfs: IVfsAdapter, buffer: ArrayBuffer) {
    this.vfs = vfs;
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.vmCtx = createVmContext();
  }

  static async open(options: WebDbOptions): Promise<WebDB> {
    const storageType = options.storage || 'memory';
    const vfs = storageType === 'idb'
      ? new IndexedDbVfsAdapter(options.name)
      : new MemoryVfsAdapter();

    const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
    const view = new DataView(buffer);

    // Read Page 1 from VFS
    const page1Data = await vfs.readPage(1);
    if (!page1Data) {
      // New database: initialize Page 1
      initPage1(view);
      const initialPage1 = new Uint8Array(buffer, 0, PAGE_SIZE);
      await vfs.writePage(1, initialPage1);
    } else {
      // Existing database: copy Page 1 into memory
      new Uint8Array(buffer, 0, PAGE_SIZE).set(page1Data);
      readPage1Header(view);

      // Load existing pages into buffer
      const totalPages = getTotalPages(view);
      for (let p = 2; p <= totalPages; p++) {
        const pageData = await vfs.readPage(p);
        if (pageData) {
          new Uint8Array(buffer, (p - 1) * PAGE_SIZE, PAGE_SIZE).set(pageData);
        }
      }
    }

    return new WebDB(vfs, buffer);
  }

  async createTable(name: string, columns: ColumnDefinition[]): Promise<TableMeta> {
    const page1View = new DataView(this.buffer, 0, PAGE_SIZE);
    const totalPages = getTotalPages(page1View);

    // Allocate root page for this table
    const rootPageId = totalPages + 1;
    setTotalPages(page1View, rootPageId);

    // Initialize the root page (Leaf Data Page)
    const rootPageOffset = (rootPageId - 1) * PAGE_SIZE;
    initPage(this.view, rootPageOffset);

    // Add table to Page 1 catalog
    const table = addTableToCatalog(page1View, name, columns, rootPageId);

    // Flush modified pages to storage
    await this.vfs.writePage(1, new Uint8Array(this.buffer, 0, PAGE_SIZE));
    await this.vfs.writePage(rootPageId, new Uint8Array(this.buffer, rootPageOffset, PAGE_SIZE));

    return table;
  }

  async insert(tableName: string, row: DbRow): Promise<void> {
    const page1View = new DataView(this.buffer, 0, PAGE_SIZE);
    const table = findTableByName(page1View, tableName);
    if (!table) {
      throw new TableNotFoundError(tableName);
    }

    const rowBytes = serializeRow(table, row);

    // Find active page for this table (navigate next_page_id link to tail)
    let currentPageId = table.rootPageId;
    let pageOffset = (currentPageId - 1) * PAGE_SIZE;

    while (true) {
      const nextPageId = getNextPageId(this.view, pageOffset);
      if (nextPageId === 0) break;
      currentPageId = nextPageId;
      pageOffset = (currentPageId - 1) * PAGE_SIZE;
    }

    // Attempt insertion into current page
    let slot = insertRowIntoPage(this.view, pageOffset, rowBytes);
    let dirtyPages = [currentPageId];

    if (slot === -1) {
      // Current page is full: allocate a new page
      const totalPages = getTotalPages(page1View);
      const newPageId = totalPages + 1;
      setTotalPages(page1View, newPageId);

      const newPageOffset = (newPageId - 1) * PAGE_SIZE;
      initPage(this.view, newPageOffset);

      // Link current page -> new page
      setNextPageId(this.view, pageOffset, newPageId);

      // Insert row into new page
      slot = insertRowIntoPage(this.view, newPageOffset, rowBytes);
      if (slot === -1) {
        throw new Error('Unexpected error: row does not fit in empty page');
      }

      dirtyPages = [1, currentPageId, newPageId];
    }

    // Persist dirty pages via VFS
    for (const pId of dirtyPages) {
      const offset = (pId - 1) * PAGE_SIZE;
      await this.vfs.writePage(pId, new Uint8Array(this.buffer, offset, PAGE_SIZE));
    }
  }

  from(tableName: string): QueryBuilder {
    return new QueryBuilder(this, tableName);
  }

  async executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: {
      limit: number | null;
      offset: number | null;
      sortCol: string | null;
      sortDir: 'asc' | 'desc';
    }
  ): Promise<DbRow[]> {
    const page1View = new DataView(this.buffer, 0, PAGE_SIZE);
    const table = findTableByName(page1View, tableName);
    if (!table) {
      throw new TableNotFoundError(tableName);
    }

    const bytecode = compileQuery({ table, filters });

    resetVmContext(this.vmCtx, table);
    vm_step(this.vmCtx, this.view, bytecode);

    // Hydrate rows from Output Result Buffer
    let rows: DbRow[] = [];
    let currentOffset = 0;

    for (let i = 0; i < this.vmCtx.resultCount; i++) {
      const rowLen = this.view.getUint16(RESULT_BUFFER_OFFSET + currentOffset, true);
      const rowOffset = RESULT_BUFFER_OFFSET + currentOffset + 2;

      const record = deserializeRow(this.view, rowOffset, table);
      rows.push(record);

      currentOffset += 2 + rowLen;
    }

    // Apply Sorting with SQLite-compatible NULL handling:
    // Collation rule: NULL is smaller than any other value!
    if (options.sortCol) {
      const col = options.sortCol;
      const asc = options.sortDir === 'asc';

      rows.sort((a, b) => {
        const valA = a[col];
        const valB = b[col];

        if (valA === valB) return 0;
        if (valA === null || valA === undefined) return asc ? -1 : 1;
        if (valB === null || valB === undefined) return asc ? 1 : -1;

        if (typeof valA === 'number' && typeof valB === 'number') {
          return asc ? valA - valB : valB - valA;
        }
        if (typeof valA === 'string' && typeof valB === 'string') {
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return (valA as any) > (valB as any) ? (asc ? 1 : -1) : (asc ? -1 : 1);
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
    await this.vfs.close();
  }
}
