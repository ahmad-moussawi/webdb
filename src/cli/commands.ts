import { writeFile } from 'node:fs/promises';
import {
  PAGE_SIZE,
  PAGE_HEADER_SIZE,
  OVERFLOW_HEADER_SIZE,
  OVERFLOW_PAYLOAD_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
  WAL_FRAME_TYPE_TX_COMMIT,
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_UNCOMMITTED,
} from '../constants.js';
import type { TableMeta, IndexDescriptor, DbRow } from '../types/index.js';
import { WebDB } from '../host/api/webdb.js';
import type { QueryBuilder } from '../host/api/query_builder.js';
import { recoverFromWal } from '../host/driver/crash_recovery.js';
import { NodeFsStorage } from '../host/storage/node_fs.js';
import { computePageChecksum, computePage1Checksum } from '../host/storage/crc32.js';
import { decodeWalFileHeader, validateWalFrame } from '../host/storage/wal_codec.js';
import {
  catalog_read_page1_header,
  catalog_read_page_header,
  catalog_list_table_descriptors,
  catalog_list_all_indexes,
} from '../core/js/catalog.c.js';
import {
  page_get_type,
  page_get_cell_count,
  page_get_cell_content_offset,
  page_get_next_page_id,
  page_get_free_bytes,
  page_get_checksum,
  page_get_cell_offset,
  page_deserialize_row,
  page_get_overflow_chunk_size,
  page_get_overflow_next_page_id,
  type OverflowDescriptorInfo,
} from '../core/js/page.c.js';
import {
  CliUsageError,
  parseCliArgs,
  parseJoinSpec,
  parseOrderSpec,
  parseOutputFormat,
  parsePositiveInt,
  splitTopLevelComma,
  type FlagDef,
  type ParsedArgs,
} from './args.js';
import {
  formatBytes,
  formatColumnFlags,
  formatCsv,
  formatDataType,
  formatHex32,
  formatHexDump,
  formatIndexFlags,
  formatJson,
  formatKeyValue,
  formatNdjson,
  formatPageType,
  formatRowsOutput,
  formatTable,
  toJsonSafe,
  type OutputFormat,
} from './format.js';
import {
  assertDbFileExists,
  getOptionalFileSize,
  openReadOnlyDb,
  statDbFile,
  type CoreMode,
} from './open.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CommandContext {
  core: CoreMode;
  io: CliIo;
}

const MAX_SLOTS_PER_PAGE = Math.floor((PAGE_SIZE - PAGE_HEADER_SIZE) / 2); // 2040
const PAGE_SCAN_BATCH_SIZE = 1024;
const textDecoder = new TextDecoder();

const VALID_PAGE_TYPES = new Set<number>([
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
]);

export const INFO_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
];

export const TABLES_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
  { name: 'exact-count', type: 'boolean' },
];

export const SCHEMA_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
];

export const INDEXES_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
];

const BASE_QUERY_FLAG_DEFS: FlagDef[] = [
  { name: 'select', short: 's', type: 'string', multiple: true },
  { name: 'where', short: 'w', type: 'string', multiple: true },
  { name: 'or-where', type: 'string', multiple: true },
  { name: 'join', type: 'string', multiple: true },
  { name: 'left-join', type: 'string', multiple: true },
  { name: 'group-by', short: 'g', type: 'string', multiple: true },
  { name: 'having', type: 'string', multiple: true },
  { name: 'order', short: 'o', type: 'string', multiple: true },
  { name: 'limit', short: 'l', type: 'string' },
  { name: 'offset', type: 'string' },
  { name: 'format', short: 'f', type: 'string' },
];

export const QUERY_FLAG_DEFS: FlagDef[] = [
  ...BASE_QUERY_FLAG_DEFS,
  { name: 'count', type: 'boolean' },
];

export const EXPLAIN_FLAG_DEFS: FlagDef[] = BASE_QUERY_FLAG_DEFS;

export const PAGE_FLAG_DEFS: FlagDef[] = [
  { name: 'hex', type: 'boolean' },
  { name: 'rows', type: 'boolean' },
  { name: 'raw', type: 'boolean' },
  { name: 'format', short: 'f', type: 'string' },
];

export const VERIFY_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
];

export const DUMP_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
  { name: 'out', short: 'o', type: 'string' },
];

export const CHECKPOINT_FLAG_DEFS: FlagDef[] = [
  { name: 'format', short: 'f', type: 'string' },
];

function writeFormattedRows(
  io: CliIo,
  columns: string[],
  rows: Record<string, unknown>[],
  format: OutputFormat,
): void {
  const rendered = formatRowsOutput(columns, rows, format);
  if (format === 'ndjson' && rows.length === 0) {
    return;
  }
  io.stdout(rendered + '\n');
}

// ============================================================================
// 1. info
// ============================================================================

