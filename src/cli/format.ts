import {
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
} from '../constants.js';
import { ColumnFlag, DataType, IndexFlag } from '../types/index.js';

export type OutputFormat = 'table' | 'json' | 'ndjson' | 'csv';

export function formatDataType(type: DataType): string {
  switch (type) {
    case DataType.NULL:
      return 'NULL';
    case DataType.INT32:
      return 'INT32';
    case DataType.INT64:
      return 'INT64';
    case DataType.FLOAT64:
      return 'FLOAT64';
    case DataType.TEXT:
      return 'TEXT';
    case DataType.BLOB:
      return 'BLOB';
    case DataType.UUID:
      return 'UUID';
    case DataType.ULID:
      return 'ULID';
    default:
      return `UNKNOWN(${type})`;
  }
}

export function formatColumnFlags(flags: number): string {
  const parts: string[] = [];
  if (flags & ColumnFlag.PRIMARY_KEY) parts.push('PK');
  if (flags & ColumnFlag.NOT_NULL) parts.push('NOT NULL');
  if (flags & ColumnFlag.AUTO_INC) parts.push('AUTO_INC');
  if (flags & ColumnFlag.INDEXED) parts.push('INDEXED');
  return parts.length > 0 ? parts.join(', ') : '-';
}

export function formatIndexFlags(flags: number): string {
  const parts: string[] = [];
  if (flags & IndexFlag.PRIMARY) parts.push('PRIMARY');
  if (flags & IndexFlag.UNIQUE) parts.push('UNIQUE');
  if (flags & IndexFlag.SPATIAL_VECTOR) parts.push('SPATIAL_VECTOR');
  return parts.length > 0 ? parts.join(', ') : '-';
}

export function formatPageType(pageType: number, pageId?: number): string {
  if (pageId === 1) return 'HEADER_CATALOG';
  switch (pageType) {
    case PAGE_TYPE_FREE:
      return 'FREE';
    case PAGE_TYPE_INDEX_INTERIOR:
      return 'INDEX_INTERIOR';
    case PAGE_TYPE_TABLE_INTERIOR:
      return 'TABLE_INTERIOR';
    case PAGE_TYPE_INDEX_LEAF:
      return 'INDEX_LEAF';
    case PAGE_TYPE_CATALOG_PAGE:
      return 'CATALOG_PAGE';
    case PAGE_TYPE_LEAF_DATA:
      return 'LEAF_DATA';
    case PAGE_TYPE_OVERFLOW:
      return 'OVERFLOW';
    default:
      return `UNKNOWN(0x${pageType.toString(16).padStart(2, '0')})`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatHex32(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
}

export function formatCellValue(val: unknown, maxLen = 64): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (val instanceof Uint8Array) {
    const previewLen = Math.min(val.byteLength, 8);
    let hex = '';
    for (let i = 0; i < previewLen; i++) {
      hex += val[i].toString(16).padStart(2, '0');
    }
    const suffix = val.byteLength > previewLen ? '…' : '';
    return `<BLOB ${val.byteLength}B 0x${hex}${suffix}>`;
  }
  const str = typeof val === 'string' ? val : JSON.stringify(toJsonSafe(val));
  const singleLine = str.replace(/\r?\n/g, '\\n');
  if (singleLine.length > maxLen) {
    return singleLine.slice(0, maxLen - 1) + '…';
  }
  return singleLine;
}

export function toJsonSafe(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Uint8Array) {
    let hex = '';
    for (let i = 0; i < val.byteLength; i++) {
      hex += val[i].toString(16).padStart(2, '0');
    }
    return { __type: 'blob', byteLength: val.byteLength, hex };
  }
  if (Array.isArray(val)) {
    return val.map((item) => toJsonSafe(item));
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return val;
}

export function formatJson(val: unknown, pretty = true): string {
  return JSON.stringify(toJsonSafe(val), null, pretty ? 2 : 0);
}

export function formatNdjson(rows: Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(toJsonSafe(row))).join('\n');
}

