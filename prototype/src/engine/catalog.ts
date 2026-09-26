import {
  PAGE_SIZE,
  FILE_HEADER_SIZE,
  MASTER_TABLE_OFFSET,
  MAX_TABLES,
  MAX_COLUMNS_PER_TABLE,
  COLUMN_META_SIZE,
  TABLE_META_HEADER_SIZE,
  TABLE_META_SIZE,
  HEADER_OFFSET_MAGIC,
  HEADER_OFFSET_PAGE_SIZE,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_SCHEMA_VERSION,
} from '../constants.js';
import {
  DataType,
  ColumnFlag,
  ColumnDefinition,
  TableMeta,
  TableColumnMeta,
  TableAlreadyExistsError,
  TableNotFoundError,
} from '../types.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MAGIC = [0x57, 0x45, 0x42, 0x44, 0x42, 0x00]; // "WEBDB\0"

export function initPage1(view: DataView): void {
  // 1. Magic bytes
  for (let i = 0; i < MAGIC.length; i++) {
    view.setUint8(HEADER_OFFSET_MAGIC + i, MAGIC[i]);
  }
  // 2. Page size
  view.setUint16(HEADER_OFFSET_PAGE_SIZE, PAGE_SIZE, true);
  // 3. Total pages (Page 1 itself is allocated)
  view.setUint32(HEADER_OFFSET_TOTAL_PAGES, 1, true);
  // 4. Free page head
  view.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, 0, true);
  // 5. Schema version
  view.setUint32(HEADER_OFFSET_SCHEMA_VERSION, 1, true);

  // Clear Binary Master Table area (bytes 100..4095)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset + MASTER_TABLE_OFFSET, PAGE_SIZE - MASTER_TABLE_OFFSET);
  uint8.fill(0);
}

export function readPage1Header(view: DataView) {
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(HEADER_OFFSET_MAGIC + i) !== MAGIC[i]) {
      throw new Error('Invalid database file: magic bytes mismatch');
    }
  }
  const pageSize = view.getUint16(HEADER_OFFSET_PAGE_SIZE, true);
  const totalPages = view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
  const freePageHead = view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
  const schemaVersion = view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);

  return { pageSize, totalPages, freePageHead, schemaVersion };
}

export function getTotalPages(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
}

export function setTotalPages(view: DataView, count: number): void {
  view.setUint32(HEADER_OFFSET_TOTAL_PAGES, count, true);
}

export function getSchemaVersion(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
}

export function incrementSchemaVersion(view: DataView): number {
  const v = getSchemaVersion(view) + 1;
  view.setUint32(HEADER_OFFSET_SCHEMA_VERSION, v, true);
  return v;
}

function writeFixedString(view: DataView, offset: number, str: string, maxLen: number): void {
  const bytes = textEncoder.encode(str);
  for (let i = 0; i < maxLen; i++) {
    view.setUint8(offset + i, i < bytes.length ? bytes[i] : 0);
  }
}