export async function cmdInfo(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, INFO_FLAG_DEFS);
  if (positionals.length !== 1) {
    throw new CliUsageError('Usage: webdb info <file> [--format table|json]');
  }

  const filePath = positionals[0];
  const format = parseOutputFormat(values.format as string | undefined, ['table', 'json'], 'table');

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    const page1Bytes = opened.db.pool.getPageBytesInSlot(0);
    const page1View = new DataView(page1Bytes.buffer, page1Bytes.byteOffset, PAGE_SIZE);
    const header = catalog_read_page1_header(page1View, false);
    const computedP1 = computePage1Checksum(page1Bytes);
    const page1ChecksumStatus =
      header.storedChecksum === 0
        ? 'unstamped (0)'
        : header.storedChecksum === computedP1
          ? 'valid'
          : `mismatch (stored ${formatHex32(header.storedChecksum)}, computed ${formatHex32(computedP1)})`;

    const tables = await opened.db.listTables();
    const indexes = await opened.db.listIndexes();

    const pageTypeCounts: Record<string, number> = {
      HEADER_CATALOG: 1,
      CATALOG_PAGE: 0,
      LEAF_DATA: 0,
      TABLE_INTERIOR: 0,
      INDEX_LEAF: 0,
      INDEX_INTERIOR: 0,
      OVERFLOW: 0,
      FREE: 0,
      OTHER: 0,
    };

    const physicalPages = Math.max(
      Math.floor(opened.dbFileSize / PAGE_SIZE),
      opened.overlay.maxOverlaidPageId,
    );
    const scanLimit = Math.min(header.totalPages, physicalPages);
    const warnings: string[] = [];
    if (header.totalPages > physicalPages) {
      warnings.push(
        `Page 1 declares totalPages=${header.totalPages}, but only ${physicalPages} page(s) exist in storage`,
      );
    }

    for (let start = 2; start <= scanLimit; start += PAGE_SCAN_BATCH_SIZE) {
      const end = Math.min(scanLimit, start + PAGE_SCAN_BATCH_SIZE - 1);
      const ids: number[] = [];
      for (let p = start; p <= end; p++) ids.push(p);
      const pages = await opened.overlay.readPages(ids);
      for (let i = 0; i < pages.length; i++) {
        const bytes = pages[i];
        if (!bytes) {
          pageTypeCounts.OTHER++;
          continue;
        }
        const label = formatPageType(bytes[0]);
        if (label in pageTypeCounts) {
          pageTypeCounts[label]++;
        } else {
          pageTypeCounts.OTHER++;
        }
      }
    }

    // WAL info from raw disk
    let walHeaderInfo: Record<string, unknown> | null = null;
    const rawWalHeader = await opened.storage.readWalHeader();
    if (rawWalHeader) {
      try {
        const decoded = decodeWalFileHeader(rawWalHeader, true);
        walHeaderInfo = {
          walVersion: decoded.walVersion,
          pageSize: decoded.pageSize,
          checkpointSeq: decoded.checkpointSeq,
          valid: true,
        };
      } catch (err: any) {
        walHeaderInfo = { valid: false, error: err?.message ?? String(err) };
      }
    }

    const summary = {
      file: filePath,
      fileSizeBytes: opened.dbFileSize,
      engineCore: ctx.core,
      pageSize: header.pageSize,
      fileFormatVersion: header.fileFormatVersion,
      minReadVersion: header.minReadVersion,
      totalPages: header.totalPages,
      freePageHead: header.freePageHead,
      schemaVersion: header.schemaVersion,
      changeCounter: header.changeCounter,
      page1Checksum: formatHex32(header.storedChecksum),
      page1ChecksumStatus,
      tableCount: tables.length,
      indexCount: indexes.length,
      wal: {
        path: opened.storage.walPath,
        exists: opened.walFileSize !== null,
        sizeBytes: opened.walFileSize ?? 0,
        framesOnDisk: opened.walFramesOnDisk,
        replayedInMemory: opened.overlay.replayedPageCount,
        header: walHeaderInfo,
      },
      pageBreakdown: pageTypeCounts,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (format === 'json') {
      ctx.io.stdout(formatJson(summary) + '\n');
      return 0;
    }

    const entries: Array<[string, string | number]> = [
      ['File', `${filePath} (${formatBytes(opened.dbFileSize)})`],
      ['Format Version', `${header.fileFormatVersion} (min read: ${header.minReadVersion})`],
      ['Page Size', `${header.pageSize} bytes`],
      ['Total Pages', `${header.totalPages} (${formatBytes(header.totalPages * header.pageSize)})`],
      ['Free Page Head', header.freePageHead === 0 ? '0 (none)' : String(header.freePageHead)],
      ['Schema Version', header.schemaVersion],
      ['Change Counter', header.changeCounter],
      ['Page 1 Checksum', `${formatHex32(header.storedChecksum)} (${page1ChecksumStatus})`],
      ['Tables', tables.length],
      ['Indexes', indexes.length],
      [
        'WAL Status',
        opened.walFileSize === null
          ? 'none'
          : `${formatBytes(opened.walFileSize)}, ${opened.walFramesOnDisk} frame(s)` +
            (opened.overlay.replayedPageCount > 0
              ? ` (${opened.overlay.replayedPageCount} page(s) overlaid read-only)`
              : ''),
      ],
    ];

    ctx.io.stdout(formatKeyValue(entries) + '\n\n');
    const breakdownRows = Object.entries(pageTypeCounts)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({
        page_type: type,
        pages: count,
        size: formatBytes(count * header.pageSize),
      }));
    ctx.io.stdout(formatTable(['page_type', 'pages', 'size'], breakdownRows) + '\n');
    if (warnings.length > 0) {
      ctx.io.stdout('\nWarnings:\n' + warnings.map((w) => `  - ${w}`).join('\n') + '\n');
    }
    return 0;
  } finally {
    await opened.close();
  }
}

// ============================================================================
// 2. tables
// ============================================================================

export async function cmdTables(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, TABLES_FLAG_DEFS);
  if (positionals.length !== 1) {
    throw new CliUsageError(
      'Usage: webdb tables <file> [--exact-count] [--format table|json|ndjson|csv]',
    );
  }

  const filePath = positionals[0];
  const format = parseOutputFormat(values.format as string | undefined);
  const exactCount = Boolean(values['exact-count']);

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    const tables = await opened.db.listTables();
    const rows: Record<string, unknown>[] = [];

    for (const t of tables) {
      let rowCount: number = t.rowCountEstimate;
      if (exactCount) {
        const countRows = await opened.db.from(t.name).count('*', 'count').toArray();
        rowCount = Number(countRows[0]?.count ?? 0);
      }
      rows.push({
        id: t.tableId,
        name: t.name,
        columns: t.columns.length,
        rows: rowCount,
        primary_key: t.primaryKey?.join(', ') || '-',
        indexes: t.indexes?.length ?? 0,
        root_page: t.rootPageId,
      });
    }

    if (rows.length === 0 && format === 'table') {
      ctx.io.stdout('(no tables)\n');
      return 0;
    }

    writeFormattedRows(
      ctx.io,
      ['id', 'name', 'columns', 'rows', 'primary_key', 'indexes', 'root_page'],
      rows,
      format,
    );
    return 0;
  } finally {
    await opened.close();
  }
}

// ============================================================================
// 3. schema
// ============================================================================

function formatIndexColumns(idx: IndexDescriptor, table?: TableMeta): string {
  const parts: string[] = [];
  for (let i = 0; i < idx.columnCount; i++) {
    const colIdx = idx.columnIndices[i];
    const colName = table?.columns[colIdx]?.name ?? `col#${colIdx}`;
    const dir = idx.colDirections[i] === 1 ? 'DESC' : 'ASC';
    parts.push(`${colName} ${dir}`);
  }
  return parts.join(', ');
}

