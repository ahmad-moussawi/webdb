export enum DataType {
  NULL = 0,
  INT32 = 1,
  INT64 = 2,
  FLOAT64 = 3,
  TEXT = 4,
  BLOB = 5,
  UUID = 6,
  ULID = 7,
}

export enum ColumnFlag {
  NONE = 0,
  PRIMARY_KEY = 0x01,
  NOT_NULL = 0x02,
  INDEXED = 0x04,
  AUTO_INC = 0x08,
}

export enum TableFlag {
  NONE = 0,
  ACTIVE = 0x01,
  SYSTEM = 0x02,
}

export enum IndexFlag {
  NONE = 0,
  UNIQUE = 0x01,
  PRIMARY = 0x02,
  SPATIAL_VECTOR = 0x04,
}

export enum OpCode {
  OP_HALT = 0,
  OP_OPEN_CURSOR = 1,
  OP_REWIND = 2,
  OP_NEXT_ROW = 3,
  OP_COLUMN_INT = 4,
  OP_COLUMN_FLOAT = 5,
  OP_COLUMN_TEXT = 6,
  OP_COLUMN_BLOB = 7,
  OP_EQ = 10,
  OP_NE = 11,
  OP_GT = 12,
  OP_GE = 13,
  OP_LT = 14,
  OP_LE = 15,
  OP_IS_NULL = 16,
  OP_IS_NOT_NULL = 17,
  OP_EMIT_ROW = 20,
  OP_JUMP = 25,
  OP_LOAD_INT = 31,
  OP_LOAD_FLOAT = 32,
  OP_LOAD_TEXT = 33,
  OP_LOAD_NULL = 34,
}

export enum VmStatus {
  RUNNING = 0,
  DONE = 1,
  PAGE_FAULT = 2,
  BUFFER_FULL = 3,
  ERROR = 4,
}

export type DataTypeString =
  | 'INT32' | 'INT64' | 'FLOAT64' | 'TEXT' | 'BLOB' | 'UUID' | 'ULID'
  | 'int32' | 'int64' | 'float64' | 'text' | 'blob' | 'uuid' | 'ulid';

export interface ColumnDefinition {
  name: string;
  type: DataTypeString;
  primaryKey?: boolean;
  notNull?: boolean;
  autoInc?: boolean;
  indexed?: boolean;
  flags?: {
    primaryKey?: boolean;
    notNull?: boolean;
    autoInc?: boolean;
    indexed?: boolean;
  };
}

export interface ColumnMeta {
  type: DataType;
  flags: number;
  colOffset: number; // Offset within the fixed slice
  name: string;
}

export interface TableDescriptor {
  tableId: number;
  columnCount: number;
  rootPageId: number;
  colCatalogPageId: number;
  name: string;
  flags: number;
  rowCountEstimate: number;
  autoIncNext: bigint;
}

export interface IndexDescriptor {
  indexId: number;
  tableId: number;
  rootPageId: number;
  columnCount: number;
  flags: number;
  columnIndices: number[];
  colDirections: number[];
  name: string;
}

export interface CatalogPageHeader {
  pageType: number;
  flags: number;
  colCountInPage: number;
  tableId: number;
  startColIndex: number;
  nextColCatalogPageId: number;
  pageChecksum: number;
}

export interface TableMeta {
  tableId: number;
  columnCount: number;
  rootPageId: number;
  colCatalogPageId: number;
  name: string;
  flags: number;
  rowCountEstimate: number;
  autoIncNext: bigint;
  columns: ColumnMeta[];
}

// Backward-compat alias
export type TableColumnMeta = ColumnMeta;

export type DbValue = number | bigint | string | Uint8Array | null;
export type DbRow = Record<string, DbValue>;

// Error Taxonomy
export class RowSizeLimitExceededError extends Error {
  constructor(size: number, limit: number = 2048) {
    super(`Row size (${size} bytes) exceeds maximum limit of ${limit} bytes`);
    this.name = 'RowSizeLimitExceededError';
  }
}

export class NotNullConstraintError extends Error {
  constructor(columnName: string, tableName?: string) {
    super(`NOT NULL constraint failed: ${tableName ? tableName + '.' : ''}${columnName}`);
    this.name = 'NotNullConstraintError';
  }
}

export class TableNotFoundError extends Error {
  constructor(tableName: string) {
    super(`Table not found: "${tableName}"`);
    this.name = 'TableNotFoundError';
  }
}

export class TableAlreadyExistsError extends Error {
  constructor(tableName: string) {
    super(`Table already exists: "${tableName}"`);
    this.name = 'TableAlreadyExistsError';
  }
}

export class IndexNotFoundError extends Error {
  constructor(indexName: string) {
    super(`Index not found: "${indexName}"`);
    this.name = 'IndexNotFoundError';
  }
}

export class IndexAlreadyExistsError extends Error {
  constructor(indexName: string) {
    super(`Index already exists: "${indexName}"`);
    this.name = 'IndexAlreadyExistsError';
  }
}

export class CorruptPageError extends Error {
  constructor(public pageId: number, public storedChecksum: number | string, public computedChecksum?: number | string) {
    super(
      `Corrupted page detected (pageId: ${pageId}): stored checksum ${storedChecksum}${
        computedChecksum !== undefined ? `, computed checksum ${computedChecksum}` : ''
      }`
    );
    this.name = 'CorruptPageError';
  }
}

export class TooManyColumnsError extends Error {
  constructor(columnCount: number, limit: number = 256) {
    super(`Too many columns: ${columnCount} exceeds maximum limit of ${limit} columns`);
    this.name = 'TooManyColumnsError';
  }
}

export class TooManyTablesError extends Error {
  constructor(tableCount: number, limit: number = 16) {
    super(`Too many tables: ${tableCount} exceeds maximum limit of ${limit} tables on Page 1`);
    this.name = 'TooManyTablesError';
  }
}

export class TooManyIndexesError extends Error {
  constructor(indexCount: number, limit: number = 8) {
    super(`Too many indexes: ${indexCount} exceeds maximum limit of ${limit} indexes on Page 1`);
    this.name = 'TooManyIndexesError';
  }
}

export class UnsupportedFormatVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatVersionError';
  }
}

export class InvalidDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDatabaseError';
  }
}

export class QueryArenaExhaustedError extends Error {
  constructor(message: string = 'Transient query arena exhausted') {
    super(message);
    this.name = 'QueryArenaExhaustedError';
  }
}

export class TooManyCursorsError extends Error {
  constructor(cursorCount: number, limit: number = 16) {
    super(`Too many cursors: ${cursorCount} exceeds maximum limit of ${limit} cursors`);
    this.name = 'TooManyCursorsError';
  }
}

export class TooManyRegistersError extends Error {
  constructor(registerCount: number, limit: number = 64) {
    super(`Too many registers: ${registerCount} exceeds maximum limit of ${limit} registers`);
    this.name = 'TooManyRegistersError';
  }
}

export class SubqueryNestingTooDeepError extends Error {
  constructor(depth: number, limit: number = 7) {
    super(`Subquery nesting depth ${depth} exceeds maximum limit of ${limit}`);
    this.name = 'SubqueryNestingTooDeepError';
  }
}
