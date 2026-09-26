import {
  PAGE_SIZE,
  FILE_HEADER_SIZE,
  MASTER_TABLE_OFFSET,
  MAX_TABLES_PAGE1,
  TABLE_DESCRIPTOR_SIZE,
  INDEX_CATALOG_OFFSET,
  MAX_INDEXES_PAGE1,
  INDEX_DESCRIPTOR_SIZE,
  CATALOG_PAGE_HEADER_SIZE,
  COLUMN_META_SIZE,
  MAX_COLUMNS_PER_CATALOG_PAGE,
  MAX_COLUMNS_PER_TABLE,
  MAX_NAME_LENGTH,
  HEADER_OFFSET_MAGIC,
  HEADER_OFFSET_PAGE_SIZE,
  HEADER_OFFSET_FILE_FORMAT_VERSION,
  HEADER_OFFSET_MIN_READ_VERSION,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_SCHEMA_VERSION,
  HEADER_OFFSET_CHANGE_COUNTER,
  HEADER_OFFSET_PAGE_CHECKSUM,
  HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  HEADER_OFFSET_RESERVED,
  CURRENT_ENGINE_VERSION,
  CURRENT_MIN_READ_VERSION,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_FREE,
} from "../constants.js";

import {
  DataType,
  ColumnFlag,
  TableFlag,
  IndexFlag,
  ColumnDefinition,
  ColumnMeta,
  TableDescriptor,
  IndexDescriptor,
  CatalogPageHeader,
  TableMeta,
  TableAlreadyExistsError,
  TableNotFoundError,
  TooManyColumnsError,
  TooManyTablesError,
  TooManyIndexesError,
  UnsupportedFormatVersionError,
  InvalidDatabaseError,
  CorruptPageError,
} from "../types.js";

import { computePage1Checksum, computePageChecksum } from "../storage/crc32.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const MAGIC_BYTES = new Uint8Array([0x57, 0x45, 0x42, 0x44, 0x42, 0x00]); // "WEBDB\0"

// ============================================================================
// 1. Page 1 File Header Operations
// ============================================================================

export function initPage1(view: DataView): void {
  // 1. Magic bytes (one-shot copy via Uint8Array.set / memcpy)
  new Uint8Array(view.buffer, view.byteOffset + HEADER_OFFSET_MAGIC, MAGIC_BYTES.byteLength).set(MAGIC_BYTES);

  // 2. Page size (4096)
  view.setUint16(HEADER_OFFSET_PAGE_SIZE, PAGE_SIZE, true);

  // 3. File format version
  view.setUint16(
    HEADER_OFFSET_FILE_FORMAT_VERSION,
    CURRENT_ENGINE_VERSION,
    true,
  );

  // 4. Min read version
  view.setUint16(
    HEADER_OFFSET_MIN_READ_VERSION,
    CURRENT_MIN_READ_VERSION,
    true,
  );

  // 5. Total pages (Page 1 is allocated)
  view.setUint32(HEADER_OFFSET_TOTAL_PAGES, 1, true);

  // 6. Free page head pointer (0 = empty list)
  view.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, 0, true);

  // 7. Schema version (1)
  view.setUint32(HEADER_OFFSET_SCHEMA_VERSION, 1, true);

  // 8. Change counter (0)
  view.setUint32(HEADER_OFFSET_CHANGE_COUNTER, 0, true);

  // 9. Page checksum (calculated on flush)
  view.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, 0, true);

  // 10. Chained catalog pointers (always 0 in v1; reserved for overflow catalog pages in future versions)
  view.setUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, 0, true);
  view.setUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, 0, true);

  // Clear reserved header bytes (40..99)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, HEADER_OFFSET_RESERVED, FILE_HEADER_SIZE);

  // Clear Catalog area (bytes 100..4095)
  uint8.fill(0, MASTER_TABLE_OFFSET, PAGE_SIZE);

  // Set initial valid checksum for Page 1
  const chk = computePage1Checksum(
    new Uint8Array(view.buffer, view.byteOffset, PAGE_SIZE),
  );

  view.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, chk, true);
}