export async function cmdSchema(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, SCHEMA_FLAG_DEFS);
  if (positionals.length < 1 || positionals.length > 2) {
    throw new CliUsageError('Usage: webdb schema <file> [table] [--format table|json]');
  }

  const filePath = positionals[0];
  const tableName = positionals[1];
  const format = parseOutputFormat(values.format as string | undefined, ['table', 'json'], 'table');

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    const tables: TableMeta[] = tableName
      ? [await opened.db.getTable(tableName)]
      : await opened.db.listTables();

    if (format === 'json') {
      const payload = tables.map((t) => ({
        tableId: t.tableId,
        name: t.name,
        rootPageId: t.rootPageId,
        colCatalogPageId: t.colCatalogPageId,
        rowCountEstimate: t.rowCountEstimate,
        autoIncNext: t.autoIncNext.toString(),
        primaryKey: t.primaryKey ?? [],
        columns: t.columns.map((c, idx) => ({
          index: idx,
          name: c.name,
          type: formatDataType(c.type),
          flags: formatColumnFlags(c.flags),
          rawFlags: c.flags,
          colOffset: c.colOffset,
        })),
        indexes: (t.indexes ?? []).map((ix) => ({
          indexId: ix.indexId,
          name: ix.name,
          rootPageId: ix.rootPageId,
          flags: formatIndexFlags(ix.flags),
          columns: formatIndexColumns(ix, t),
        })),
      }));
      ctx.io.stdout(formatJson(tableName ? payload[0] : payload) + '\n');
      return 0;
    }

    if (tables.length === 0) {
      ctx.io.stdout('(no tables)\n');
      return 0;
    }

    const sections: string[] = [];
    for (const t of tables) {
      const header =
        `Table: ${t.name} (id=${t.tableId}, rootPage=${t.rootPageId}, ` +
        `catalogPage=${t.colCatalogPageId}, estRows=${t.rowCountEstimate}, autoIncNext=${t.autoIncNext})`;
      const colRows = t.columns.map((c, idx) => ({
        '#': idx,
        name: c.name,
        type: formatDataType(c.type),
        flags: formatColumnFlags(c.flags),
        offset: c.colOffset,
      }));
      let section = header + '\n' + formatTable(['#', 'name', 'type', 'flags', 'offset'], colRows);
      if (t.indexes && t.indexes.length > 0) {
        const idxRows = t.indexes.map((ix) => ({
          id: ix.indexId,
          name: ix.name,
          columns: formatIndexColumns(ix, t),
          flags: formatIndexFlags(ix.flags),
          root_page: ix.rootPageId,
        }));
        section +=
          '\nIndexes:\n' +
          formatTable(['id', 'name', 'columns', 'flags', 'root_page'], idxRows);
      }
      sections.push(section);
    }

    ctx.io.stdout(sections.join('\n\n') + '\n');
    return 0;
  } finally {
    await opened.close();
  }
}

// ============================================================================
// 4. indexes
// ============================================================================

export async function cmdIndexes(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, INDEXES_FLAG_DEFS);
  if (positionals.length < 1 || positionals.length > 2) {
    throw new CliUsageError(
      'Usage: webdb indexes <file> [table] [--format table|json|ndjson|csv]',
    );
  }

  const filePath = positionals[0];
  const tableName = positionals[1];
  const format = parseOutputFormat(values.format as string | undefined);

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    const tables = await opened.db.listTables();
    const tableById = new Map<number, TableMeta>();
    for (const t of tables) tableById.set(t.tableId, t);

    const indexes = await opened.db.listIndexes(tableName);
    const rows = indexes.map((ix) => {
      const tbl = tableById.get(ix.tableId);
      return {
        id: ix.indexId,
        name: ix.name,
        table: tbl?.name ?? `table#${ix.tableId}`,
        columns: formatIndexColumns(ix, tbl),
        flags: formatIndexFlags(ix.flags),
        root_page: ix.rootPageId,
      };
    });

    if (rows.length === 0 && format === 'table') {
      ctx.io.stdout('(no indexes)\n');
      return 0;
    }

    writeFormattedRows(
      ctx.io,
      ['id', 'name', 'table', 'columns', 'flags', 'root_page'],
      rows,
      format,
    );
    return 0;
  } finally {
    await opened.close();
  }
}

// ============================================================================
// 5 & 6. query & explain
// ============================================================================

function buildQueryFromFlags(
  db: WebDB,
  tableName: string,
  parsed: ParsedArgs,
): QueryBuilder {
  const { values, entries } = parsed;
  let qb = db.from(tableName);

  const selects = values.select as string[];
  const selectItems: string[] = [];
  for (const s of selects) {
    selectItems.push(...splitTopLevelComma(s));
  }
  if (selectItems.length > 0) {
    qb = qb.select(...selectItems);
  }

  // Replay joins in the exact CLI order so chained LEFT JOIN + INNER JOIN preserve semantics
  for (const entry of entries) {
    if (entry.name === 'join') {
      const j = parseJoinSpec(String(entry.value));
      qb = qb.join(j.table, j.leftCol, j.op, j.rightCol);
    } else if (entry.name === 'left-join') {
      const j = parseJoinSpec(String(entry.value));
      qb = qb.leftJoin(j.table, j.leftCol, j.op, j.rightCol);
    }
  }

  // Replay WHERE / OR WHERE in exact CLI order
  for (const entry of entries) {
    if (entry.name === 'where') {
      qb = qb.where(String(entry.value));
    } else if (entry.name === 'or-where') {
      qb = qb.orWhere(String(entry.value));
    }
  }

  const groupBys = values['group-by'] as string[];
  const groupCols: string[] = [];
  for (const g of groupBys) {
    groupCols.push(...splitTopLevelComma(g));
  }
  if (groupCols.length > 0) {
    qb = qb.groupBy(...groupCols);
  }

  for (const expr of values.having as string[]) {
    qb = qb.having(expr);
  }

  for (const rawOrder of values.order as string[]) {
    for (const part of splitTopLevelComma(rawOrder)) {
      const spec = parseOrderSpec(part);
      qb = qb.orderBy(spec.col, spec.direction, spec.nullOrder);
    }
  }

  if (typeof values.limit === 'string') {
    qb = qb.limit(parsePositiveInt(values.limit, '--limit', true));
  }
  if (typeof values.offset === 'string') {
    qb = qb.offset(parsePositiveInt(values.offset, '--offset', true));
  }

  return qb;
}

