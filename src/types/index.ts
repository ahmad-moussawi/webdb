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
  // Cursor / Scan
  OP_HALT = 0x00,
  OP_OPEN_CURSOR = 0x01,
  OP_REWIND = 0x02,
  OP_NEXT_ROW = 0x03,
  OP_COLUMN_INT = 0x04,
  OP_COLUMN_FLOAT = 0x05,
  OP_COLUMN_TEXT = 0x06,
  OP_COLUMN_BLOB = 0x07,
  OP_LAST = 0x08,
  OP_PREV_ROW = 0x09,
  OP_COLUMN_UUID = 0x0a,
  OP_COLUMN_ULID = 0x0b,

  // Logic / Control
  OP_IS_NULL = 0x10,
  OP_IS_NOT_NULL = 0x11,
  OP_EQ = 0x12,
  OP_NE = 0x13,
  OP_GT = 0x14,
  OP_GE = 0x15,
  OP_LT = 0x16,
  OP_LE = 0x17,
  OP_JUMP = 0x18,
  OP_STR_LIKE = 0x19,
  OP_STR_NOT_LIKE = 0x1a,
  OP_STR_CONTAINS = 0x1b,
  OP_STR_STARTS_WITH = 0x1c,
  OP_STR_ENDS_WITH = 0x1d,

  // Data / Output
  OP_LOAD_INT = 0x20,
  OP_LOAD_FLOAT = 0x21,
  OP_LOAD_TEXT = 0x22,
  OP_LOAD_NULL = 0x23,
  OP_EMIT_ROW = 0x24,
  OP_RESULT_ROW = 0x25,
  OP_OFFSET = 0x26,
  OP_LIMIT = 0x27,
  OP_CALL_UDF = 0x28,
  OP_STR_LOWER = 0x29,
  OP_STR_UPPER = 0x2a,
  OP_STR_LENGTH = 0x2b,
  OP_STR_SUBSTR = 0x2c,
  OP_STR_TRIM = 0x2d,
  OP_MATH_ABS = 0x2e,
  OP_MATH_ROUND = 0x2f,

  // Sorter (ORDER BY)
  OP_SORTER_OPEN = 0x30,
  OP_SORTER_INSERT = 0x31,
  OP_SORTER_SORT = 0x32,
  OP_SORTER_NEXT = 0x33,

  // Math Functions
  OP_MATH_FLOOR = 0x34,
  OP_MATH_CEIL = 0x35,

  // Binary Arithmetic (3VL)
  OP_ADD = 0x36,
  OP_SUB = 0x37,
  OP_MUL = 0x38,
  OP_DIV = 0x39,
  OP_MOD = 0x3a,

  // Subquery Framing
  OP_ENTER_SUBQUERY = 0x3b,
  OP_RETURN_SUBQUERY = 0x3c,

  // Multi-Arg Functions
  OP_STR_CONCAT = 0x3d,
  OP_COALESCE = 0x3e,
  OP_COPY = 0x3f,

  // Agg (GROUP BY)
  OP_AGG_INIT = 0x40,
  OP_AGG_STEP = 0x41,
  OP_AGG_NEXT = 0x42,
  OP_AGG_FINAL = 0x43,

  // Register Null Checks
  OP_REG_IS_NULL = 0x48,
  OP_REG_IS_NOT_NULL = 0x49,

  // DML Mutation
  OP_DELETE_ROW = 0x50,
  OP_UPDATE_FIELD = 0x51,
  OP_INSERT_ROW = 0x52,
}

export enum VmStatus {
  RUNNING = 0,
  DONE = 1,
  PAGE_FAULT = 2,
  BUFFER_FULL = 3,
  ERROR = 4,
  TIMEOUT = 5,
  ARENA_EXHAUSTED = 6,
  INVALID_BYTECODE = 7,
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

export type JoinType = 'inner' | 'left';

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
  primaryKey?: string[];
  indexes?: IndexDescriptor[];
  schemaVersion?: number;
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

export class UniqueConstraintViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UniqueConstraintViolationError';
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

export class QueryTimeoutError extends Error {
  constructor(message: string = 'Query execution exceeded maximum cycle limit (TIMEOUT)') {
    super(message);
    this.name = 'QueryTimeoutError';
  }
}

export class InvalidBytecodeError extends Error {
  constructor(message: string = 'Malformed bytecode execution halted (INVALID_BYTECODE)') {
    super(message);
    this.name = 'InvalidBytecodeError';
  }
}

export class TooManyOrderByColumnsError extends Error {
  constructor(count: number, limit: number = 8) {
    super(`Too many order by columns: ${count} exceeds maximum limit of ${limit}`);
    this.name = 'TooManyOrderByColumnsError';
  }
}

export class TooManyGroupByColumnsError extends Error {
  constructor(count: number, limit: number = 8) {
    super(`Too many group by columns: ${count} exceeds maximum limit of ${limit}`);
    this.name = 'TooManyGroupByColumnsError';
  }
}

export class UnknownFunctionError extends Error {
  constructor(funcName: string) {
    super(`Function "${funcName}" is neither a native built-in function nor a registered UDF`);
    this.name = 'UnknownFunctionError';
  }
}

export class AggregateNotAllowedInWhereError extends Error {
  constructor(funcName: string) {
    super(`Aggregate function "${funcName}" cannot be used in WHERE clause`);
    this.name = 'AggregateNotAllowedInWhereError';
  }
}

export * from '../shared/vm_context.js';
export * from '../shared/page_provider.js';
