import { TableMeta, TableColumnMeta } from '../types/studio';
import { DataType, ColumnFlag } from '@webdb/core';

export interface SqlExportResult {
  sql: string;
  tableCount: number;
  rowCount: number;
}

/**
 * Maps a WebDB column type to SQLite column type affinity
 */
function getSqliteType(type: number | string): string {
  if (typeof type === 'string') {
    const upper = type.toUpperCase();
    if (upper.includes('INT')) return 'INTEGER';
    if (upper.includes('FLOAT') || upper.includes('DOUBLE') || upper.includes('REAL')) return 'REAL';
    if (upper.includes('BLOB') || upper.includes('BINARY')) return 'BLOB';
    return 'TEXT';
  }

  switch (type) {
    case DataType.INT32:
    case DataType.INT64:
      return 'INTEGER';
    case DataType.FLOAT64:
      return 'REAL';
    case DataType.BLOB:
      return 'BLOB';
    case DataType.TEXT:
    case DataType.UUID:
    case DataType.ULID:
    default:
      return 'TEXT';
  }
}

/**
 * Checks flag bitmask or object properties for a column
 */
function checkColumnFlags(flags: number | { primaryKey?: boolean; notNull?: boolean; autoInc?: boolean } | undefined) {
  let isPk = false;
  let isNotNull = false;
  let isAutoInc = false;

  if (typeof flags === 'number') {
    isPk = (flags & ColumnFlag.PRIMARY_KEY) !== 0;
    isNotNull = (flags & ColumnFlag.NOT_NULL) !== 0;
    isAutoInc = (flags & ColumnFlag.AUTO_INC) !== 0;
  } else if (flags && typeof flags === 'object') {
    isPk = !!flags.primaryKey;
    isNotNull = !!flags.notNull;
    isAutoInc = !!flags.autoInc;
  }

  return { isPk, isNotNull, isAutoInc };
}

/**
 * Escapes an identifier for SQLite ("name")
 */
function escapeIdentifier(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * Formats a JavaScript value as an SQLite SQL literal
 */
function formatSqlValue(val: unknown): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }

  if (typeof val === 'number') {
    return Number.isFinite(val) ? val.toString() : 'NULL';
  }

  if (typeof val === 'bigint') {
    return val.toString();
  }

  if (typeof val === 'boolean') {
    return val ? '1' : '0';
  }

  if (typeof val === 'string') {
    return `'${val.replace(/'/g, "''")}'`;
  }

  if (val instanceof Uint8Array) {
    const hex: string[] = [];
    for (let i = 0; i < val.length; i++) {
      hex.push(val[i].toString(16).padStart(2, '0'));
    }
    return `X'${hex.join('')}'`;
  }

  if (typeof val === 'object') {
    try {
      return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
    } catch {
      return `'${String(val).replace(/'/g, "''")}'`;
    }
  }

  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Exports all tables and data in a WebDB instance to an SQLite-compatible .sql script
 */
export async function exportDatabaseToSql(
  db: any,
  dbName: string = 'database',
): Promise<SqlExportResult> {
  if (!db) {
    throw new Error('Database instance is required for export');
  }

  let tables: TableMeta[] = [];
  if (typeof db.listTables === 'function') {
    tables = await db.listTables();
  }

  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  // Header Banner
  lines.push('-- ============================================================');
  lines.push('-- WebDB Database Dump (SQLite Compatible)');
  lines.push(`-- Database: ${dbName}`);
  lines.push(`-- Exported At: ${timestamp}`);
  lines.push(`-- Total Tables: ${tables.length}`);
  lines.push('-- ============================================================');
  lines.push('');
  lines.push('PRAGMA foreign_keys = OFF;');
  lines.push('BEGIN TRANSACTION;');
  lines.push('');

  let totalRowCount = 0;

  for (const table of tables) {
    const tableName = table.name;
    const columns = table.columns || [];

    lines.push(`-- ------------------------------------------------------------`);
    lines.push(`-- Table structure for ${escapeIdentifier(tableName)}`);
    lines.push(`-- ------------------------------------------------------------`);
    lines.push(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)};`);

    // Determine PK columns
    const pkCols: string[] = [];
    for (const col of columns) {
      const { isPk } = checkColumnFlags(col.flags);
      if (isPk) pkCols.push(col.name);
    }
    const isSinglePk = pkCols.length === 1;

    // Build column definitions
    const colDefs: string[] = [];
    for (const col of columns) {
      const { isPk, isNotNull, isAutoInc } = checkColumnFlags(col.flags);
      const sqlType = getSqliteType(col.type);

      const parts: string[] = [escapeIdentifier(col.name), sqlType];

      if (isSinglePk && isPk) {
        if (sqlType === 'INTEGER' && isAutoInc) {
          parts.push('PRIMARY KEY AUTOINCREMENT');
        } else {
          parts.push('PRIMARY KEY');
        }
      }

      if (isNotNull && (!isSinglePk || !isPk)) {
        parts.push('NOT NULL');
      }

      colDefs.push(`  ${parts.join(' ')}`);
    }

    // Composite primary key constraint if multiple PKs
    if (pkCols.length > 1) {
      colDefs.push(`  PRIMARY KEY (${pkCols.map(escapeIdentifier).join(', ')})`);
    }

    lines.push(`CREATE TABLE ${escapeIdentifier(tableName)} (`);
    lines.push(colDefs.join(',\n'));
    lines.push(');');
    lines.push('');

    // Fetch table rows
    let rows: any[] = [];
    try {
      if (typeof db.from === 'function') {
        rows = await db.from(tableName).toArray();
      }
    } catch (err) {
      console.warn(`Could not query rows for table ${tableName}:`, err);
    }

    totalRowCount += rows.length;

    if (rows.length > 0) {
      lines.push(`-- Data for table ${escapeIdentifier(tableName)} (${rows.length} rows)`);

      // Determine column order
      const colNames = columns.length > 0
        ? columns.map((c) => c.name)
        : Object.keys(rows[0]);

      const escapedColList = colNames.map(escapeIdentifier).join(', ');

      // Insert in chunks of 50 for compact formatting & max SQLite parsing efficiency
      const BATCH_SIZE = 50;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const valueTuples = batch.map((row) => {
          const values = colNames.map((colName) => formatSqlValue(row[colName]));
          return `  (${values.join(', ')})`;
        });

        lines.push(
          `INSERT INTO ${escapeIdentifier(tableName)} (${escapedColList}) VALUES\n` +
            valueTuples.join(',\n') +
            ';',
        );
      }

      lines.push('');
    }
  }

  lines.push('COMMIT;');
  lines.push('PRAGMA foreign_keys = ON;');
  lines.push('');

  return {
    sql: lines.join('\n'),
    tableCount: tables.length,
    rowCount: totalRowCount,
  };
}

/**
 * Triggers a browser download of the SQL string as a .sql file
 */
export function downloadSqlFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/sql;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.sql') ? filename : `${filename}.sql`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