function collectColumns(rows: DbRow[], fallbackCols: string[]): string[] {
  if (rows.length === 0) return fallbackCols;
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

export async function cmdQuery(argv: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseCliArgs(argv, QUERY_FLAG_DEFS);
  const { positionals, values } = parsed;
  if (positionals.length !== 2) {
    throw new CliUsageError(
      'Usage: webdb query <file> <table> [--select <expr>] [--where <expr>] [--order <col[:asc|desc]>] [--limit <n>] [--offset <n>] [--format table|json|ndjson|csv]',
    );
  }

  const [filePath, tableName] = positionals;
  const format = parseOutputFormat(values.format as string | undefined);
  const countOnly = Boolean(values.count);
  const hasGroupBy = (values['group-by'] as string[]).length > 0;

  if (countOnly && hasGroupBy) {
    throw new CliUsageError(
      'Cannot combine --count with --group-by; use --select "<group>, count(*) as count" --group-by "<group>" instead',
    );
  }

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    const tableMeta = await opened.db.getTable(tableName);
    const qb = buildQueryFromFlags(opened.db, tableName, parsed);

    if (countOnly) {
      const countRows = await qb.count('*', 'count').toArray();
      const total = Number(countRows[0]?.count ?? 0);
      if (format === 'json') {
        ctx.io.stdout(formatJson({ count: total }) + '\n');
      } else if (format === 'ndjson') {
        ctx.io.stdout(JSON.stringify({ count: total }) + '\n');
      } else if (format === 'csv') {
        ctx.io.stdout(`count\n${total}\n`);
      } else {
        ctx.io.stdout(`${total}\n`);
      }
      return 0;
    }

    const rows = await qb.toArray();
    const selectFields = qb.getSelectFields();
    const fallbackCols =
      selectFields.length > 0
        ? selectFields.map((f) => f.alias)
        : tableMeta.columns.map((c) => c.name);
    const columns = collectColumns(rows, fallbackCols);

    if (rows.length === 0 && format === 'table') {
      ctx.io.stdout('(0 rows)\n');
      return 0;
    }

    writeFormattedRows(ctx.io, columns, rows, format);
    return 0;
  } finally {
    await opened.close();
  }
}

export async function cmdExplain(argv: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseCliArgs(argv, EXPLAIN_FLAG_DEFS);
  const { positionals, values } = parsed;
  if (positionals.length !== 2) {
    throw new CliUsageError(
      'Usage: webdb explain <file> <table> [--select <expr>] [--where <expr>] [--order <spec>] [--limit <n>] [--format table|json]',
    );
  }

  const [filePath, tableName] = positionals;
  const format = parseOutputFormat(values.format as string | undefined, ['table', 'json'], 'table');

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    const qb = buildQueryFromFlags(opened.db, tableName, parsed);
    const result = await qb.explain();

    if (format === 'json') {
      ctx.io.stdout(formatJson(result) + '\n');
      return 0;
    }

    const planEntries: Array<[string, string | number | boolean]> = [
      ['Table', result.plan.table],
      ['Root Page', result.plan.rootPageId],
      ['Scan Type', result.plan.scanType],
    ];
    if (result.plan.indexName) {
      planEntries.push(['Index', result.plan.indexName]);
    }
    if (result.plan.filters.length > 0) {
      planEntries.push(['Filters', result.plan.filters.length]);
    }
    if (result.plan.orderBy && result.plan.orderBy.length > 0) {
      planEntries.push([
        'Order By',
        result.plan.orderBy
          .map((k) => `${k.colName ?? 'expr'} ${(k.direction ?? 'asc').toUpperCase()}`)
          .join(', '),
      ]);
    }
    if (result.plan.isOrderSatisfied !== undefined) {
      planEntries.push(['Order Satisfied by Index', result.plan.isOrderSatisfied]);
    }
    if (result.plan.limit !== undefined) {
      planEntries.push(['Limit', result.plan.limit]);
    }
    if (result.plan.offset !== undefined) {
      planEntries.push(['Offset', result.plan.offset]);
    }
    planEntries.push([
      'Bytecode Size',
      `${result.bytecodeSize} bytes (${result.instructions.length} ops)`,
    ]);

    ctx.io.stdout(formatKeyValue(planEntries) + '\n\n');
    ctx.io.stdout(result.assembly);
    return 0;
  } finally {
    await opened.close();
  }
}

// ============================================================================
// 7. page
// ============================================================================

async function mapPagesToTables(
  tables: TableMeta[],
  readPage: (pageId: number) => Promise<Uint8Array | null>,
): Promise<Map<number, TableMeta>> {
  const owners = new Map<number, TableMeta>();
  const visited = new Set<number>();

  for (const table of tables) {
    const queue: number[] = [];
    if (table.rootPageId >= 2) queue.push(table.rootPageId);

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (pid < 2 || visited.has(pid)) continue;
      visited.add(pid);

      const bytes = await readPage(pid);
      if (!bytes) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, PAGE_SIZE);
      const ptype = page_get_type(view, 0);

      if (ptype === PAGE_TYPE_LEAF_DATA) {
        owners.set(pid, table);
        const nextPid = page_get_next_page_id(view, 0);
        if (nextPid >= 2 && !visited.has(nextPid)) queue.push(nextPid);
      } else if (ptype === PAGE_TYPE_TABLE_INTERIOR) {
        owners.set(pid, table);
        const cellCount = Math.min(page_get_cell_count(view, 0), MAX_SLOTS_PER_PAGE);
        for (let i = 0; i < cellCount; i++) {
          const off = page_get_cell_offset(view, 0, i);
          if (off >= PAGE_HEADER_SIZE && off + 4 <= PAGE_SIZE) {
            const childPid = view.getUint32(off, true);
            if (childPid >= 2 && !visited.has(childPid)) queue.push(childPid);
          }
        }
        const rightChild = page_get_next_page_id(view, 0);
        if (rightChild >= 2 && !visited.has(rightChild)) queue.push(rightChild);
      }
    }
  }

  return owners;
}

async function readOverflowBytesFromVfs(
  firstPageId: number,
  totalLen: number,
  readPage: (pageId: number) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if (totalLen === 0 || firstPageId <= 1) return new Uint8Array(0);
  const result = new Uint8Array(totalLen);
  let copied = 0;
  let currPageId = firstPageId;
  const visited = new Set<number>();

  while (currPageId > 1 && copied < totalLen && !visited.has(currPageId)) {
    visited.add(currPageId);
    const bytes = await readPage(currPageId);
    if (!bytes) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, PAGE_SIZE);
    if (page_get_type(view, 0) !== PAGE_TYPE_OVERFLOW) {
      return null;
    }
    const chunkLen = Math.min(
      page_get_overflow_chunk_size(view, 0),
      OVERFLOW_PAYLOAD_SIZE,
      totalLen - copied,
    );
    const nextPageId = page_get_overflow_next_page_id(view, 0);
    if (chunkLen > 0) {
      result.set(bytes.subarray(OVERFLOW_HEADER_SIZE, OVERFLOW_HEADER_SIZE + chunkLen), copied);
      copied += chunkLen;
    }
    currPageId = nextPageId;
  }

  return copied === totalLen ? result : result.subarray(0, copied);
}

