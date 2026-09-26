export enum DataType {
  INT32 = 1,
  INT64 = 2,
  FLOAT64 = 3,
  TEXT = 4,
  BLOB = 5,
}

export enum ColumnFlag {
  NONE = 0,
  PRIMARY_KEY = 0x01,
  NOT_NULL = 0x02,
  INDEXED = 0x04,
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

export interface ColumnDefinition {
  name: string;
  type: 'INT32' | 'INT64' | 'FLOAT64' | 'TEXT' | 'BLOB';
  flags?: {
    primaryKey?: boolean;
    notNull?: boolean;
  };
}

export interface TableColumnMeta {
  type: DataType;
  flags: number;
  colOffset: number; // Offset within the fixed slice
  name: string;
}

export interface TableMeta {
  tableId: number;
  columnCount: number;
  rootPageId: number;
  name: string;
  columns: TableColumnMeta[];
}

export type DbValue = number | bigint | string | Uint8Array | null;
export type DbRow = Record<string, DbValue>;

export class RowSizeLimitExceededError extends Error {
  constructor(size: number, limit: number = 2048) {
    super(`Row size (${size} bytes) exceeds maximum limit of ${limit} bytes`);
    this.name = 'RowSizeLimitExceededError';
  }
}

export class NotNullConstraintError extends Error {
  constructor(columnName: string, tableName: string) {
    super(`NOT NULL constraint failed: ${tableName}.${columnName}`);
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