export function readPage1Header(
  view: DataView,
  verifyChecksum: boolean = false,
) {
  // 1. Validate magic bytes
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (view.getUint8(HEADER_OFFSET_MAGIC + i) !== MAGIC_BYTES[i]) {
      throw new InvalidDatabaseError(
        "Invalid database file: magic bytes mismatch",
      );
    }
  }

  const pageSize = view.getUint16(HEADER_OFFSET_PAGE_SIZE, true);
  const fileFormatVersion = view.getUint16(
    HEADER_OFFSET_FILE_FORMAT_VERSION,
    true,
  );
  const minReadVersion = view.getUint16(HEADER_OFFSET_MIN_READ_VERSION, true);
  const totalPages = view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
  const freePageHead = view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
  const schemaVersion = view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
  const changeCounter = view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
  const storedChecksum = view.getUint32(HEADER_OFFSET_PAGE_CHECKSUM, true);

  // 2. Fail-fast version handshake
  if (minReadVersion > CURRENT_ENGINE_VERSION) {
    throw new UnsupportedFormatVersionError(
      `Database file format requires engine version >= ${minReadVersion}, but running engine is version ${CURRENT_ENGINE_VERSION}`,
    );
  }

  // 3. Optional checksum verification on load
  if (verifyChecksum && storedChecksum !== 0) {
    const pageBytes = new Uint8Array(view.buffer, view.byteOffset, PAGE_SIZE);
    const computed = computePage1Checksum(pageBytes);
    if (computed !== storedChecksum) {
      throw new CorruptPageError(1, storedChecksum, computed);
    }
  }

  return {
    pageSize,
    fileFormatVersion,
    minReadVersion,
    totalPages,
    freePageHead,
    schemaVersion,
    changeCounter,
    storedChecksum,
  };
}

export function getTotalPages(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
}

export function setTotalPages(view: DataView, count: number): void {
  view.setUint32(HEADER_OFFSET_TOTAL_PAGES, count, true);
}

export function getFreePageHead(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
}

export function setFreePageHead(view: DataView, pageId: number): void {
  view.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, pageId, true);
}

export function getSchemaVersion(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
}

export function incrementSchemaVersion(view: DataView): number {
  const v = getSchemaVersion(view) + 1;
  view.setUint32(HEADER_OFFSET_SCHEMA_VERSION, v, true);
  return v;
}

export function getChangeCounter(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
}

export function incrementChangeCounter(view: DataView): number {
  const c = getChangeCounter(view) + 1;
  view.setUint32(HEADER_OFFSET_CHANGE_COUNTER, c, true);
  return c;
}

export function updatePage1Checksum(view: DataView): number {
  const chk = computePage1Checksum(
    new Uint8Array(view.buffer, view.byteOffset, PAGE_SIZE),
  );
  view.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, chk, true);
  return chk;
}

// ============================================================================
// 2. Fixed String Helper Functions
// ============================================================================

export function writeFixedString(
  view: DataView,
  offset: number,
  str: string,
  maxLen: number,
): void {
  const bytes = textEncoder.encode(str);
  for (let i = 0; i < maxLen; i++) {
    view.setUint8(offset + i, i < bytes.length ? bytes[i] : 0);
  }
}