async function hydrateOverflowColumns(
  row: DbRow,
  overflowDescs: OverflowDescriptorInfo[],
  readPage: (pageId: number) => Promise<Uint8Array | null>,
): Promise<void> {
  for (const desc of overflowDescs) {
    const raw = await readOverflowBytesFromVfs(desc.firstPageId, desc.totalLen, readPage);
    if (raw === null) {
      row[desc.colName] = `<OVERFLOW page=${desc.firstPageId} len=${desc.totalLen}>`;
    } else if (desc.isText) {
      row[desc.colName] = textDecoder.decode(raw);
    } else {
      row[desc.colName] = raw;
    }
  }
}

export async function cmdPage(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, PAGE_FLAG_DEFS);
  if (positionals.length !== 2) {
    throw new CliUsageError(
      'Usage: webdb page <file> <pageId> [--rows] [--hex] [--raw] [--format table|json]',
    );
  }

  const filePath = positionals[0];
  const pageId = parsePositiveInt(positionals[1], '<pageId>', false);
  const showHex = Boolean(values.hex);
  const showRows = Boolean(values.rows);
  const rawMode = Boolean(values.raw);
  const format = parseOutputFormat(values.format as string | undefined, ['table', 'json'], 'table');

  await assertDbFileExists(filePath);

  // Open WebDB when possible for table/index catalog metadata, but allow --raw (and
  // fallback inspection of corrupted databases) to read directly from NodeFsStorage.
  let opened: Awaited<ReturnType<typeof openReadOnlyDb>> | null = null;
  let fallbackStorage: NodeFsStorage | null = null;
  let openWarning: string | null = null;

  if (rawMode) {
    fallbackStorage = new NodeFsStorage(filePath, { readOnly: true });
    // Best-effort catalog open only if --rows is requested on a leaf page
    if (showRows && pageId >= 2) {
      try {
        opened = await openReadOnlyDb(filePath, ctx.core);
      } catch (err: any) {
        openWarning = `Catalog unavailable (${err?.message ?? String(err)}); showing raw page only`;
      }
    }
  } else {
    try {
      opened = await openReadOnlyDb(filePath, ctx.core);
    } catch (err: any) {
      openWarning = `Database open failed (${err?.message ?? String(err)}); falling back to raw page inspection`;
      fallbackStorage = new NodeFsStorage(filePath, { readOnly: true });
    }
  }

  try {
    const reader = rawMode || !opened ? fallbackStorage! : opened.overlay;
    const readOnePage = async (pid: number): Promise<Uint8Array | null> => {
      const [b] = await reader.readPages([pid]);
      return b ?? null;
    };

    const pageBytes = await readOnePage(pageId);
    if (!pageBytes) {
      throw new Error(`Page ${pageId} does not exist in ${filePath}`);
    }

    const view = new DataView(pageBytes.buffer, pageBytes.byteOffset, PAGE_SIZE);
    const warnings: string[] = openWarning ? [openWarning] : [];

    if (pageId === 1) {
      let header: ReturnType<typeof catalog_read_page1_header> | null = null;
      let headerError: string | null = null;
      try {
        header = catalog_read_page1_header(view, false);
      } catch (err: any) {
        headerError = err?.message ?? String(err);
        warnings.push(`Page 1 header invalid: ${headerError}`);
      }

      const computed = computePage1Checksum(pageBytes);
      const storedChecksum = header ? header.storedChecksum : view.getUint32(28, true);
      const checksumValid = storedChecksum === 0 || storedChecksum === computed;

      let tablesSummary: Array<{ id: number; name: string; rootPageId: number }> = [];
      let indexesSummary: Array<{ id: number; name: string; rootPageId: number }> = [];

      if (header) {
        if (!rawMode && opened) {
          const tables = await opened.db.listTables();
          const indexes = await opened.db.listIndexes();
          tablesSummary = tables.map((t) => ({ id: t.tableId, name: t.name, rootPageId: t.rootPageId }));
          indexesSummary = indexes.map((ix) => ({ id: ix.indexId, name: ix.name, rootPageId: ix.rootPageId }));
        } else {
          // Decode Page 1 local catalog descriptors directly from raw page bytes
          const rawTables = catalog_list_table_descriptors(view);
          const rawIndexes = catalog_list_all_indexes(view);
          tablesSummary = rawTables.map((t) => ({ id: t.tableId, name: t.name, rootPageId: t.rootPageId }));
          indexesSummary = rawIndexes.map((ix) => ({ id: ix.indexId, name: ix.name, rootPageId: ix.rootPageId }));
        }
      }

      const info = {
        pageId: 1,
        pageType: 'HEADER_CATALOG',
        ...(header
          ? {
              pageSize: header.pageSize,
              fileFormatVersion: header.fileFormatVersion,
              minReadVersion: header.minReadVersion,
              totalPages: header.totalPages,
              freePageHead: header.freePageHead,
              schemaVersion: header.schemaVersion,
              changeCounter: header.changeCounter,
            }
          : { headerError }),
        storedChecksum: formatHex32(storedChecksum),
        computedChecksum: formatHex32(computed),
        checksumValid,
        tables: tablesSummary,
        indexes: indexesSummary,
        ...(warnings.length > 0 ? { warnings } : {}),
      };

      if (format === 'json') {
        ctx.io.stdout(formatJson(info) + '\n');
        return 0;
      }

      const kv: Array<[string, string | number]> = [
        ['Page ID', 1],
        ['Page Type', 'HEADER_CATALOG (Page 1)'],
      ];
      if (header) {
        kv.push(['Total Pages', header.totalPages]);
        kv.push(['Schema Version', header.schemaVersion]);
        kv.push(['Change Counter', header.changeCounter]);
        kv.push(['Free Page Head', header.freePageHead]);
      } else if (headerError) {
        kv.push(['Header Status', `INVALID (${headerError})`]);
      }
      kv.push([
        'Checksum',
        `${formatHex32(storedChecksum)} (computed ${formatHex32(computed)}, ${
          storedChecksum === 0 ? 'unstamped' : checksumValid ? 'valid' : 'MISMATCH'
        })`,
      ]);
      kv.push(['Tables', tablesSummary.map((t) => t.name).join(', ') || '(none)']);
      kv.push(['Indexes', indexesSummary.map((ix) => ix.name).join(', ') || '(none)']);

      ctx.io.stdout(formatKeyValue(kv) + '\n');
      if (warnings.length > 0) {
        ctx.io.stdout('\nWarnings:\n' + warnings.map((w) => `  - ${w}`).join('\n') + '\n');
      }
      if (showHex) {
        ctx.io.stdout('\n' + formatHexDump(pageBytes) + '\n');
      }
      return 0;
    }

    const pageType = page_get_type(view, 0);
    const pageTypeName = formatPageType(pageType, pageId);
    const storedChecksum = page_get_checksum(view, 0);
    const computedChecksum = computePageChecksum(pageBytes);
    const checksumValid = storedChecksum === 0 || storedChecksum === computedChecksum;

    let extra: Record<string, unknown> = {};
    const decodedRows: Array<{ slot: number; offset: number; row: DbRow }> = [];
    let ownerTable: TableMeta | undefined;

    if (pageType === PAGE_TYPE_FREE) {
      extra = {
        nextFreePageId: page_get_next_page_id(view, 0),
      };
    } else if (pageType === PAGE_TYPE_CATALOG_PAGE) {
      const catHdr = catalog_read_page_header(view, 0);
      extra = {
        tableId: catHdr.tableId,
        colCountInPage: catHdr.colCountInPage,
        startColIndex: catHdr.startColIndex,
        nextColCatalogPageId: catHdr.nextColCatalogPageId,
      };
    } else if (pageType === PAGE_TYPE_OVERFLOW) {
      extra = {
        chunkSize: page_get_overflow_chunk_size(view, 0),
        nextOverflowPageId: page_get_overflow_next_page_id(view, 0),
      };
    } else {
      const rawCellCount = page_get_cell_count(view, 0);
      const safeCellCount = Math.min(rawCellCount, MAX_SLOTS_PER_PAGE);
      if (rawCellCount > MAX_SLOTS_PER_PAGE) {
        warnings.push(
          `Corrupt cellCount=${rawCellCount} exceeds max slots per page (${MAX_SLOTS_PER_PAGE}); clamped`,
        );
      }

      const contentOffset = page_get_cell_content_offset(view, 0);
      const nextPageId = page_get_next_page_id(view, 0);
      const fragmentedFree = page_get_free_bytes(view, 0);
      const slotDirEnd = PAGE_HEADER_SIZE + safeCellCount * 2;
      const contiguousFree = Math.max(0, contentOffset - slotDirEnd);
      const offsets: number[] = [];
      for (let i = 0; i < safeCellCount; i++) {
        offsets.push(page_get_cell_offset(view, 0, i));
      }

      extra = {
        cellCount: rawCellCount,
        cellContentOffset: contentOffset,
        slotDirEnd,
        contiguousFreeBytes: contiguousFree,
        fragmentedFreeBytes: fragmentedFree,
        totalFreeBytes: contiguousFree + fragmentedFree,
        nextPageId,
        cellOffsets: offsets,
      };

      if (
        opened &&
        (pageType === PAGE_TYPE_LEAF_DATA || pageType === PAGE_TYPE_TABLE_INTERIOR)
      ) {
        const tables = await opened.db.listTables();
        const owners = await mapPagesToTables(tables, readOnePage);
        ownerTable = owners.get(pageId);
        if (ownerTable) {
          extra.ownerTable = ownerTable.name;
        }

        if (pageType === PAGE_TYPE_LEAF_DATA && ownerTable && (showRows || format === 'json')) {
          for (let i = 0; i < safeCellCount; i++) {
            const off = offsets[i];
            if (off < PAGE_HEADER_SIZE || off >= PAGE_SIZE) {
              warnings.push(`Slot ${i}: out-of-bounds cell offset ${off}`);
              continue;
            }
            const overflowDescs: OverflowDescriptorInfo[] = [];
            try {
              const row = page_deserialize_row(
                ownerTable,
                view,
                off,
                undefined,
                overflowDescs,
              );
              if (row) {
                if (overflowDescs.length > 0) {
                  await hydrateOverflowColumns(row, overflowDescs, readOnePage);
                }
                decodedRows.push({ slot: i, offset: off, row });
              }
            } catch (err: any) {
              warnings.push(`Slot ${i} (offset ${off}): failed to decode row (${err?.message ?? String(err)})`);
            }
          }
        }
      }
    }

    const payload = {
      pageId,
      pageType: pageTypeName,
      pageTypeByte: pageType,
      storedChecksum: formatHex32(storedChecksum),
      computedChecksum: formatHex32(computedChecksum),
      checksumValid,
      ...extra,
      ...(decodedRows.length > 0 ? { rows: decodedRows } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (format === 'json') {
      ctx.io.stdout(formatJson(payload) + '\n');
      return 0;
    }

    const kv: Array<[string, string | number]> = [
      ['Page ID', pageId],
      ['Page Type', `${pageTypeName} (0x${pageType.toString(16).padStart(2, '0')})`],
      [
        'Checksum',
        `${formatHex32(storedChecksum)} (computed ${formatHex32(computedChecksum)}, ${
          storedChecksum === 0 ? 'unstamped' : checksumValid ? 'valid' : 'MISMATCH'
        })`,
      ],
    ];
    if (ownerTable) kv.push(['Owner Table', ownerTable.name]);
    if (pageType === PAGE_TYPE_FREE) {
      kv.push(['Next Free Page ID', extra.nextFreePageId as number]);
    } else if (pageType === PAGE_TYPE_CATALOG_PAGE) {
      kv.push(['Table ID', extra.tableId as number]);
      kv.push(['Columns in Page', extra.colCountInPage as number]);
      kv.push(['Start Col Index', extra.startColIndex as number]);
      kv.push(['Next Catalog Page', extra.nextColCatalogPageId as number]);
    } else if (pageType === PAGE_TYPE_OVERFLOW) {
      kv.push(['Chunk Size', `${extra.chunkSize} bytes`]);
      kv.push(['Next Overflow Page', extra.nextOverflowPageId as number]);
    } else {
      kv.push(['Cell Count', extra.cellCount as number]);
      kv.push(['Cell Content Offset', extra.cellContentOffset as number]);
      kv.push([
        'Free Space',
        `${extra.totalFreeBytes} bytes (${extra.contiguousFreeBytes} contiguous + ${extra.fragmentedFreeBytes} fragmented)`,
      ]);
      const isInterior =
        pageType === PAGE_TYPE_TABLE_INTERIOR || pageType === PAGE_TYPE_INDEX_INTERIOR;
      kv.push([isInterior ? 'Right Child Page' : 'Next Page ID', extra.nextPageId as number]);
    }

    ctx.io.stdout(formatKeyValue(kv) + '\n');

    if (warnings.length > 0) {
      ctx.io.stdout('\nWarnings:\n' + warnings.map((w) => `  - ${w}`).join('\n') + '\n');
    }

    if (showRows && ownerTable && pageType === PAGE_TYPE_LEAF_DATA) {
      ctx.io.stdout('\n');
      if (decodedRows.length === 0) {
        ctx.io.stdout('(no rows in page)\n');
      } else {
        const cols = ['_slot', '_offset', ...ownerTable.columns.map((c) => c.name)];
        const tableRows = decodedRows.map((entry) => ({
          _slot: entry.slot,
          _offset: entry.offset,
          ...entry.row,
        }));
        ctx.io.stdout(formatTable(cols, tableRows) + '\n');
      }
    }

    if (showHex) {
      ctx.io.stdout('\n' + formatHexDump(pageBytes) + '\n');
    }

    return 0;
  } finally {
    if (opened) await opened.close();
    if (fallbackStorage) await fallbackStorage.close();
  }
}

// ============================================================================
// 8. verify
// ============================================================================

export async function cmdVerify(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, VERIFY_FLAG_DEFS);
  if (positionals.length !== 1) {
    throw new CliUsageError('Usage: webdb verify <file> [--format table|json]');
  }

  const filePath = positionals[0];
  const format = parseOutputFormat(values.format as string | undefined, ['table', 'json'], 'table');

  const { size: fileSize } = await statDbFile(filePath);
  const storage = new NodeFsStorage(filePath, { readOnly: true });

  const errors: string[] = [];
  const warnings: string[] = [];
  let pagesChecked = 0;
  let validChecksumPages = 0;
  let unstampedChecksumPages = 0;
  let corruptPages = 0;
  let headerTotalPages = 0;
  let walSummary: Record<string, unknown> = { present: false };

  try {
    if (fileSize < PAGE_SIZE || fileSize % PAGE_SIZE !== 0) {
      errors.push(
        `File size (${fileSize} bytes) is not a non-zero multiple of ${PAGE_SIZE} bytes`,
      );
    }

    const physicalPages = Math.floor(fileSize / PAGE_SIZE);
    const [page1] = physicalPages >= 1 ? await storage.readPages([1]) : [null];
    if (!page1) {
      errors.push('Could not read Page 1 (file is smaller than 4096 bytes)');
    } else {
      pagesChecked = 1;
      const p1View = new DataView(page1.buffer, page1.byteOffset, PAGE_SIZE);
      try {
        const hdr = catalog_read_page1_header(p1View, false);
        headerTotalPages = hdr.totalPages;
        const computed = computePage1Checksum(page1);
        if (hdr.storedChecksum === 0) {
          unstampedChecksumPages++;
        } else if (hdr.storedChecksum === computed) {
          validChecksumPages++;
        } else {
          corruptPages++;
          errors.push(
            `Page 1 checksum mismatch: stored ${formatHex32(hdr.storedChecksum)}, computed ${formatHex32(computed)}`,
          );
        }

        if (hdr.totalPages < 1) {
          errors.push(`Page 1 declares invalid totalPages=${hdr.totalPages} (must be >= 1)`);
        } else if (hdr.totalPages > physicalPages) {
          errors.push(
            `Page 1 declares totalPages=${hdr.totalPages}, but file only holds ${physicalPages} page(s)`,
          );
        } else if (hdr.totalPages < physicalPages) {
          warnings.push(
            `File has ${physicalPages} physical page(s), while Page 1 declares totalPages=${hdr.totalPages}`,
          );
        }
      } catch (err: any) {
        corruptPages++;
        errors.push(`Page 1 header invalid: ${err?.message ?? String(err)}`);
      }
    }

    const pagesToCheck =
      headerTotalPages >= 1 ? Math.min(headerTotalPages, physicalPages) : physicalPages;
    for (let start = 2; start <= pagesToCheck; start += PAGE_SCAN_BATCH_SIZE) {
      const end = Math.min(pagesToCheck, start + PAGE_SCAN_BATCH_SIZE - 1);
      const ids: number[] = [];
      for (let p = start; p <= end; p++) ids.push(p);
      const pages = await storage.readPages(ids);

      for (let i = 0; i < pages.length; i++) {
        const pid = start + i;
        const bytes = pages[i];
        pagesChecked++;
        if (!bytes) {
          corruptPages++;
          errors.push(`Page ${pid}: missing/unreadable`);
          continue;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, PAGE_SIZE);
        const ptype = page_get_type(view, 0);
        if (!VALID_PAGE_TYPES.has(ptype)) {
          warnings.push(
            `Page ${pid}: unrecognized page type 0x${ptype.toString(16).padStart(2, '0')}`,
          );
        }
        const stored = page_get_checksum(view, 0);
        const computed = computePageChecksum(bytes);
        if (stored === 0) {
          unstampedChecksumPages++;
        } else if (stored === computed) {
          validChecksumPages++;
        } else {
          corruptPages++;
          errors.push(
            `Page ${pid} checksum mismatch: stored ${formatHex32(stored)}, computed ${formatHex32(computed)}`,
          );
        }
      }
    }

    // Check WAL if present
    const walSize = await getOptionalFileSize(storage.walPath);
    if (walSize !== null && walSize > 0) {
      const walFrameCount = await storage.getWalFrameCount();
      const rawWalHeader = await storage.readWalHeader();
      let walHeaderValid = false;
      let validFrames = 0;
      let committedTx = 0;
      let uncommittedTx = 0;
      let invalidFrames = 0;

      if (!rawWalHeader) {
        errors.push(`WAL file exists (${walSize} bytes) but is smaller than 32-byte header`);
      } else {
        try {
          const decodedWal = decodeWalFileHeader(rawWalHeader, true);
          if (decodedWal.pageSize !== PAGE_SIZE) {
            errors.push(
              `WAL header pageSize mismatch: expected ${PAGE_SIZE}, got ${decodedWal.pageSize}`,
            );
          } else {
            walHeaderValid = true;
          }
        } catch (err: any) {
          errors.push(`WAL header corrupt: ${err?.message ?? String(err)}`);
        }

        if (walHeaderValid && walFrameCount > 0) {
          const seenTxs = new Set<number>();
          const committedTxs = new Set<number>();
          let halted = false;

          for (
            let start = 0;
            start < walFrameCount && !halted;
            start += PAGE_SCAN_BATCH_SIZE
          ) {
            const count = Math.min(PAGE_SCAN_BATCH_SIZE, walFrameCount - start);
            const frames = await storage.readWalFrames(start, count);
            for (let i = 0; i < frames.length; i++) {
              const frameIdx = start + i;
              const res = validateWalFrame(frames[i]);
              if (!res.valid || !res.header) {
                invalidFrames++;
                errors.push(`WAL frame ${frameIdx}: ${res.reason ?? 'invalid'}`);
                halted = true;
                break;
              }
              if (res.header.frameSeq !== validFrames + 1) {
                invalidFrames++;
                errors.push(
                  `WAL frame ${frameIdx}: sequence gap (expected ${validFrames + 1}, got ${res.header.frameSeq})`,
                );
                halted = true;
                break;
              }
              validFrames++;
              seenTxs.add(res.header.txId);
              if (res.header.frameType === WAL_FRAME_TYPE_TX_COMMIT) {
                committedTxs.add(res.header.txId);
              } else if (
                res.header.frameType !== WAL_FRAME_TYPE_PAGE_DATA &&
                res.header.frameType !== WAL_FRAME_TYPE_TX_UNCOMMITTED
              ) {
                warnings.push(`WAL frame ${frameIdx}: unknown frameType ${res.header.frameType}`);
              }
            }
          }
          committedTx = committedTxs.size;
          uncommittedTx = seenTxs.size - committedTxs.size;
        }
      }

      walSummary = {
        present: true,
        path: storage.walPath,
        sizeBytes: walSize,
        headerValid: walHeaderValid,
        frameCount: walFrameCount,
        validFrames,
        invalidFrames,
        committedTx,
        uncommittedTx,
      };
    }

    const ok = errors.length === 0;
    const report = {
      file: filePath,
      ok,
      fileSizeBytes: fileSize,
      pagesChecked,
      validChecksumPages,
      unstampedChecksumPages,
      corruptPages,
      wal: walSummary,
      warnings,
      errors,
    };

    if (format === 'json') {
      ctx.io.stdout(formatJson(report) + '\n');
    } else {
      ctx.io.stdout(
        formatKeyValue([
          ['File', filePath],
          ['Status', ok ? 'OK' : 'FAILED'],
          ['Pages Checked', pagesChecked],
          ['Valid Checksums', validChecksumPages],
          ['Unstamped Checksums', unstampedChecksumPages],
          ['Corrupt Pages', corruptPages],
          ['Warnings', warnings.length],
          ['Errors', errors.length],
        ]) + '\n',
      );
      if (warnings.length > 0) {
        ctx.io.stdout('\nWarnings:\n' + warnings.map((w) => `  - ${w}`).join('\n') + '\n');
      }
      if (errors.length > 0) {
        ctx.io.stdout('\nErrors:\n' + errors.map((e) => `  - ${e}`).join('\n') + '\n');
      }
    }

    return ok ? 0 : 1;
  } finally {
    await storage.close();
  }
}