function escapeCsvField(raw: string): string {
  if (raw.includes('"') || raw.includes(',') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function formatCsvValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Uint8Array) {
    let hex = '';
    for (let i = 0; i < val.byteLength; i++) {
      hex += val[i].toString(16).padStart(2, '0');
    }
    return `0x${hex}`;
  }
  if (typeof val === 'object') return JSON.stringify(toJsonSafe(val));
  return String(val);
}

export function formatCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines: string[] = [];
  lines.push(columns.map(escapeCsvField).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvField(formatCsvValue(row[c]))).join(','));
  }
  return lines.join('\n');
}

export function formatTable(
  columns: string[],
  rows: Record<string, unknown>[],
  options: { maxCellWidth?: number } = {},
): string {
  if (columns.length === 0) return '(no columns)';
  const maxCellWidth = options.maxCellWidth ?? 64;

  const isNumericCol = columns.map((col) => {
    let sawValue = false;
    for (const row of rows) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      sawValue = true;
      if (typeof v !== 'number' && typeof v !== 'bigint') return false;
    }
    return sawValue;
  });

  const formattedRows = rows.map((row) =>
    columns.map((col) => formatCellValue(row[col], maxCellWidth)),
  );

  const widths = columns.map((col, idx) => {
    let w = col.length;
    for (const r of formattedRows) {
      if (r[idx].length > w) w = r[idx].length;
    }
    return w;
  });

  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const renderRow = (cells: string[], alignRight: boolean[]) =>
    '│' +
    cells
      .map((cell, i) => {
        const padded = alignRight[i]
          ? cell.padStart(widths[i], ' ')
          : cell.padEnd(widths[i], ' ');
        return ` ${padded} `;
      })
      .join('│') +
    '│';

  const lines: string[] = [
    top,
    renderRow(columns, columns.map(() => false)),
    mid,
  ];
  for (const r of formattedRows) {
    lines.push(renderRow(r, isNumericCol));
  }
  lines.push(bot);
  return lines.join('\n');
}

export function formatKeyValue(entries: Array<[string, string | number | boolean]>): string {
  const maxKey = entries.reduce((m, [k]) => Math.max(m, k.length), 0);
  return entries.map(([k, v]) => `${k.padEnd(maxKey, ' ')} : ${String(v)}`).join('\n');
}

export function formatRowsOutput(
  columns: string[],
  rows: Record<string, unknown>[],
  format: OutputFormat,
): string {
  switch (format) {
    case 'json':
      return formatJson(rows);
    case 'ndjson':
      return formatNdjson(rows);
    case 'csv':
      return formatCsv(columns, rows);
    case 'table':
    default:
      return formatTable(columns, rows);
  }
}

export function formatHexDump(bytes: Uint8Array, baseOffset = 0): string {
  const lines: string[] = [];
  let prevLineHex: string | null = null;
  let skipping = false;

  for (let off = 0; off < bytes.byteLength; off += 16) {
    const end = Math.min(off + 16, bytes.byteLength);
    let hexLeft = '';
    let hexRight = '';
    let ascii = '';
    let key = '';

    for (let i = 0; i < 16; i++) {
      if (off + i < end) {
        const b = bytes[off + i];
        const h = b.toString(16).padStart(2, '0');
        key += h;
        if (i < 8) {
          hexLeft += (i > 0 ? ' ' : '') + h;
        } else {
          hexRight += (i > 8 ? ' ' : '') + h;
        }
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
      } else {
        if (i < 8) {
          hexLeft += (i > 0 ? ' ' : '') + '  ';
        } else {
          hexRight += (i > 8 ? ' ' : '') + '  ';
        }
      }
    }

    const isLast = end >= bytes.byteLength;
    if (!isLast && prevLineHex === key) {
      if (!skipping) {
        lines.push('*');
        skipping = true;
      }
      continue;
    }

    skipping = false;
    prevLineHex = key;
    const addr = (baseOffset + off).toString(16).padStart(4, '0');
    lines.push(`${addr}  ${hexLeft}  ${hexRight}  |${ascii}|`);
  }

  return lines.join('\n');
}