function readFixedString(view: DataView, offset: number, maxLen: number): string {
  const bytes: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

function parseDataType(typeStr: string): DataType {
  switch (typeStr.toUpperCase()) {
    case 'INT32': return DataType.INT32;
    case 'INT64': return DataType.INT64;
    case 'FLOAT64': return DataType.FLOAT64;
    case 'TEXT': return DataType.TEXT;
    case 'BLOB': return DataType.BLOB;
    default: throw new Error(`Unsupported column data type: "${typeStr}"`);
  }
}

export function readAllTables(view: DataView): TableMeta[] {
  const tables: TableMeta[] = [];

  for (let i = 0; i < MAX_TABLES; i++) {
    const tableOffset = MASTER_TABLE_OFFSET + (i * TABLE_META_SIZE);
    const tableId = view.getUint16(tableOffset, true);
    if (tableId === 0) continue; // Unused slot

    const columnCount = view.getUint16(tableOffset + 2, true);
    const rootPageId = view.getUint32(tableOffset + 4, true);
    const tableName = readFixedString(view, tableOffset + 8, 16);

    const columns: TableColumnMeta[] = [];
    const colBaseOffset = tableOffset + TABLE_META_HEADER_SIZE;

    for (let c = 0; c < columnCount; c++) {
      const colOffset = colBaseOffset + (c * COLUMN_META_SIZE);
      const type = view.getUint8(colOffset) as DataType;
      const flags = view.getUint8(colOffset + 1);
      const sliceOffset = view.getUint16(colOffset + 2, true);
      const colName = readFixedString(view, colOffset + 4, 16);

      columns.push({
        type,
        flags,
        colOffset: sliceOffset,
        name: colName,
      });
    }

    tables.push({
      tableId,
      columnCount,
      rootPageId,
      name: tableName,
      columns,
    });
  }

  return tables;
}

export function findTableByName(view: DataView, name: string): TableMeta | null {
  const tables = readAllTables(view);
  return tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
}

export function addTableToCatalog(
  view: DataView,
  name: string,
  columnDefs: ColumnDefinition[],
  rootPageId: number
): TableMeta {
  if (findTableByName(view, name)) {
    throw new TableAlreadyExistsError(name);
  }

  if (columnDefs.length > MAX_COLUMNS_PER_TABLE) {
    throw new Error(`Table cannot have more than ${MAX_COLUMNS_PER_TABLE} columns in prototype`);
  }

  // Find free slot
  let targetSlot = -1;
  let maxTableId = 0;

  for (let i = 0; i < MAX_TABLES; i++) {
    const tableOffset = MASTER_TABLE_OFFSET + (i * TABLE_META_SIZE);
    const tableId = view.getUint16(tableOffset, true);
    if (tableId === 0 && targetSlot === -1) {
      targetSlot = i;
    }
    if (tableId > maxTableId) {
      maxTableId = tableId;
    }
  }

  if (targetSlot === -1) {
    throw new Error(`Maximum table limit (${MAX_TABLES}) reached in prototype`);
  }

  const tableId = maxTableId + 1;
  const tableOffset = MASTER_TABLE_OFFSET + (targetSlot * TABLE_META_SIZE);

  // Compute fixed slice offsets for columns
  let currentFixedOffset = 0;
  const tableColumns: TableColumnMeta[] = [];

  for (const def of columnDefs) {
    const type = parseDataType(def.type);
    let flags = ColumnFlag.NONE;
    if (def.flags?.primaryKey) flags |= ColumnFlag.PRIMARY_KEY | ColumnFlag.NOT_NULL;
    if (def.flags?.notNull) flags |= ColumnFlag.NOT_NULL;

    let colSliceOffset = 0;
    if (type === DataType.INT32) {
      colSliceOffset = currentFixedOffset;
      currentFixedOffset += 4;
    } else if (type === DataType.INT64 || type === DataType.FLOAT64) {
      colSliceOffset = currentFixedOffset;
      currentFixedOffset += 8;
    }

    tableColumns.push({
      type,
      flags,
      colOffset: colSliceOffset,
      name: def.name,
    });
  }

  // 1. Write TableMeta Header
  view.setUint16(tableOffset + 0, tableId, true);
  view.setUint16(tableOffset + 2, tableColumns.length, true);
  view.setUint32(tableOffset + 4, rootPageId, true);
  writeFixedString(view, tableOffset + 8, name, 16);

  // 2. Write ColumnMeta Array
  const colBaseOffset = tableOffset + TABLE_META_HEADER_SIZE;
  for (let c = 0; c < tableColumns.length; c++) {
    const col = tableColumns[c];
    const colOffset = colBaseOffset + (c * COLUMN_META_SIZE);

    view.setUint8(colOffset + 0, col.type);
    view.setUint8(colOffset + 1, col.flags);
    view.setUint16(colOffset + 2, col.colOffset, true);
    writeFixedString(view, colOffset + 4, col.name, 16);
  }

  incrementSchemaVersion(view);

  return {
    tableId,
    columnCount: tableColumns.length,
    rootPageId,
    name,
    columns: tableColumns,
  };
}