// ============================================================================
// 9. dump
// ============================================================================

export async function cmdDump(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, DUMP_FLAG_DEFS);
  if (positionals.length < 1 || positionals.length > 2) {
    throw new CliUsageError(
      'Usage: webdb dump <file> [table] [--format json|ndjson|csv] [--out <path>]',
    );
  }

  const filePath = positionals[0];
  const tableName = positionals[1];
  const allowed: OutputFormat[] = tableName ? ['json', 'ndjson', 'csv'] : ['json'];
  const format = parseOutputFormat(values.format as string | undefined, allowed, 'json');
  const outPath = values.out as string | undefined;

  const opened = await openReadOnlyDb(filePath, ctx.core);
  try {
    let output: string;

    if (tableName) {
      const tableMeta = await opened.db.getTable(tableName);
      const rows = await opened.db.from(tableName).toArray();
      const cols = tableMeta.columns.map((c) => c.name);
      if (format === 'csv') {
        output = formatCsv(cols, rows) + '\n';
      } else if (format === 'ndjson') {
        output = formatNdjson(rows) + (rows.length > 0 ? '\n' : '');
      } else {
        output = formatJson(rows) + '\n';
      }
    } else {
      const tables = await opened.db.listTables();
      const dumpObj: Record<string, unknown> = {
        file: filePath,
        tables: {} as Record<string, unknown>,
      };
      const tablesMap = dumpObj.tables as Record<string, unknown>;
      for (const t of tables) {
        const rows = await opened.db.from(t.name).toArray();
        tablesMap[t.name] = {
          columns: t.columns.map((c) => ({
            name: c.name,
            type: formatDataType(c.type),
            flags: formatColumnFlags(c.flags),
          })),
          rows: toJsonSafe(rows),
        };
      }
      output = formatJson(dumpObj) + '\n';
    }

    if (outPath) {
      await writeFile(outPath, output, 'utf8');
      const byteLen = new TextEncoder().encode(output).byteLength;
      ctx.io.stdout(`Wrote dump to ${outPath} (${formatBytes(byteLen)})\n`);
    } else {
      ctx.io.stdout(output);
    }
    return 0;
  } finally {
    await opened.close();
  }
}