export function readFixedString(
  view: DataView,
  offset: number,
  maxLen: number,
): string {
  const bytes: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

export function parseDataType(typeStr: string): DataType {
  switch (typeStr.toUpperCase()) {
    case "INT32":
      return DataType.INT32;
    case "INT64":
      return DataType.INT64;
    case "FLOAT64":
      return DataType.FLOAT64;
    case "TEXT":
      return DataType.TEXT;
    case "BLOB":
      return DataType.BLOB;
    case "UUID":
      return DataType.UUID;
    case "ULID":
      return DataType.ULID;
    default:
      throw new Error(`Unsupported column data type: "${typeStr}"`);
  }
}

// ============================================================================
// 3. Table Descriptor & Master Table Accessors (Page 1)
// ============================================================================

/**
 * Reads a TableDescriptor from Page 1 by slot index (0..15).
 */
export function readTableDescriptor(
  view: DataView,
  slotIdx: number,
): TableDescriptor | null {
  const offset = MASTER_TABLE_OFFSET + slotIdx * TABLE_DESCRIPTOR_SIZE;
  const tableId = view.getUint16(offset + 0, true);
  if (tableId === 0) return null;

  const columnCount = view.getUint16(offset + 2, true);
  const rootPageId = view.getUint32(offset + 4, true);
  const colCatalogPageId = view.getUint32(offset + 8, true);
  const name = readFixedString(view, offset + 12, MAX_NAME_LENGTH);
  const flags = view.getUint32(offset + 76, true);
  const rowCountEstimate = view.getUint32(offset + 80, true);
  const autoIncNext = view.getBigUint64(offset + 84, true);

  return {
    tableId,
    columnCount,
    rootPageId,
    colCatalogPageId,
    name,
    flags,
    rowCountEstimate,
    autoIncNext,
  };
}

/**
 * Writes a TableDescriptor into Page 1 at the specified slot index (0..15).
 */
export function writeTableDescriptor(
  view: DataView,
  slotIdx: number,
  desc: TableDescriptor,
): void {
  const offset = MASTER_TABLE_OFFSET + slotIdx * TABLE_DESCRIPTOR_SIZE;
  view.setUint16(offset + 0, desc.tableId, true);
  view.setUint16(offset + 2, desc.columnCount, true);
  view.setUint32(offset + 4, desc.rootPageId, true);
  view.setUint32(offset + 8, desc.colCatalogPageId, true);
  writeFixedString(view, offset + 12, desc.name, MAX_NAME_LENGTH);
  view.setUint32(offset + 76, desc.flags, true);
  view.setUint32(offset + 80, desc.rowCountEstimate, true);
  view.setBigUint64(offset + 84, desc.autoIncNext, true);
  // Clear reserved 36 bytes (92..127)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, offset + 92, offset + TABLE_DESCRIPTOR_SIZE);
}

export function findTableByName(
  view: DataView,
  tableName: string,
): TableDescriptor | null {
  const slot = findTableSlot(view, tableName);
  return slot !== -1 ? readTableDescriptor(view, slot) : null;
}

/**
 * Finds the slot index of an existing table by name, or -1 if not found.
 */
export function findTableSlot(view: DataView, tableName: string): number {
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const desc = readTableDescriptor(view, i);
    if (
      desc &&
      (desc.flags & TableFlag.ACTIVE) !== 0 &&
      desc.name === tableName
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Finds the first free slot index in Page 1's TableDescriptor array.
 */
export function findFreeTableSlot(view: DataView): number {
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const desc = readTableDescriptor(view, i);
    if (!desc || (desc.flags & TableFlag.ACTIVE) === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Lists all active tables defined on Page 1.
 */
export function listTableDescriptors(view: DataView): TableDescriptor[] {
  const tables: TableDescriptor[] = [];
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const desc = readTableDescriptor(view, i);
    if (desc && (desc.flags & TableFlag.ACTIVE) !== 0) {
      tables.push(desc);
    }
  }
  return tables;
}

// ============================================================================
// 4. Index Descriptor Accessors (Page 1: bytes 2148..3171)
// ============================================================================

export function readIndexDescriptor(
  view: DataView,
  slotIdx: number,
): IndexDescriptor | null {
  const offset = INDEX_CATALOG_OFFSET + slotIdx * INDEX_DESCRIPTOR_SIZE;
  const indexId = view.getUint16(offset + 0, true);

  if (indexId === 0) return null;

  const tableId = view.getUint16(offset + 2, true);
  const rootPageId = view.getUint32(offset + 4, true);
  const columnCount = view.getUint8(offset + 8);
  const flags = view.getUint8(offset + 9);

  const columnIndices: number[] = [];

  for (let i = 0; i < 8; i++) {
    columnIndices.push(view.getUint16(offset + 10 + i * 2, true));
  }

  const colDirections: number[] = [];

  for (let i = 0; i < 8; i++) {
    colDirections.push(view.getUint8(offset + 26 + i));
  }

  const name = readFixedString(view, offset + 34, MAX_NAME_LENGTH);

  return {
    indexId,
    tableId,
    rootPageId,
    columnCount,
    flags,
    columnIndices,
    colDirections,
    name,
  };
}

export function writeIndexDescriptor(
  view: DataView,
  slotIdx: number,
  desc: IndexDescriptor,
): void {
  const offset = INDEX_CATALOG_OFFSET + slotIdx * INDEX_DESCRIPTOR_SIZE;

  view.setUint16(offset + 0, desc.indexId, true);
  view.setUint16(offset + 2, desc.tableId, true);
  view.setUint32(offset + 4, desc.rootPageId, true);
  view.setUint8(offset + 8, desc.columnCount);
  view.setUint8(offset + 9, desc.flags);

  for (let i = 0; i < 8; i++) {
    view.setUint16(offset + 10 + i * 2, desc.columnIndices[i] ?? 0, true);
  }

  for (let i = 0; i < 8; i++) {
    view.setUint8(offset + 26 + i, desc.colDirections[i] ?? 0);
  }

  writeFixedString(view, offset + 34, desc.name, MAX_NAME_LENGTH);

  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, offset + 98, offset + INDEX_DESCRIPTOR_SIZE);
}

// ============================================================================
// 5. Dedicated Column Catalog Pages (page_type = 0x0C)
// ============================================================================

/**
 * Initializes a 4KB dedicated column catalog page.
 */
export function initCatalogPage(
  view: DataView,
  pageOffset: number,
  tableId: number,
  startColIndex: number,
  nextColCatalogPageId: number = 0,
): void {
  view.setUint8(pageOffset + 0, PAGE_TYPE_CATALOG_PAGE);
  view.setUint8(pageOffset + 1, 0); // flags
  view.setUint16(pageOffset + 2, 0, true); // col_count_in_page = 0
  view.setUint16(pageOffset + 4, tableId, true);
  view.setUint16(pageOffset + 6, startColIndex, true);
  view.setUint32(pageOffset + 8, nextColCatalogPageId, true);
  view.setUint32(pageOffset + 12, 0, true); // checksum

  // Zero payload area (16..4095)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, pageOffset + CATALOG_PAGE_HEADER_SIZE, pageOffset + PAGE_SIZE);
}

export function readCatalogPageHeader(
  view: DataView,
  pageOffset: number,
): CatalogPageHeader {
  return {
    pageType: view.getUint8(pageOffset + 0),
    flags: view.getUint8(pageOffset + 1),
    colCountInPage: view.getUint16(pageOffset + 2, true),
    tableId: view.getUint16(pageOffset + 4, true),
    startColIndex: view.getUint16(pageOffset + 6, true),
    nextColCatalogPageId: view.getUint32(pageOffset + 8, true),
    pageChecksum: view.getUint32(pageOffset + 12, true),
  };
}

export function writeCatalogPageHeader(
  view: DataView,
  pageOffset: number,
  header: CatalogPageHeader,
): void {
  view.setUint8(pageOffset + 0, header.pageType);
  view.setUint8(pageOffset + 1, header.flags);
  view.setUint16(pageOffset + 2, header.colCountInPage, true);
  view.setUint16(pageOffset + 4, header.tableId, true);
  view.setUint16(pageOffset + 6, header.startColIndex, true);
  view.setUint32(pageOffset + 8, header.nextColCatalogPageId, true);
  view.setUint32(pageOffset + 12, header.pageChecksum, true);
}

/**
 * Writes a ColumnMeta entry (72 bytes) into a catalog page at inPageSlot (0..55).
 */
export function writeColumnMeta(
  view: DataView,
  pageOffset: number,
  inPageSlot: number,
  meta: ColumnMeta,
): void {
  if (inPageSlot < 0 || inPageSlot >= MAX_COLUMNS_PER_CATALOG_PAGE) {
    throw new Error(`Invalid catalog in-page slot ${inPageSlot}`);
  }

  const offset =
    pageOffset + CATALOG_PAGE_HEADER_SIZE + inPageSlot * COLUMN_META_SIZE;
  view.setUint8(offset + 0, meta.type);
  view.setUint8(offset + 1, meta.flags);
  view.setUint16(offset + 2, meta.colOffset, true);
  writeFixedString(view, offset + 4, meta.name, MAX_NAME_LENGTH);
  // Clear _reserved[4] at 68..71
  view.setUint32(offset + 68, 0, true);
}

/**
 * Reads a ColumnMeta entry (72 bytes) from a catalog page at inPageSlot (0..55).
 */
export function readColumnMeta(
  view: DataView,
  pageOffset: number,
  inPageSlot: number,
): ColumnMeta {
  const offset =
    pageOffset + CATALOG_PAGE_HEADER_SIZE + inPageSlot * COLUMN_META_SIZE;
  const type = view.getUint8(offset + 0) as DataType;
  const flags = view.getUint8(offset + 1);
  const colOffset = view.getUint16(offset + 2, true);
  const name = readFixedString(view, offset + 4, MAX_NAME_LENGTH);

  return { type, flags, colOffset, name };
}

/**
 * Calculates cross-page column mapping:
 * page_chain_idx = floor(col_idx / 56)
 * col_idx_in_page = col_idx % 56
 */
export function mapColumnIndexToCatalogLocation(colIdx: number): {
  pageChainIdx: number;
  colIdxInPage: number;
} {
  return {
    pageChainIdx: Math.floor(colIdx / MAX_COLUMNS_PER_CATALOG_PAGE),
    colIdxInPage: colIdx % MAX_COLUMNS_PER_CATALOG_PAGE,
  };
}

// ============================================================================
// 6. Schema DDL & Metadata Assembler
// ============================================================================

export interface IPageProvider {
  allocateNewPage(): number;
  getPageBytes(pageId: number): Uint8Array;
  markPageDirty(pageId: number): void;
}

/**
 * Creates a new table, allocating a root data page and dedicated column catalog page(s).
 */
export function createTable(
  page1View: DataView,
  pager: IPageProvider,
  name: string,
  columnsDef: ColumnDefinition[],
): TableMeta {
  if (columnsDef.length === 0) {
    throw new Error("Table must have at least one column");
  }

  if (columnsDef.length > MAX_COLUMNS_PER_TABLE) {
    throw new TooManyColumnsError(columnsDef.length, MAX_COLUMNS_PER_TABLE);
  }

  // Check if table already exists
  if (findTableSlot(page1View, name) !== -1) {
    throw new TableAlreadyExistsError(name);
  }

  // Find free slot in Page 1 TableDescriptor slots
  const slotIdx = findFreeTableSlot(page1View);

  if (slotIdx === -1) {
    throw new TooManyTablesError(MAX_TABLES_PAGE1, MAX_TABLES_PAGE1);
  }

  const tableId = slotIdx + 1;
  const rootPageId = pager.allocateNewPage();

  // Initialize the table's root leaf data page (0x0D)
  const rootBytes = pager.getPageBytes(rootPageId);
  const rootView = new DataView(rootBytes.buffer, rootBytes.byteOffset);
  rootView.setUint8(0, 0x0d); // PAGE_TYPE_LEAF_DATA
  rootView.setUint8(1, 0);
  rootView.setUint16(2, 0, true); // cell_count = 0
  rootView.setUint16(4, PAGE_SIZE, true); // cell_content_offset = 4096
  rootView.setUint32(6, 0, true); // next_page_id = 0
  rootView.setUint16(10, 0, true); // free_bytes = 0
  rootView.setUint32(12, 0, true); // checksum
  pager.markPageDirty(rootPageId);

  // Compute column metadata & fixed slice offsets
  const columns: ColumnMeta[] = [];
  let currentFixedOffset = 0;

  for (const def of columnsDef) {
    const type =
      typeof def.type === "string"
        ? parseDataType(def.type)
        : (def.type as DataType);

    let flags = 0;
    if (def.primaryKey || def.flags?.primaryKey)
      flags |= ColumnFlag.PRIMARY_KEY;
    if (def.notNull || def.flags?.notNull) flags |= ColumnFlag.NOT_NULL;
    if (def.indexed || def.flags?.indexed) flags |= ColumnFlag.INDEXED;
    if (def.autoInc || def.flags?.autoInc) flags |= ColumnFlag.AUTO_INC;

    const colOffset = currentFixedOffset;

    switch (type) {
      case DataType.INT32:
        currentFixedOffset += 4;
        break;
      case DataType.INT64:
      case DataType.FLOAT64:
        currentFixedOffset += 8;
        break;
      case DataType.UUID:
      case DataType.ULID:
        currentFixedOffset += 16;
        break;
    }

    columns.push({
      type,
      flags,
      colOffset,
      name: def.name,
    });
  }

  // Allocate and write dedicated column catalog pages
  const totalCols = columns.length;
  const numCatalogPages = Math.ceil(totalCols / MAX_COLUMNS_PER_CATALOG_PAGE);
  const catalogPageIds: number[] = [];

  for (let i = 0; i < numCatalogPages; i++) {
    catalogPageIds.push(pager.allocateNewPage());
  }

  for (let p = 0; p < numCatalogPages; p++) {
    const pageId = catalogPageIds[p];
    const nextPageId = p < numCatalogPages - 1 ? catalogPageIds[p + 1] : 0;
    const startColIndex = p * MAX_COLUMNS_PER_CATALOG_PAGE;
    const colCountInThisPage = Math.min(
      totalCols - startColIndex,
      MAX_COLUMNS_PER_CATALOG_PAGE,
    );

    const pageBytes = pager.getPageBytes(pageId);
    const view = new DataView(pageBytes.buffer, pageBytes.byteOffset);

    initCatalogPage(view, 0, tableId, startColIndex, nextPageId);
    view.setUint16(2, colCountInThisPage, true); // col_count_in_page

    for (let c = 0; c < colCountInThisPage; c++) {
      const col = columns[startColIndex + c];
      writeColumnMeta(view, 0, c, col);
    }

    // Set CRC32 checksum
    const chk = computePageChecksum(pageBytes);
    view.setUint32(12, chk, true);
    pager.markPageDirty(pageId);
  }

  const firstCatalogPageId = catalogPageIds[0];

  // Write TableDescriptor into Page 1
  const desc: TableDescriptor = {
    tableId,
    columnCount: totalCols,
    rootPageId,
    colCatalogPageId: firstCatalogPageId,
    name,
    flags: TableFlag.ACTIVE,
    rowCountEstimate: 0,
    autoIncNext: 1n,
  };

  writeTableDescriptor(page1View, slotIdx, desc);
  incrementSchemaVersion(page1View);
  incrementChangeCounter(page1View);
  updatePage1Checksum(page1View);

  return {
    ...desc,
    columns,
  };
}

/**
 * Loads the complete TableMeta (including all columns from chained catalog pages) for a table.
 */
export function loadTableMeta(
  page1View: DataView,
  pager: { getPageBytes(pageId: number): Uint8Array },
  tableName: string,
): TableMeta {
  const slotIdx = findTableSlot(page1View, tableName);

  if (slotIdx === -1) {
    throw new TableNotFoundError(tableName);
  }

  const desc = readTableDescriptor(page1View, slotIdx)!;
  const columns: ColumnMeta[] = [];

  let currentCatPageId = desc.colCatalogPageId;
  let loadedCount = 0;

  while (currentCatPageId !== 0 && loadedCount < desc.columnCount) {
    const pageBytes = pager.getPageBytes(currentCatPageId);
    const view = new DataView(pageBytes.buffer, pageBytes.byteOffset);
    const header = readCatalogPageHeader(view, 0);

    for (let i = 0; i < header.colCountInPage; i++) {
      const col = readColumnMeta(view, 0, i);
      columns.push(col);
      loadedCount++;
    }

    currentCatPageId = header.nextColCatalogPageId;
  }

  return {
    ...desc,
    columns,
  };
}

/**
 * Loads all active tables and their full schemas from Page 1.
 */
export function loadAllTables(
  page1View: DataView,
  pager: { getPageBytes(pageId: number): Uint8Array },
): TableMeta[] {
  const descriptors = listTableDescriptors(page1View);
  return descriptors.map((desc) => loadTableMeta(page1View, pager, desc.name));
}