// ============================================================================
// 10. checkpoint
// ============================================================================

export async function cmdCheckpoint(argv: string[], ctx: CommandContext): Promise<number> {
  const { positionals, values } = parseCliArgs(argv, CHECKPOINT_FLAG_DEFS);
  if (positionals.length !== 1) {
    throw new CliUsageError('Usage: webdb checkpoint <file> [--format table|json]');
  }

  const filePath = positionals[0];
  const format = parseOutputFormat(values.format as string | undefined, ['table', 'json'], 'table');

  const { size: dbSize } = await assertDbFileExists(filePath);
  const storage = new NodeFsStorage(filePath, { readOnly: false, create: false });

  try {
    const framesBefore = await storage.getWalFrameCount();

    // Guard against overwriting non-WebDB or truncated files
    if (dbSize < PAGE_SIZE) {
      throw new Error(
        `Refusing to checkpoint invalid database file (${dbSize} bytes < ${PAGE_SIZE}-byte page size): ${filePath}`,
      );
    }
    const [page1] = await storage.readPages([1]);
    if (!page1) {
      throw new Error(`Could not read Page 1 from ${filePath}`);
    }
    const p1View = new DataView(page1.buffer, page1.byteOffset, PAGE_SIZE);
    // Validate magic bytes & header format before performing any disk mutation
    catalog_read_page1_header(p1View, false);

    let pagesWritten = 0;
    let committedTxCount = 0;
    let abortedTxCount = 0;

    if (framesBefore > 0) {
      const recovery = await recoverFromWal(storage);
      pagesWritten = recovery.replayedPageCount;
      committedTxCount = recovery.committedTxCount;
      abortedTxCount = recovery.abortedTxCount;
    }

    const framesAfter = await storage.getWalFrameCount();

    const payload = {
      file: filePath,
      walFramesBefore: framesBefore,
      walFramesAfter: framesAfter,
      pagesWritten,
      committedTxCount,
      abortedTxCount,
    };

    if (format === 'json') {
      ctx.io.stdout(formatJson(payload) + '\n');
    } else {
      ctx.io.stdout(
        formatKeyValue([
          ['File', filePath],
          ['WAL Frames Before', framesBefore],
          ['WAL Frames After', framesAfter],
          ['Committed Transactions', committedTxCount],
          ['Aborted Transactions', abortedTxCount],
          ['Pages Written', pagesWritten],
        ]) + '\n',
      );
    }
    return 0;
  } finally {
    await storage.close();
  }
}
