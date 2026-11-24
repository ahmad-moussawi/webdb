import {
  PAGE_SIZE,
  PAGE_HEADER_SIZE,
  MAX_NAME_LENGTH,
  MASTER_TABLE_OFFSET,
  INDEX_CATALOG_OFFSET,
  MAX_TABLES_PAGE1,
  MAX_INDEXES_PAGE1,
  TABLE_DESCRIPTOR_SIZE,
  INDEX_DESCRIPTOR_SIZE,
  CATALOG_PAGE_HEADER_SIZE,
  MAX_COLUMNS_PER_CATALOG_PAGE,
  OVERFLOW_HEADER_SIZE,
  OVERFLOW_PAYLOAD_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  PAGE_HEADER_OFFSET_CHECKSUM,
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
} from "../constants.js";
import { WAL_FILE_HEADER_SIZE, WAL_FRAME_HEADER_SIZE, WAL_FRAME_SIZE } from "../layouts/wal_format.js";
import {
  ColumnFlag,
  DataType,
  IndexFlag,
  TableFlag,
  type ColumnDefinition,
  type ColumnMeta,
  type DataTypeString,
  type DbRow,
  type IndexDescriptor,
  type TableDescriptor,
  type TableMeta,
} from "../types/index.js";
import { WebDB } from "../host/api/webdb.js";
import { MemoryStorage } from "../host/storage/memory.js";
import { computePageChecksum } from "../host/storage/crc32.js";
import {
  decodeWalFileHeader,
  validateWalFrame,
} from "../host/storage/wal_codec.js";
import {
  CATALOG_PAGE_FLAG_INDEX_OVERFLOW,
  CATALOG_PAGE_FLAG_TABLE_OVERFLOW,
  MAX_DESCRIPTORS_PER_OVERFLOW_PAGE,
  catalog_get_table_slot_capacity,
  catalog_init_page,
  catalog_load_table_meta,
  catalog_parse_data_type,
  catalog_read_fixed_string,
  catalog_read_index_descriptor,
  catalog_read_page1_header,
  catalog_read_page_header,
  catalog_read_table_descriptor,
  catalog_update_page1_checksum,
  catalog_write_column_meta,
  catalog_write_table_descriptor,
} from "../core/js/catalog.c.js";
import { UlidCodec, UuidCodec } from "../core/js/codecs.c.js";
import {
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
  page_get_type,
  page_deserialize_row,
  page_get_overflow_chunk_size,
  page_get_overflow_next_page_id,
  serialize_single_key,
  type OverflowDescriptorInfo,
} from "../core/js/page.c.js";
import { CliUsageError } from "./args.js";
import { formatDataType } from "./format.js";
import { createEngine, type CoreMode } from "./open.js";

const textDecoder = new TextDecoder();
const VALID_ASCII_NAME_RE = /^[A-Za-z0-9_.\-$ ]+$/;
const MAX_SLOTS_PER_PAGE = Math.floor((PAGE_SIZE - PAGE_HEADER_SIZE) / 2);

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export interface RecoveryColumnSchema {
  name: string;
  type: DataTypeString | DataType;
  primaryKey?: boolean;
  notNull?: boolean;
  indexed?: boolean;
  autoInc?: boolean;
  autoIncrement?: boolean;
  flags?: {
    primaryKey?: boolean;
    notNull?: boolean;
    indexed?: boolean;
    autoInc?: boolean;
    autoIncrement?: boolean;
  };
  _hint?: string;
}

export interface RecoveryIndexSchema {
  name?: string;
  columns: string | string[];
  unique?: boolean;
}

export interface RecoveryTableSchema {
  columns: RecoveryColumnSchema[];
  indexes?: RecoveryIndexSchema[];
}

export type RecoverySchemaMap = Record<string, RecoveryTableSchema>;

export interface StructuralCheckResult {
  errors: string[];
  warnings: string[];
  unlinkedZeroPages: number[];
  orphanLeafPages: number[];
  brokenCatalogPages: number[];
  brokenTables: Array<{ name: string; tableId: number; issue: string }>;
  duplicateIndexes: string[];
  danglingIndexTargets: Array<{
    indexName: string;
    tableName: string;
    targetPage: number;
    count: number;
  }>;
}

export interface TableRecoverySummary {
  tableId: number;
  name: string;
  status: "recovered" | "skipped_missing_schema";
  columnCount: number;
  rowCountEstimate: number;
  reachableRows: number;
  orphanRowsRecovered: number;
  totalRecoveredRows: number;
  lostIndexEntries: number;
  lostKeysSample?: string[];
  repairedColCatalog: boolean;
  brokenChainPages: number[];
}

export interface RecoveryReport {
  inputFile?: string;
  outputFile?: string;
  dryRun: boolean;
  inputPages: number;
  outputPages: number;
  repairedCatalogPages: Array<{
    pageId: number;
    kind: "table_overflow" | "index_overflow";
    startSlot: number;
    nextPageId: number;
  }>;
  deduplicatedIndexes: number;
  tablesRecovered: number;
  tablesSkipped: number;
  totalRowsRecovered: number;
  orphanLeafPagesRecovered: number;
  unmappedOrphanPages: number[];
  tables: TableRecoverySummary[];
  warnings: string[];
}

export interface RecoverOptions {
  schema?: RecoverySchemaMap;
  replayWal?: boolean;
  walBytes?: Uint8Array | null;
  core?: CoreMode;
  dryRun?: boolean;
}

function summarizePageList(pages: number[], maxItems = 12): string {
  if (pages.length <= maxItems) return pages.join(", ");
  return `${pages.slice(0, maxItems).join(", ")} ... (+${pages.length - maxItems} more)`;
}

function isValidTableEntry(name: string, colCount: number): boolean {
  return (
    name.length > 0 &&
    VALID_ASCII_NAME_RE.test(name) &&
    colCount > 0 &&
    colCount <= 256
  );
}

function normalizeSchemaColumn(
  col: unknown,
  idx: number,
  tableName: string,
): RecoveryColumnSchema {
  if (!col || typeof col !== "object") {
    throw new CliUsageError(
      `Invalid column #${idx} in schema for table "${tableName}"`,
    );
  }
  const c = col as Record<string, unknown>;
  if (typeof c.name !== "string" || !c.name.trim()) {
    throw new CliUsageError(
      `Missing column name at index ${idx} in schema for table "${tableName}"`,
    );
  }
  if (typeof c.type === "string") {
    catalog_parse_data_type(c.type);
  } else if (typeof c.type !== "number" || c.type < 1 || c.type > 7) {
    throw new CliUsageError(
      `Invalid column type for "${tableName}.${c.name}"`,
    );
  }

  let flagsObj: RecoveryColumnSchema["flags"] | undefined;
  if (typeof c.rawFlags === "number") {
    const f = c.rawFlags;
    flagsObj = {
      ...(f & ColumnFlag.PRIMARY_KEY ? { primaryKey: true } : {}),
      ...(f & ColumnFlag.NOT_NULL ? { notNull: true } : {}),
      ...(f & ColumnFlag.INDEXED ? { indexed: true } : {}),
      ...(f & ColumnFlag.AUTO_INC ? { autoInc: true } : {}),
    };
  } else if (typeof c.flags === "string") {
    const tokens = c.flags
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    flagsObj = {
      ...(tokens.includes("PK") || tokens.includes("PRIMARY_KEY") ? { primaryKey: true } : {}),
      ...(tokens.includes("NOT NULL") || tokens.includes("NOT_NULL") ? { notNull: true } : {}),
      ...(tokens.includes("INDEXED") ? { indexed: true } : {}),
      ...(tokens.includes("AUTO_INC") || tokens.includes("AUTO_INCREMENT")
        ? { autoInc: true }
        : {}),
    };
  } else if (c.flags && typeof c.flags === "object" && !Array.isArray(c.flags)) {
    const f = c.flags as Record<string, unknown>;
    flagsObj = {
      ...(f.primaryKey ? { primaryKey: true } : {}),
      ...(f.notNull ? { notNull: true } : {}),
      ...(f.indexed ? { indexed: true } : {}),
      ...(f.autoInc || f.autoIncrement ? { autoInc: true } : {}),
    };
  }

  return {
    name: c.name,
    type: c.type as DataTypeString | DataType,
    ...(typeof c.primaryKey === "boolean" ? { primaryKey: c.primaryKey } : {}),
    ...(typeof c.notNull === "boolean" ? { notNull: c.notNull } : {}),
    ...(typeof c.indexed === "boolean" ? { indexed: c.indexed } : {}),
    ...(typeof c.autoInc === "boolean" ? { autoInc: c.autoInc } : {}),
    ...(typeof c.autoIncrement === "boolean" ? { autoIncrement: c.autoIncrement } : {}),
    ...(flagsObj && Object.keys(flagsObj).length > 0 ? { flags: flagsObj } : {}),
  };
}

/**
 * Extracts a clean `RecoverySchemaMap` directly from loaded `TableMeta[]` instances
 * (for `--recovery` schema export and `--schema-from` cross-database schema borrowing).
 */
export function extractRecoverySchemaFromTables(
  tables: TableMeta[],
): RecoverySchemaMap {
  const result: RecoverySchemaMap = {};
  for (const t of tables) {
    const columns: RecoveryColumnSchema[] = t.columns.map((c) => {
      const flagsObj: RecoveryColumnSchema["flags"] = {};
      if ((c.flags & ColumnFlag.PRIMARY_KEY) !== 0) flagsObj.primaryKey = true;
      if ((c.flags & ColumnFlag.NOT_NULL) !== 0) flagsObj.notNull = true;
      if ((c.flags & ColumnFlag.INDEXED) !== 0) flagsObj.indexed = true;
      if ((c.flags & ColumnFlag.AUTO_INC) !== 0) flagsObj.autoInc = true;
      return {
        name: c.name,
        type: formatDataType(c.type) as DataTypeString,
        ...(Object.keys(flagsObj).length > 0 ? { flags: flagsObj } : {}),
      };
    });

    const indexes: RecoveryIndexSchema[] = [];
    const seen = new Set<string>();
    for (const ix of t.indexes ?? []) {
      if ((ix.flags & IndexFlag.PRIMARY) !== 0) continue;
      if (seen.has(ix.name)) continue;
      seen.add(ix.name);
      const colNames: string[] = [];
      for (let i = 0; i < ix.columnCount; i++) {
        const col = t.columns[ix.columnIndices[i]];
        if (col) colNames.push(col.name);
      }
      if (colNames.length === 0) continue;
      indexes.push({
        name: ix.name,
        columns: colNames,
        ...((ix.flags & IndexFlag.UNIQUE) !== 0 ? { unique: true } : {}),
      });
    }

    result[t.name] = { columns, indexes };
  }
  return result;
}

/**
 * Parses a recovery schema JSON file into a normalized `RecoverySchemaMap`.
 * Supports:
 * - `{ "table_name": { columns: [...], indexes?: [...] }, ... }`
 * - `{ tables: { "table_name": { columns, indexes } } }`
 * - `{ tables: [{ name, columns, indexes }, ...] }`
 * - Direct output of `webdb schema <file> --format json` (array of table objects or single table object)
 */
export function parseRecoverySchemaJson(rawJson: string): RecoverySchemaMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: any) {
    throw new CliUsageError(
      `Invalid --schema JSON: ${err?.message ?? String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CliUsageError(
      "Invalid --schema JSON: expected an object mapping table names to { columns, indexes }",
    );
  }

  const rawEntries: Array<[string, unknown]> = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof (item as any).name !== "string") {
        throw new CliUsageError(
          "Invalid --schema JSON: each item in array must have a string name",
        );
      }
      rawEntries.push([(item as any).name, item]);
    }
  } else {
    const root = parsed as Record<string, unknown>;
    if ("tables" in root && root.tables && typeof root.tables === "object") {
      if (Array.isArray(root.tables)) {
        for (const item of root.tables) {
          if (!item || typeof item !== "object" || typeof (item as any).name !== "string") {
            throw new CliUsageError(
              "Invalid --schema JSON: each item in tables[] must have a string name",
            );
          }
          rawEntries.push([(item as any).name, item]);
        }
      } else {
        for (const [k, v] of Object.entries(root.tables as Record<string, unknown>)) {
          rawEntries.push([k, v]);
        }
      }
    } else if (
      typeof root.name === "string" &&
      Array.isArray(root.columns) &&
      !("columns" in root && !Array.isArray(root.columns))
    ) {
      // Single-table output of `webdb schema <file> <table> --format json`
      rawEntries.push([root.name, root]);
    } else {
      for (const [k, v] of Object.entries(root)) {
        rawEntries.push([k, v]);
      }
    }
  }

  const result: RecoverySchemaMap = {};
  for (const [tableName, rawDef] of rawEntries) {
    if (!rawDef || typeof rawDef !== "object" || Array.isArray(rawDef)) {
      throw new CliUsageError(
        `Invalid schema entry for table "${tableName}": expected { columns, indexes? }`,
      );
    }
    const def = rawDef as Record<string, unknown>;
    if (!Array.isArray(def.columns) || def.columns.length === 0) {
      throw new CliUsageError(
        `Invalid schema entry for table "${tableName}": "columns" must be a non-empty array`,
      );
    }

    const columns = def.columns.map((col, idx) =>
      normalizeSchemaColumn(col, idx, tableName),
    );

    let indexes: RecoveryIndexSchema[] | undefined;
    if (def.indexes !== undefined) {
      if (!Array.isArray(def.indexes)) {
        throw new CliUsageError(
          `Invalid indexes in schema for table "${tableName}": expected an array`,
        );
      }
      indexes = [];
      for (let idxNum = 0; idxNum < def.indexes.length; idxNum++) {
        const idxSpec = def.indexes[idxNum];
        if (!idxSpec || typeof idxSpec !== "object") {
          throw new CliUsageError(
            `Invalid index #${idxNum} in schema for table "${tableName}"`,
          );
        }
        const s = idxSpec as Record<string, unknown>;
        const strFlags = typeof s.flags === "string" ? s.flags.toUpperCase() : "";
        if (strFlags.includes("PRIMARY")) {
          continue;
        }
        let cols: string[] | null = null;
        if (Array.isArray(s.columns)) {
          cols = s.columns.map(String);
        } else if (typeof s.columns === "string") {
          cols = s.columns
            .split(",")
            .map((part) => part.trim().replace(/\s+(ASC|DESC)$/i, "").trim())
            .filter(Boolean);
        }
        if (!cols || cols.length === 0) {
          throw new CliUsageError(
            `Index #${idxNum} on table "${tableName}" must specify column(s)`,
          );
        }
        indexes.push({
          name: typeof s.name === "string" ? s.name : undefined,
          columns: cols,
          unique: Boolean(s.unique) || strFlags.includes("UNIQUE"),
        });
      }
    }

    result[tableName] = { columns, indexes };
  }

  return result;
}

class BoundedBufferPager {
  readonly pages: Uint8Array[];

  constructor(buf: Uint8Array, pageCount?: number) {
    const count = pageCount ?? Math.floor(buf.byteLength / PAGE_SIZE);
    this.pages = new Array<Uint8Array>(count);
    for (let i = 0; i < count; i++) {
      this.pages[i] = buf.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
    }
  }

  get totalPages(): number {
    return this.pages.length;
  }

  hasPage(pageId: number): boolean {
    return pageId >= 1 && pageId <= this.pages.length;
  }

  getPageBytes = (pageId: number): Uint8Array => {
    if (pageId < 1 || pageId > this.pages.length) {
      return new Uint8Array(0);
    }
    return this.pages[pageId - 1];
  };

  getPageView(pageId: number): DataView | null {
    if (pageId < 1 || pageId > this.pages.length) return null;
    const p = this.pages[pageId - 1];
    return new DataView(p.buffer, p.byteOffset, PAGE_SIZE);
  }

  allocatePage(): number {
    const page = new Uint8Array(PAGE_SIZE);
    this.pages.push(page);
    return this.pages.length;
  }

  markPageDirty = (pageId: number): void => {
    if (pageId < 1 || pageId > this.pages.length) return;
    const p = this.pages[pageId - 1];
    if (pageId === 1) {
      catalog_update_page1_checksum(new DataView(p.buffer, p.byteOffset, PAGE_SIZE), 0);
    } else {
      new DataView(p.buffer, p.byteOffset, PAGE_SIZE).setUint32(
        PAGE_HEADER_OFFSET_CHECKSUM,
        computePageChecksum(p),
        true,
      );
    }
  };
}

/**
 * Safely collects descriptor overflow page chain IDs without throwing on corrupt hops.
 */
function collectCatalogOverflowChain(
  pager: BoundedBufferPager,
  firstPageId: number,
  kind: "table" | "index",
  errors: string[],
  brokenCatalogPages: number[],
): number[] {
  const validPages: number[] = [];
  const visited = new Set<number>();
  let cur = firstPageId;
  while (cur !== 0) {
    if (!pager.hasPage(cur)) {
      errors.push(
        `Overflow ${kind} catalog chain points out of bounds to page ${cur}`,
      );
      break;
    }
    if (visited.has(cur)) {
      errors.push(
        `Cycle detected in overflow ${kind} catalog chain at page ${cur}`,
      );
      break;
    }
    visited.add(cur);
    const view = pager.getPageView(cur)!;
    const ptype = page_get_type(view, 0);
    if (ptype !== PAGE_TYPE_CATALOG_PAGE) {
      brokenCatalogPages.push(cur);
      errors.push(
        `Overflow ${kind} catalog page ${cur} has invalid page type 0x${ptype
          .toString(16)
          .padStart(2, "0")} (expected 0x0c)`,
      );
      break;
    }
    validPages.push(cur);
    cur = view.getUint32(8, true);
  }
  return validPages;
}

/**
 * Safely collects all 0x0D leaf pages reachable from a table's root (0x0D leaf chain or 0x05 interior B-tree).
 */
function collectTableLeafPages(
  pager: BoundedBufferPager,
  rootPageId: number,
  tableName: string,
): { leafPages: number[]; brokenAt: number[]; rootIssue?: string } {
  const leafPages: number[] = [];
  const brokenAt: number[] = [];
  const visited = new Set<number>();

  if (!pager.hasPage(rootPageId) || rootPageId <= 1) {
    return {
      leafPages,
      brokenAt: rootPageId > 0 ? [rootPageId] : [],
      rootIssue: `invalid rootPageId=${rootPageId}`,
    };
  }

  const rootView = pager.getPageView(rootPageId)!;
  const rootType = page_get_type(rootView, 0);
  if (rootType !== PAGE_TYPE_LEAF_DATA && rootType !== PAGE_TYPE_TABLE_INTERIOR) {
    return {
      leafPages,
      brokenAt: [rootPageId],
      rootIssue: `root page ${rootPageId} has type 0x${rootType
        .toString(16)
        .padStart(2, "0")} (expected 0x0d or 0x05)`,
    };
  }

  // Gather leaf starting points: either direct root (0x0D) or leftmost leaves from interior tree
  const queue: number[] = [];
  if (rootType === PAGE_TYPE_LEAF_DATA) {
    queue.push(rootPageId);
  } else {
    const interiorVisited = new Set<number>();
    const interiorStack = [rootPageId];
    while (interiorStack.length > 0) {
      const pid = interiorStack.pop()!;
      if (!pager.hasPage(pid) || interiorVisited.has(pid)) continue;
      interiorVisited.add(pid);
      const pv = pager.getPageView(pid)!;
      const pt = page_get_type(pv, 0);
      if (pt === PAGE_TYPE_LEAF_DATA) {
        queue.push(pid);
      } else if (pt === PAGE_TYPE_TABLE_INTERIOR) {
        const cnt = page_get_cell_count(pv, 0);
        const right = page_get_next_page_id(pv, 0);
        if (right > 1) interiorStack.push(right);
        for (let i = Math.min(cnt, MAX_SLOTS_PER_PAGE) - 1; i >= 0; i--) {
          const off = page_get_cell_offset(pv, 0, i);
          if (off >= PAGE_HEADER_SIZE && off + 4 <= PAGE_SIZE) {
            const child = pv.getUint32(off, true);
            if (child > 1) interiorStack.push(child);
          }
        }
      } else {
        brokenAt.push(pid);
      }
    }
  }

  for (const start of queue) {
    let cur = start;
    while (cur !== 0) {
      if (!pager.hasPage(cur) || cur <= 1) {
        brokenAt.push(cur);
        break;
      }
      if (visited.has(cur)) break;
      const pv = pager.getPageView(cur)!;
      const pt = page_get_type(pv, 0);
      if (pt !== PAGE_TYPE_LEAF_DATA) {
        brokenAt.push(cur);
        break;
      }
      visited.add(cur);
      leafPages.push(cur);
      cur = page_get_next_page_id(pv, 0);
    }
  }

  void tableName;
  return { leafPages, brokenAt };
}

/**
 * Safely scans index leaf/interior nodes for cell entries (`keyBytes`, `targetPage`, `targetSlot`).
 */
function scanIndexCells(
  pager: BoundedBufferPager,
  rootPageId: number,
): {
  entries: Array<{ keyBytes: Uint8Array; targetPage: number; targetSlot: number }>;
  brokenPages: number[];
} {
  const entries: Array<{ keyBytes: Uint8Array; targetPage: number; targetSlot: number }> = [];
  const brokenPages: number[] = [];
  if (!pager.hasPage(rootPageId) || rootPageId <= 1) {
    if (rootPageId > 0) brokenPages.push(rootPageId);
    return { entries, brokenPages };
  }

  const visited = new Set<number>();
  const stack = [rootPageId];
  while (stack.length > 0) {
    const pid = stack.shift()!;
    if (!pager.hasPage(pid) || pid <= 1 || visited.has(pid)) continue;
    const pBytes = pager.getPageBytes(pid);
    const dv = new DataView(pBytes.buffer, pBytes.byteOffset, PAGE_SIZE);
    const ptype = page_get_type(dv, 0);
    if (ptype === PAGE_TYPE_INDEX_LEAF) {
      visited.add(pid);
      const cnt = page_get_cell_count(dv, 0);
      if (cnt > MAX_SLOTS_PER_PAGE) {
        brokenPages.push(pid);
        continue;
      }
      for (let i = 0; i < cnt; i++) {
        const off = page_get_cell_offset(dv, 0, i);
        if (off < PAGE_HEADER_SIZE || off + 10 > PAGE_SIZE) continue;
        const kLen = dv.getUint16(off, true);
        if (off + 2 + kLen + 8 > PAGE_SIZE) continue;
        const keyBytes = pBytes.slice(off + 2, off + 2 + kLen);
        const lo = dv.getUint32(off + 2 + kLen, true);
        entries.push({
          keyBytes,
          targetPage: lo >>> 16,
          targetSlot: lo & 0xffff,
        });
      }
      const next = page_get_next_page_id(dv, 0);
      if (next > 1 && !visited.has(next)) {
        if (!pager.hasPage(next)) {
          brokenPages.push(next);
        } else {
          stack.push(next);
        }
      }
    } else if (ptype === PAGE_TYPE_INDEX_INTERIOR) {
      visited.add(pid);
      const cnt = page_get_cell_count(dv, 0);
      if (cnt > MAX_SLOTS_PER_PAGE) {
        brokenPages.push(pid);
        continue;
      }
      for (let i = 0; i < cnt; i++) {
        const off = page_get_cell_offset(dv, 0, i);
        if (off >= PAGE_HEADER_SIZE && off + 4 <= PAGE_SIZE) {
          const child = dv.getUint32(off, true);
          if (child > 1 && !visited.has(child)) stack.push(child);
        }
      }
      const right = page_get_next_page_id(dv, 0);
      if (right > 1 && !visited.has(right)) stack.push(right);
    } else {
      brokenPages.push(pid);
    }
  }

  return { entries, brokenPages };
}

/**
 * Inspects structural integrity of an open/verified WebDB image (non-mutating).
 * Catches valid-CRC32 corruption such as unlinked 0x00 pages, broken catalog chains,
 * broken table chains, orphaned 0x0D leaf pages, and dangling index targets.
 */
export function inspectDatabaseStructure(
  dbBytes: Uint8Array,
  pagesToCheck: number,
): StructuralCheckResult {
  const result: StructuralCheckResult = {
    errors: [],
    warnings: [],
    unlinkedZeroPages: [],
    orphanLeafPages: [],
    brokenCatalogPages: [],
    brokenTables: [],
    duplicateIndexes: [],
    danglingIndexTargets: [],
  };

  if (pagesToCheck < 1 || dbBytes.byteLength < PAGE_SIZE) {
    return result;
  }

  const pager = new BoundedBufferPager(dbBytes, pagesToCheck);
  const p1View = pager.getPageView(1)!;
  let hdr;
  try {
    hdr = catalog_read_page1_header(p1View, false);
  } catch {
    return result;
  }

  // 1. Walk free list starting from FREE_PAGE_HEAD
  const freelistPages = new Set<number>();
  let curFree = hdr.freePageHead;
  while (curFree !== 0) {
    if (!pager.hasPage(curFree) || curFree <= 1) {
      result.errors.push(
        `Free-page list points out of bounds to page ${curFree}`,
      );
      break;
    }
    if (freelistPages.has(curFree)) {
      result.errors.push(
        `Cycle detected in free-page list at page ${curFree}`,
      );
      break;
    }
    const fv = pager.getPageView(curFree)!;
    const ftype = page_get_type(fv, 0);
    if (ftype !== PAGE_TYPE_FREE) {
      result.errors.push(
        `Free-list page ${curFree} has non-FREE page type 0x${ftype
          .toString(16)
          .padStart(2, "0")}`,
      );
      break;
    }
    freelistPages.add(curFree);
    curFree = page_get_next_page_id(fv, 0);
  }

  // 2. Scan for unlinked 0x00 pages and collect all 0x0D leaf pages
  const allLeafPages: number[] = [];
  for (let pid = 2; pid <= pagesToCheck; pid++) {
    const pv = pager.getPageView(pid)!;
    const pt = page_get_type(pv, 0);
    if (pt === PAGE_TYPE_FREE && !freelistPages.has(pid)) {
      result.unlinkedZeroPages.push(pid);
    } else if (pt === PAGE_TYPE_LEAF_DATA) {
      allLeafPages.push(pid);
    }
  }
  if (result.unlinkedZeroPages.length > 0) {
    result.errors.push(
      `Found ${result.unlinkedZeroPages.length} unlinked zeroed page(s) not on free list: [${summarizePageList(
        result.unlinkedZeroPages,
      )}]`,
    );
  }

  // 3. Validate overflow table & index catalog chains
  const nextCatId = p1View.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true);
  const tableOverflowPages = collectCatalogOverflowChain(
    pager,
    nextCatId,
    "table",
    result.errors,
    result.brokenCatalogPages,
  );
  const nextIdxCatId = p1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true);
  const indexOverflowPages = collectCatalogOverflowChain(
    pager,
    nextIdxCatId,
    "index",
    result.errors,
    result.brokenCatalogPages,
  );

  // Build safe bounded pager that stops overflow descriptor lookup on broken catalog pages
  const validTableOvSet = new Set(tableOverflowPages);
  const validIndexOvSet = new Set(indexOverflowPages);

  // 4. Inspect active tables from Page 1 + valid overflow table catalog pages
  const activeTables: TableDescriptor[] = [];
  const tableSlotsCount =
    MAX_TABLES_PAGE1 + tableOverflowPages.length * MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
  const safeTablePager = {
    getPageBytes: (pid: number): Uint8Array => {
      if (pid === 1 || validTableOvSet.has(pid)) {
        return pager.getPageBytes(pid);
      }
      return new Uint8Array(0);
    },
  };
  for (let s = 0; s < tableSlotsCount; s++) {
    const desc = catalog_read_table_descriptor(p1View, s, safeTablePager);
    if (desc && (desc.flags & TableFlag.ACTIVE) !== 0) {
      activeTables.push(desc);
    }
  }

  const visitedLeafPages = new Set<number>();
  const tablesById = new Map<number, TableDescriptor>();

  for (const t of activeTables) {
    tablesById.set(t.tableId, t);

    // 4a. Verify column catalog chain
    let colCur = t.colCatalogPageId;
    let colsLoaded = 0;
    const seenColPages = new Set<number>();
    let colBroken = false;
    if (!pager.hasPage(colCur) || colCur <= 1) {
      colBroken = true;
      const issue = `invalid colCatalogPageId=${colCur}`;
      result.brokenTables.push({ name: t.name, tableId: t.tableId, issue });
      result.errors.push(`Table "${t.name}": ${issue}`);
    } else {
      while (colCur !== 0 && colsLoaded < t.columnCount) {
        if (!pager.hasPage(colCur) || seenColPages.has(colCur)) {
          colBroken = true;
          result.brokenTables.push({
            name: t.name,
            tableId: t.tableId,
            issue: `broken or cyclic column catalog page ${colCur}`,
          });
          result.errors.push(
            `Table "${t.name}": broken or cyclic column catalog at page ${colCur}`,
          );
          break;
        }
        seenColPages.add(colCur);
        const cv = pager.getPageView(colCur)!;
        const ct = page_get_type(cv, 0);
        if (ct !== PAGE_TYPE_CATALOG_PAGE) {
          colBroken = true;
          result.brokenCatalogPages.push(colCur);
          const issue = `column catalog page ${colCur} has invalid page type 0x${ct
            .toString(16)
            .padStart(2, "0")}`;
          result.brokenTables.push({ name: t.name, tableId: t.tableId, issue });
          result.errors.push(`Table "${t.name}": ${issue}`);
          break;
        }
        const ch = catalog_read_page_header(cv, 0);
        if (ch.colCountInPage > MAX_COLUMNS_PER_CATALOG_PAGE) {
          colBroken = true;
          const issue = `column catalog page ${colCur} declares invalid colCountInPage=${ch.colCountInPage}`;
          result.brokenTables.push({ name: t.name, tableId: t.tableId, issue });
          result.errors.push(`Table "${t.name}": ${issue}`);
          break;
        }
        colsLoaded += ch.colCountInPage;
        colCur = ch.nextColCatalogPageId;
      }
      if (!colBroken && colsLoaded < t.columnCount) {
        const issue = `column catalog loaded ${colsLoaded} of ${t.columnCount} columns`;
        result.brokenTables.push({ name: t.name, tableId: t.tableId, issue });
        result.errors.push(`Table "${t.name}": ${issue}`);
      }
    }

    // 4b. Verify PK root page if embedded PK exists
    if (t.pkRootPageId && t.pkRootPageId > 0) {
      if (!pager.hasPage(t.pkRootPageId) || t.pkRootPageId <= 1) {
        result.errors.push(
          `Table "${t.name}": primary key index has invalid rootPageId=${t.pkRootPageId}`,
        );
      } else {
        const pkType = page_get_type(pager.getPageView(t.pkRootPageId)!, 0);
        if (pkType !== PAGE_TYPE_INDEX_LEAF && pkType !== PAGE_TYPE_INDEX_INTERIOR) {
          result.errors.push(
            `Table "${t.name}": pk_${t.name} root page ${t.pkRootPageId} has invalid type 0x${pkType
              .toString(16)
              .padStart(2, "0")}`,
          );
        }
      }
    }

    // 4c. Walk leaf chain(s)
    const leafWalk = collectTableLeafPages(pager, t.rootPageId, t.name);
    for (const pid of leafWalk.leafPages) {
      visitedLeafPages.add(pid);
    }
    if (leafWalk.rootIssue) {
      result.brokenTables.push({
        name: t.name,
        tableId: t.tableId,
        issue: leafWalk.rootIssue,
      });
      result.errors.push(`Table "${t.name}": ${leafWalk.rootIssue}`);
    } else if (leafWalk.brokenAt.length > 0) {
      const issue = `broken leaf chain reaching non-data page(s): [${summarizePageList(
        leafWalk.brokenAt,
      )}]`;
      result.brokenTables.push({ name: t.name, tableId: t.tableId, issue });
      result.errors.push(`Table "${t.name}": ${issue}`);
    }

    // 4d. When column catalog is intact, validate row cells and 0x0E overflow chains
    if (!colBroken && colsLoaded >= t.columnCount && leafWalk.leafPages.length > 0) {
      const safeColPager = {
        getPageBytes: (pid: number): Uint8Array => {
          if (pid === 1 || seenColPages.has(pid) || validTableOvSet.has(pid)) {
            return pager.getPageBytes(pid);
          }
          return new Uint8Array(0);
        },
      };
      const tMeta = catalog_load_table_meta(p1View, safeColPager, t.name);
      let reportedCellErrors = 0;
      for (const leafPid of leafWalk.leafPages) {
        if (reportedCellErrors >= 5) break;
        const leafView = pager.getPageView(leafPid);
        if (!leafView) continue;
        const cellCount = page_get_cell_count(leafView, 0);
        if (cellCount > MAX_SLOTS_PER_PAGE) {
          result.errors.push(
            `Table "${t.name}" leaf page ${leafPid}: cellCount ${cellCount} exceeds maximum ${MAX_SLOTS_PER_PAGE}`,
          );
          reportedCellErrors++;
          continue;
        }
        for (let c = 0; c < cellCount; c++) {
          if (reportedCellErrors >= 5) break;
          const cellOff = page_get_cell_offset(leafView, 0, c);
          if (cellOff < PAGE_HEADER_SIZE || cellOff >= PAGE_SIZE) {
            result.errors.push(
              `Table "${t.name}" leaf page ${leafPid} slot ${c}: out-of-bounds cell offset ${cellOff}`,
            );
            reportedCellErrors++;
            continue;
          }
          const ovDescs: OverflowDescriptorInfo[] = [];
          const decoded = page_deserialize_row(
            tMeta.columns,
            leafView,
            cellOff,
            undefined,
            ovDescs,
          );
          if (!decoded) {
            result.errors.push(
              `Table "${t.name}" leaf page ${leafPid} slot ${c}: malformed row record`,
            );
            reportedCellErrors++;
            continue;
          }
          for (const d of ovDescs) {
            if (d.totalLen === 0) continue;
            let ovCur = d.firstPageId;
            let copied = 0;
            const seenOv = new Set<number>();
            while (ovCur > 1 && copied < d.totalLen && !seenOv.has(ovCur)) {
              if (!pager.hasPage(ovCur)) break;
              seenOv.add(ovCur);
              const ovView = pager.getPageView(ovCur)!;
              if (page_get_type(ovView, 0) !== PAGE_TYPE_OVERFLOW) break;
              const chunkLen = Math.min(
                page_get_overflow_chunk_size(ovView, 0),
                OVERFLOW_PAYLOAD_SIZE,
                d.totalLen - copied,
              );
              if (chunkLen <= 0) break;
              copied += chunkLen;
              ovCur = page_get_overflow_next_page_id(ovView, 0);
            }
            if (copied < d.totalLen) {
              result.errors.push(
                `Table "${t.name}" leaf page ${leafPid} slot ${c}: broken overflow chain starting at page ${d.firstPageId} (read ${copied}/${d.totalLen} bytes)`,
              );
              reportedCellErrors++;
              break;
            }
          }
        }
      }
    }
  }

  // 5. Flag orphaned 0x0D leaf pages
  for (const pid of allLeafPages) {
    if (!visitedLeafPages.has(pid)) {
      result.orphanLeafPages.push(pid);
    }
  }
  if (result.orphanLeafPages.length > 0) {
    result.errors.push(
      `Found ${result.orphanLeafPages.length} orphaned 0x0D data leaf page(s) unreachable from any table root: [${summarizePageList(
        result.orphanLeafPages,
      )}]`,
    );
  }

  // 6. Inspect secondary index descriptors & verify index targets point to active 0x0D pages
  const safeIdxPager = {
    getPageBytes: (pid: number): Uint8Array => {
      if (pid === 1 || validIndexOvSet.has(pid)) {
        return pager.getPageBytes(pid);
      }
      return new Uint8Array(0);
    },
  };
  const idxSlotsCount =
    MAX_INDEXES_PAGE1 + indexOverflowPages.length * MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
  const seenIdxNames = new Set<string>();
  const indexesToCheck: Array<{ name: string; tableName: string; rootPageId: number }> = [];

  for (const t of activeTables) {
    if (t.pkRootPageId && t.pkRootPageId > 0) {
      indexesToCheck.push({
        name: `pk_${t.name}`,
        tableName: t.name,
        rootPageId: t.pkRootPageId,
      });
    }
  }

  for (let s = 0; s < idxSlotsCount; s++) {
    const idx = catalog_read_index_descriptor(p1View, s, safeIdxPager);
    if (!idx) continue;
    const ownerTable = tablesById.get(idx.tableId);
    const tblName = ownerTable?.name ?? `table#${idx.tableId}`;
    const key = `${tblName}:${idx.name}`;
    if (seenIdxNames.has(key)) {
      result.duplicateIndexes.push(key);
      continue;
    }
    seenIdxNames.add(key);

    if (!pager.hasPage(idx.rootPageId) || idx.rootPageId <= 1) {
      result.errors.push(
        `Index "${idx.name}" on "${tblName}": invalid rootPageId=${idx.rootPageId}`,
      );
      continue;
    }
    const rt = page_get_type(pager.getPageView(idx.rootPageId)!, 0);
    if (rt !== PAGE_TYPE_INDEX_LEAF && rt !== PAGE_TYPE_INDEX_INTERIOR) {
      result.errors.push(
        `Index "${idx.name}" on "${tblName}": root page ${idx.rootPageId} has invalid type 0x${rt
          .toString(16)
          .padStart(2, "0")}`,
      );
      continue;
    }
    indexesToCheck.push({ name: idx.name, tableName: tblName, rootPageId: idx.rootPageId });
  }

  if (result.duplicateIndexes.length > 0) {
    result.warnings.push(
      `Found ${result.duplicateIndexes.length} duplicate index descriptor(s) in catalog: ${summarizePageList(
        result.duplicateIndexes as any,
      )}`,
    );
  }

  // Check index cell target pages
  for (const idxInfo of indexesToCheck) {
    const scan = scanIndexCells(pager, idxInfo.rootPageId);
    if (scan.brokenPages.length > 0) {
      result.errors.push(
        `Index "${idxInfo.name}" on "${idxInfo.tableName}" contains broken page(s): [${summarizePageList(
          scan.brokenPages,
        )}]`,
      );
    }
    const badTargetCounts = new Map<number, number>();
    for (const e of scan.entries) {
      const targetView = pager.getPageView(e.targetPage);
      const targetType = targetView ? page_get_type(targetView, 0) : -1;
      if (targetType !== PAGE_TYPE_LEAF_DATA) {
        badTargetCounts.set(e.targetPage, (badTargetCounts.get(e.targetPage) ?? 0) + 1);
      }
    }
    for (const [targetPage, count] of badTargetCounts.entries()) {
      result.danglingIndexTargets.push({
        indexName: idxInfo.name,
        tableName: idxInfo.tableName,
        targetPage,
        count,
      });
      result.errors.push(
        `Index "${idxInfo.name}" (${idxInfo.tableName}) has ${count} entry(s) pointing to non-data page ${targetPage}`,
      );
    }
  }

  return result;
}

function isLikelyTableDescriptorSlot(
  view: DataView,
  offset: number,
  totalPages: number,
): { tableId: number; name: string } | null {
  const tableId = view.getUint16(offset + 0, true);
  if (tableId === 0 || tableId > 4096) return null;
  const colCount = view.getUint16(offset + 2, true);
  const rootPageId = view.getUint32(offset + 4, true);
  const colCatPageId = view.getUint32(offset + 8, true);
  const flags = view.getUint32(offset + 76, true);
  if (
    colCount === 0 ||
    colCount > 256 ||
    rootPageId < 2 ||
    rootPageId > totalPages ||
    colCatPageId < 2 ||
    colCatPageId > totalPages ||
    (flags & TableFlag.ACTIVE) === 0
  ) {
    return null;
  }
  const name = catalog_read_fixed_string(view, offset + 12, MAX_NAME_LENGTH);
  if (!isValidTableEntry(name, colCount)) return null;
  return { tableId, name };
}

function isLikelyIndexDescriptorSlot(
  view: DataView,
  offset: number,
  totalPages: number,
): { indexId: number; tableId: number; name: string } | null {
  const indexId = view.getUint16(offset + 0, true);
  const tableId = view.getUint16(offset + 2, true);
  const rootPageId = view.getUint32(offset + 4, true);
  const colCount = view.getUint8(offset + 8);
  const flags = view.getUint8(offset + 9);
  if (
    indexId === 0 ||
    indexId > 4096 ||
    tableId === 0 ||
    tableId > 4096 ||
    rootPageId < 2 ||
    rootPageId > totalPages ||
    colCount === 0 ||
    colCount > 8 ||
    flags > 7
  ) {
    return null;
  }
  const name = catalog_read_fixed_string(view, offset + 34, MAX_NAME_LENGTH);
  if (!name || !VALID_ASCII_NAME_RE.test(name)) return null;
  return { indexId, tableId, name };
}

function repairOverflowCatalogPages(
  pager: BoundedBufferPager,
  report: RecoveryReport,
): void {
  const p1View = pager.getPageView(1)!;
  const totalPages = pager.totalPages;

  const firstTableOv = p1View.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true);
  const firstIndexOv = p1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true);

  interface OverflowCandidate {
    pageId: number;
    kind: "table_overflow" | "index_overflow";
    wasZeroedHeader: boolean;
    existingStartSlot: number;
    existingNext: number;
    inferredStartSlot: number;
  }

  const tablePages: OverflowCandidate[] = [];
  const indexPages: OverflowCandidate[] = [];

  for (let pid = 2; pid <= totalPages; pid++) {
    const view = pager.getPageView(pid)!;
    const ptype = page_get_type(view, 0);

    if (ptype === PAGE_TYPE_CATALOG_PAGE) {
      const ch = catalog_read_page_header(view, 0);
      if (ch.flags === CATALOG_PAGE_FLAG_TABLE_OVERFLOW && ch.tableId === 0) {
        tablePages.push({
          pageId: pid,
          kind: "table_overflow",
          wasZeroedHeader: false,
          existingStartSlot: ch.startColIndex,
          existingNext: ch.nextColCatalogPageId,
          inferredStartSlot: ch.startColIndex,
        });
      } else if (ch.flags === CATALOG_PAGE_FLAG_INDEX_OVERFLOW && ch.tableId === 0) {
        indexPages.push({
          pageId: pid,
          kind: "index_overflow",
          wasZeroedHeader: false,
          existingStartSlot: ch.startColIndex,
          existingNext: ch.nextColCatalogPageId,
          inferredStartSlot: ch.startColIndex,
        });
      }
      continue;
    }

    if (ptype !== PAGE_TYPE_FREE) continue;

    let validTableCount = 0;
    let firstTableSlot = -1;
    let firstTableId = 0;
    let validIndexCount = 0;
    let firstIndexSlot = -1;
    let firstIndexId = 0;

    for (let s = 0; s < MAX_DESCRIPTORS_PER_OVERFLOW_PAGE; s++) {
      const off = CATALOG_PAGE_HEADER_SIZE + s * TABLE_DESCRIPTOR_SIZE;
      const tHit = isLikelyTableDescriptorSlot(view, off, totalPages);
      if (tHit) {
        validTableCount++;
        if (firstTableSlot === -1) {
          firstTableSlot = s;
          firstTableId = tHit.tableId;
        }
      }
      const iHit = isLikelyIndexDescriptorSlot(view, off, totalPages);
      if (iHit) {
        validIndexCount++;
        if (firstIndexSlot === -1) {
          firstIndexSlot = s;
          firstIndexId = iHit.indexId;
        }
      }
    }

    if (validTableCount > 0 && validTableCount >= validIndexCount) {
      const approx = Math.max(MAX_TABLES_PAGE1, firstTableId - 1 - firstTableSlot);
      const k = Math.max(
        0,
        Math.round((approx - MAX_TABLES_PAGE1) / MAX_DESCRIPTORS_PER_OVERFLOW_PAGE),
      );
      tablePages.push({
        pageId: pid,
        kind: "table_overflow",
        wasZeroedHeader: true,
        existingStartSlot: 0,
        existingNext: 0,
        inferredStartSlot:
          pid === firstTableOv
            ? MAX_TABLES_PAGE1
            : MAX_TABLES_PAGE1 + k * MAX_DESCRIPTORS_PER_OVERFLOW_PAGE,
      });
    } else if (validIndexCount > 0) {
      const approx = Math.max(MAX_INDEXES_PAGE1, firstIndexId - 1 - firstIndexSlot);
      const k = Math.max(
        0,
        Math.round((approx - MAX_INDEXES_PAGE1) / MAX_DESCRIPTORS_PER_OVERFLOW_PAGE),
      );
      indexPages.push({
        pageId: pid,
        kind: "index_overflow",
        wasZeroedHeader: true,
        existingStartSlot: 0,
        existingNext: 0,
        inferredStartSlot:
          pid === firstIndexOv
            ? MAX_INDEXES_PAGE1
            : MAX_INDEXES_PAGE1 + k * MAX_DESCRIPTORS_PER_OVERFLOW_PAGE,
      });
    }
  }

  const refineChainStarts = (
    items: OverflowCandidate[],
    firstFromPage1: number,
    baseStart: number,
  ): void => {
    const byId = new Map(items.map((x) => [x.pageId, x]));
    if (firstFromPage1 && byId.has(firstFromPage1)) {
      byId.get(firstFromPage1)!.inferredStartSlot = baseStart;
    }
    for (const item of items) {
      if (!item.wasZeroedHeader && item.existingNext && byId.has(item.existingNext)) {
        const target = byId.get(item.existingNext)!;
        if (target.wasZeroedHeader) {
          target.inferredStartSlot =
            item.existingStartSlot + MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
        }
      }
    }
    items.sort((a, b) => a.inferredStartSlot - b.inferredStartSlot || a.pageId - b.pageId);
  };

  refineChainStarts(tablePages, firstTableOv, MAX_TABLES_PAGE1);
  refineChainStarts(indexPages, firstIndexOv, MAX_INDEXES_PAGE1);

  const relinkAndPatch = (
    items: OverflowCandidate[],
    flag: number,
    baseStart: number,
    headerOffset: number,
  ): void => {
    if (items.length === 0) return;
    const prevPtr = p1View.getUint32(headerOffset, true);
    if (prevPtr !== items[0].pageId) {
      p1View.setUint32(headerOffset, items[0].pageId, true);
      pager.markPageDirty(1);
    }

    for (let i = 0; i < items.length; i++) {
      const cur = items[i];
      const nextId = i + 1 < items.length ? items[i + 1].pageId : 0;
      const startSlot = baseStart + i * MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
      if (
        cur.wasZeroedHeader ||
        cur.existingStartSlot !== startSlot ||
        cur.existingNext !== nextId
      ) {
        const dv = pager.getPageView(cur.pageId)!;
        dv.setUint8(0, PAGE_TYPE_CATALOG_PAGE);
        dv.setUint8(1, flag);
        dv.setUint16(2, 0, true);
        dv.setUint16(4, 0, true);
        dv.setUint16(6, startSlot, true);
        dv.setUint32(8, nextId, true);
        pager.markPageDirty(cur.pageId);
        if (cur.wasZeroedHeader) {
          report.repairedCatalogPages.push({
            pageId: cur.pageId,
            kind: cur.kind,
            startSlot,
            nextPageId: nextId,
          });
        }
      }
    }
  };

  relinkAndPatch(
    tablePages,
    CATALOG_PAGE_FLAG_TABLE_OVERFLOW,
    MAX_TABLES_PAGE1,
    HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  );
  relinkAndPatch(
    indexPages,
    CATALOG_PAGE_FLAG_INDEX_OVERFLOW,
    MAX_INDEXES_PAGE1,
    HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  );
}

function replayWalOntoPager(
  pager: BoundedBufferPager,
  walBytes: Uint8Array,
  warnings: string[],
): void {
  if (walBytes.byteLength < WAL_FILE_HEADER_SIZE) return;
  try {
    const hdr = decodeWalFileHeader(walBytes, true);
    if (hdr.pageSize !== PAGE_SIZE) {
      warnings.push(
        `Skipped WAL replay: page size mismatch (expected ${PAGE_SIZE}, got ${hdr.pageSize})`,
      );
      return;
    }
  } catch (err: any) {
    warnings.push(
      `Skipped WAL replay: corrupt WAL header (${err?.message ?? String(err)})`,
    );
    return;
  }

  const totalFrames = Math.floor(
    (walBytes.byteLength - WAL_FILE_HEADER_SIZE) / WAL_FRAME_SIZE,
  );
  if (totalFrames === 0) return;

  const txFrames = new Map<
    number,
    Array<{ pageId: number; pageData: Uint8Array; dbSizePages: number }>
  >();
  const committedTxs: number[] = [];
  let validFrames = 0;

  for (let i = 0; i < totalFrames; i++) {
    const start = WAL_FILE_HEADER_SIZE + i * WAL_FRAME_SIZE;
    const frame = walBytes.subarray(start, start + WAL_FRAME_SIZE);
    const val = validateWalFrame(frame);
    if (!val.valid || !val.header) break;
    if (val.header.frameSeq !== validFrames + 1) break;
    validFrames++;

    const { txId, frameType, pageId, dbSizePages } = val.header;
    if (!txFrames.has(txId)) txFrames.set(txId, []);
    if (frameType === WAL_FRAME_TYPE_TX_COMMIT) {
      if (!committedTxs.includes(txId)) committedTxs.push(txId);
    } else if (frameType === WAL_FRAME_TYPE_PAGE_DATA && pageId >= 1) {
      txFrames.get(txId)!.push({
        pageId,
        dbSizePages,
        pageData: frame.slice(WAL_FRAME_HEADER_SIZE, WAL_FRAME_SIZE),
      });
    }
  }

  for (const txId of committedTxs) {
    const list = txFrames.get(txId) ?? [];
    for (const f of list) {
      const targetSize = Math.max(f.pageId, f.dbSizePages);
      while (pager.totalPages < targetSize) {
        pager.allocatePage();
      }
      pager.pages[f.pageId - 1].set(f.pageData);
    }
  }
}

function writeColCatalogFromSchema(
  pager: BoundedBufferPager,
  tableDesc: TableDescriptor,
  tableSlotIdx: number,
  schemaDef: RecoveryTableSchema,
): void {
  const cols: ColumnMeta[] = [];
  let fixedOffset = 0;
  for (const def of schemaDef.columns) {
    const dt =
      typeof def.type === "string"
        ? catalog_parse_data_type(def.type)
        : (def.type as DataType);
    let fl = 0;
    if (def.primaryKey || def.flags?.primaryKey) fl |= ColumnFlag.PRIMARY_KEY;
    if (def.notNull || def.flags?.notNull) fl |= ColumnFlag.NOT_NULL;
    if (def.indexed || def.flags?.indexed) fl |= ColumnFlag.INDEXED;
    if (def.autoInc || def.autoIncrement || def.flags?.autoInc || def.flags?.autoIncrement) {
      fl |= ColumnFlag.AUTO_INC;
    }
    const colOffset = fixedOffset;
    if (dt === DataType.INT32) fixedOffset += 4;
    else if (dt === DataType.INT64 || dt === DataType.FLOAT64) fixedOffset += 8;
    else if (dt === DataType.UUID || dt === DataType.ULID) fixedOffset += 16;
    cols.push({ type: dt, flags: fl, colOffset, name: def.name });
  }

  const pageCount = Math.ceil(cols.length / MAX_COLUMNS_PER_CATALOG_PAGE);
  const catPageIds: number[] = [];
  if (pager.hasPage(tableDesc.colCatalogPageId) && tableDesc.colCatalogPageId > 1) {
    catPageIds.push(tableDesc.colCatalogPageId);
  } else {
    catPageIds.push(pager.allocatePage());
  }
  while (catPageIds.length < pageCount) {
    catPageIds.push(pager.allocatePage());
  }

  for (let p = 0; p < pageCount; p++) {
    const pid = catPageIds[p];
    const nextPid = p + 1 < pageCount ? catPageIds[p + 1] : 0;
    const startColIdx = p * MAX_COLUMNS_PER_CATALOG_PAGE;
    const count = Math.min(cols.length - startColIdx, MAX_COLUMNS_PER_CATALOG_PAGE);
    const dv = pager.getPageView(pid)!;
    catalog_init_page(dv, 0, tableDesc.tableId, startColIdx, nextPid);
    dv.setUint16(2, count, true);
    for (let c = 0; c < count; c++) {
      catalog_write_column_meta(dv, 0, c, cols[startColIdx + c]);
    }
    pager.markPageDirty(pid);
  }

  if (
    tableDesc.colCatalogPageId !== catPageIds[0] ||
    tableDesc.columnCount !== cols.length
  ) {
    tableDesc.colCatalogPageId = catPageIds[0];
    tableDesc.columnCount = cols.length;
    catalog_write_table_descriptor(pager.getPageView(1)!, tableSlotIdx, tableDesc, {
      getPageBytes: pager.getPageBytes,
      markPageDirty: pager.markPageDirty,
    });
  }
}

function isColCatalogIntact(pager: BoundedBufferPager, desc: TableDescriptor): boolean {
  if (!pager.hasPage(desc.colCatalogPageId) || desc.colCatalogPageId <= 1) return false;
  let cur = desc.colCatalogPageId;
  let loaded = 0;
  const seen = new Set<number>();
  while (cur !== 0 && loaded < desc.columnCount) {
    if (!pager.hasPage(cur) || cur <= 1 || seen.has(cur)) return false;
    seen.add(cur);
    const dv = pager.getPageView(cur)!;
    if (page_get_type(dv, 0) !== PAGE_TYPE_CATALOG_PAGE) return false;
    const ch = catalog_read_page_header(dv, 0);
    if (ch.colCountInPage > MAX_COLUMNS_PER_CATALOG_PAGE) return false;
    loaded += ch.colCountInPage;
    cur = ch.nextColCatalogPageId;
  }
  return loaded === desc.columnCount;
}

function deserializeRowWithOverflow(
  pager: BoundedBufferPager,
  pageView: DataView,
  cellOff: number,
  meta: TableMeta,
  tableName: string,
  pageId: number,
  warnings: string[],
): DbRow | null {
  const overflowDescs: OverflowDescriptorInfo[] = [];
  const row = page_deserialize_row(pageView, cellOff, meta, undefined, overflowDescs);
  if (!row) return null;

  for (const desc of overflowDescs) {
    if (desc.totalLen > 64 * 1024 * 1024) {
      warnings.push(
        `Table "${tableName}" page ${pageId}: skipped oversized overflow length (${desc.totalLen}) on column "${desc.colName}"`,
      );
      row[desc.colName] = desc.isText ? "" : new Uint8Array(0);
      continue;
    }
    const out = new Uint8Array(desc.totalLen);
    let written = 0;
    let cur = desc.firstPageId;
    const seen = new Set<number>();
    let broken = false;

    while (cur !== 0 && written < desc.totalLen) {
      if (!pager.hasPage(cur) || cur <= 1 || seen.has(cur)) {
        broken = true;
        break;
      }
      seen.add(cur);
      const ob = pager.getPageBytes(cur);
      if (ob[0] !== PAGE_TYPE_OVERFLOW) {
        broken = true;
        break;
      }
      const odv = new DataView(ob.buffer, ob.byteOffset, PAGE_SIZE);
      const chunkLen = page_get_overflow_chunk_size(odv, 0);
      const toCopy = Math.min(chunkLen, desc.totalLen - written);
      if (toCopy <= 0 || OVERFLOW_HEADER_SIZE + toCopy > PAGE_SIZE) {
        broken = true;
        break;
      }
      out.set(ob.subarray(OVERFLOW_HEADER_SIZE, OVERFLOW_HEADER_SIZE + toCopy), written);
      written += toCopy;
      cur = page_get_overflow_next_page_id(odv, 0);
    }

    if (broken || written < desc.totalLen) {
      const colMeta = meta.columns.find((c) => c.name === desc.colName);
      const isNotNull = colMeta ? (colMeta.flags & ColumnFlag.NOT_NULL) !== 0 : false;
      warnings.push(
        `Table "${tableName}" page ${pageId}: incomplete overflow payload for "${desc.colName}" (${written}/${desc.totalLen} bytes)`,
      );
      if (written > 0) {
        const partial = out.subarray(0, written);
        row[desc.colName] = desc.isText ? textDecoder.decode(partial) : partial.slice();
      } else {
        row[desc.colName] = isNotNull
          ? desc.isText
            ? ""
            : new Uint8Array(0)
          : null;
      }
    } else {
      row[desc.colName] = desc.isText ? textDecoder.decode(out) : out;
    }
  }

  return row;
}

function decodeIndexKeySample(keyBytes: Uint8Array, pkCols: ColumnMeta[]): string {
  if (keyBytes.byteLength === 0) return "<null>";
  try {
    if (pkCols.length === 1) {
      const col = pkCols[0];
      const dv = new DataView(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);
      switch (col.type) {
        case DataType.ULID:
          return keyBytes.byteLength === 16 ? UlidCodec.decode(keyBytes, 0) : bytesToHex(keyBytes);
        case DataType.UUID:
          return keyBytes.byteLength === 16 ? UuidCodec.decode(keyBytes, 0) : bytesToHex(keyBytes);
        case DataType.INT32:
          return keyBytes.byteLength >= 4 ? String(dv.getInt32(0, true)) : bytesToHex(keyBytes);
        case DataType.INT64:
          return keyBytes.byteLength >= 8 ? String(dv.getBigInt64(0, true)) : bytesToHex(keyBytes);
        case DataType.FLOAT64:
          return keyBytes.byteLength >= 8 ? String(dv.getFloat64(0, true)) : bytesToHex(keyBytes);
        case DataType.TEXT:
          return textDecoder.decode(keyBytes);
        default:
          return bytesToHex(keyBytes);
      }
    }

    // Composite key format: [type(1B), len(2B LE), bytes(len)]*
    const parts: string[] = [];
    const dv = new DataView(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);
    let off = 0;
    while (off + 3 <= keyBytes.byteLength && parts.length < pkCols.length) {
      const t = dv.getUint8(off) as DataType;
      const len = dv.getUint16(off + 1, true);
      off += 3;
      if (len === 0) {
        parts.push("null");
        continue;
      }
      if (off + len > keyBytes.byteLength) break;
      const slice = keyBytes.subarray(off, off + len);
      off += len;
      parts.push(decodeIndexKeySample(slice, [{ ...pkCols[parts.length], type: t }]));
    }
    return parts.length > 0 ? parts.join(":") : bytesToHex(keyBytes);
  } catch {
    return bytesToHex(keyBytes);
  }
}

function rowSatisfiesSchemaHeuristically(row: DbRow, meta: TableMeta): { ok: boolean; score: number } {
  let score = 1;
  for (const col of meta.columns) {
    const val = row[col.name];
    if ((col.flags & ColumnFlag.NOT_NULL) !== 0 && (val === null || val === undefined)) {
      return { ok: false, score: 0 };
    }
    if (val === null || val === undefined) continue;
    if (col.type === DataType.TEXT && typeof val === "string") {
      if (val.includes("\uFFFD")) return { ok: false, score: 0 };
      // Bonus if ASCII printable string
      let controlChars = 0;
      for (let i = 0; i < Math.min(val.length, 64); i++) {
        const code = val.charCodeAt(i);
        if (code < 9 || (code > 13 && code < 32)) controlChars++;
      }
      if (controlChars > 0) return { ok: false, score: 0 };
      score += 1;
    } else if (col.type === DataType.ULID && typeof val === "string" && val.length === 26) {
      score += 2;
    } else {
      score += 0.5;
    }
  }
  return { ok: true, score };
}

function makePkDedupKey(meta: TableMeta, row: DbRow): string | null {
  if (!meta.primaryKey || meta.primaryKey.length === 0) return null;
  if (meta.primaryKey.length === 1) {
    const col = meta.getColumn(meta.primaryKey[0]);
    if (!col) return null;
    const b = serialize_single_key(col.type, row[col.name]);
    return `${col.type}:${bytesToHex(b)}`;
  }
  return meta.primaryKey
    .map((colName) => {
      const col = meta.getColumn(colName);
      const b = col ? serialize_single_key(col.type, row[colName]) : new Uint8Array(0);
      return bytesToHex(b);
    })
    .join("|");
}

/**
 * Deterministically recovers a damaged WebDB binary buffer into a clean, compacted
 * WebDB database image (and structured per-table report), without mutating `rawBytes`.
 */
export async function recoverDatabaseBuffer(
  rawBytes: Uint8Array,
  options: RecoverOptions = {},
): Promise<{ binary: Uint8Array | null; report: RecoveryReport }> {
  if (rawBytes.byteLength < PAGE_SIZE) {
    throw new Error(
      `Invalid database file (${rawBytes.byteLength} bytes < ${PAGE_SIZE}-byte page size)`,
    );
  }

  const copy = new Uint8Array(rawBytes.byteLength);
  copy.set(rawBytes);

  const pager = new BoundedBufferPager(copy);
  const warnings: string[] = [];

  if (
    options.walBytes &&
    options.walBytes.byteLength >= WAL_FILE_HEADER_SIZE &&
    options.replayWal !== false
  ) {
    replayWalOntoPager(pager, options.walBytes, warnings);
  }

  const inputPages = pager.totalPages;
  const p1View = pager.getPageView(1)!;
  catalog_read_page1_header(p1View, false);

  const report: RecoveryReport = {
    dryRun: Boolean(options.dryRun),
    inputPages,
    outputPages: 0,
    repairedCatalogPages: [],
    deduplicatedIndexes: 0,
    tablesRecovered: 0,
    tablesSkipped: 0,
    totalRowsRecovered: 0,
    orphanLeafPagesRecovered: 0,
    unmappedOrphanPages: [],
    tables: [],
    warnings,
  };

  // 1. Repair zeroed-header overflow catalog pages (0x0C) & relink Page 1 chains
  repairOverflowCatalogPages(pager, report);

  // 2. Read all table descriptors across Page 1 + repaired overflow pages
  const rawTableSlots: Array<{ slotIdx: number; desc: TableDescriptor }> = [];
  const tableCapacity = catalog_get_table_slot_capacity(p1View, pager);
  for (let s = 0; s < tableCapacity; s++) {
    const desc = catalog_read_table_descriptor(p1View, s, pager);
    if (desc && (desc.flags & TableFlag.ACTIVE) !== 0) {
      rawTableSlots.push({ slotIdx: s, desc });
    }
  }
  rawTableSlots.sort((a, b) => a.desc.tableId - b.desc.tableId);

  // Resolve case-insensitive schema lookup
  const schemaEntries = new Map<string, RecoveryTableSchema>();
  if (options.schema) {
    for (const [k, v] of Object.entries(options.schema)) {
      schemaEntries.set(k.toLowerCase(), v);
    }
  }

  const loadedTables: TableMeta[] = [];
  const skippedTables: TableDescriptor[] = [];
  const repairedColCatTables = new Set<string>();

  for (const { slotIdx, desc } of rawTableSlots) {
    if (!isColCatalogIntact(pager, desc)) {
      const schemaDef =
        options.schema?.[desc.name] ?? schemaEntries.get(desc.name.toLowerCase());
      if (!schemaDef) {
        skippedTables.push(desc);
        warnings.push(
          `Table "${desc.name}" (id=${desc.tableId}, colCatalogPageId=${desc.colCatalogPageId}): column catalog page is damaged and no --schema definition was supplied; skipping table`,
        );
        continue;
      }
      if (schemaDef.columns.length !== desc.columnCount) {
        warnings.push(
          `Table "${desc.name}": --schema defines ${schemaDef.columns.length} columns vs disk columnCount=${desc.columnCount}; using --schema definition`,
        );
      }
      writeColCatalogFromSchema(pager, desc, slotIdx, schemaDef);
      repairedColCatTables.add(desc.name);
    }
    const meta = catalog_load_table_meta(p1View, pager, desc.name);
    loadedTables.push(meta);
  }

  // 3. Collect all 0x0D leaf pages across 2..totalPages and build next-pointer graph
  const allLeafPages: number[] = [];
  const nextLeaf = new Map<number, number>();
  const leafInDegree = new Map<number, number>();
  for (let pid = 2; pid <= pager.totalPages; pid++) {
    const pv = pager.getPageView(pid)!;
    if (page_get_type(pv, 0) === PAGE_TYPE_LEAF_DATA) {
      allLeafPages.push(pid);
      const nxt = page_get_next_page_id(pv, 0);
      nextLeaf.set(pid, nxt);
      if (nxt > 1) {
        leafInDegree.set(nxt, (leafInDegree.get(nxt) ?? 0) + 1);
      }
    }
  }

  const visitedLeafPages = new Set<number>();
  const reachablePagesByTable = new Map<string, number[]>();
  const brokenChainsByTable = new Map<string, number[]>();

  for (const t of loadedTables) {
    const walk = collectTableLeafPages(pager, t.rootPageId, t.name);
    reachablePagesByTable.set(t.name, walk.leafPages);
    brokenChainsByTable.set(t.name, walk.brokenAt);
    for (const pid of walk.leafPages) visitedLeafPages.add(pid);
  }

  // Group remaining unvisited 0x0D pages into orphan chains
  const orphanLeafSet = new Set(allLeafPages.filter((p) => !visitedLeafPages.has(p)));
  const orphanChains: Array<{ head: number; pages: number[] }> = [];
  const consumedOrphans = new Set<number>();

  const collectChainFromHead = (head: number): void => {
    const chain: number[] = [];
    let cur = head;
    while (cur !== 0 && orphanLeafSet.has(cur) && !consumedOrphans.has(cur)) {
      consumedOrphans.add(cur);
      chain.push(cur);
      cur = nextLeaf.get(cur) ?? 0;
    }
    if (chain.length > 0) {
      orphanChains.push({ head, pages: chain });
    }
  };

  for (const pid of allLeafPages) {
    if (orphanLeafSet.has(pid) && !consumedOrphans.has(pid) && !leafInDegree.has(pid)) {
      collectChainFromHead(pid);
    }
  }
  for (const pid of allLeafPages) {
    if (orphanLeafSet.has(pid) && !consumedOrphans.has(pid)) {
      collectChainFromHead(pid);
    }
  }

  // 4. Read all deduplicated secondary indexes & scan index cells for orphan voting + lost key reporting
  const metaByName = new Map(loadedTables.map((t) => [t.name, t]));
  const metaById = new Map(loadedTables.map((t) => [t.tableId, t]));
  const indexesByTable = new Map<
    string,
    Array<{ name: string; columns: string[]; unique: boolean; rootPages: number[] }>
  >();
  let deduplicatedIndexes = 0;

  const cap = (() => {
    const nextIdx = p1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true);
    let total = MAX_INDEXES_PAGE1;
    let cur = nextIdx;
    const seen = new Set<number>();
    while (cur !== 0 && pager.hasPage(cur) && !seen.has(cur)) {
      seen.add(cur);
      total += MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
      const pv = pager.getPageView(cur)!;
      if (page_get_type(pv, 0) !== PAGE_TYPE_CATALOG_PAGE) break;
      cur = pv.getUint32(8, true);
    }
    return total;
  })();

  const seenIdxByName = new Map<string, { name: string; columns: string[]; unique: boolean; rootPages: number[] }>();
  const seenIdxByCols = new Map<string, { name: string; columns: string[]; unique: boolean; rootPages: number[] }>();

  for (let i = 0; i < cap; i++) {
    const idx = catalog_read_index_descriptor(p1View, i, pager);
    if (!idx) continue;
    const tMeta = metaById.get(idx.tableId);
    if (!tMeta) continue;
    const colNames = idx.columnIndices
      .slice(0, idx.columnCount)
      .map((ci) => tMeta.columns[ci]?.name)
      .filter((n): n is string => Boolean(n));
    if (colNames.length !== idx.columnCount) continue;

    const nameKey = `${tMeta.name}:${idx.name.toLowerCase()}`;
    const colsKey = `${tMeta.name}:${colNames.join(",").toLowerCase()}`;
    const existing = seenIdxByName.get(nameKey) ?? seenIdxByCols.get(colsKey);
    const isUnique = (idx.flags & IndexFlag.UNIQUE) !== 0;

    if (existing) {
      deduplicatedIndexes++;
      if (isUnique) existing.unique = true;
      if (idx.rootPageId > 1 && !existing.rootPages.includes(idx.rootPageId)) {
        existing.rootPages.push(idx.rootPageId);
      }
      continue;
    }

    const entry = {
      name: idx.name,
      columns: colNames,
      unique: isUnique,
      rootPages: idx.rootPageId > 1 ? [idx.rootPageId] : [],
    };
    seenIdxByName.set(nameKey, entry);
    seenIdxByCols.set(colsKey, entry);
    if (!indexesByTable.has(tMeta.name)) indexesByTable.set(tMeta.name, []);
    indexesByTable.get(tMeta.name)!.push(entry);
  }

  // Merge user-provided indexes for tables whose schemas were supplied
  if (options.schema) {
    for (const [rawTblName, def] of Object.entries(options.schema)) {
      const tMeta =
        metaByName.get(rawTblName) ??
        loadedTables.find((t) => t.name.toLowerCase() === rawTblName.toLowerCase());
      if (!tMeta || !def.indexes) continue;
      for (const idxSpec of def.indexes) {
        const cols = Array.isArray(idxSpec.columns) ? idxSpec.columns : [idxSpec.columns];
        const idxName = idxSpec.name ?? `idx_${tMeta.name}_${cols.join("_")}`;
        const nameKey = `${tMeta.name}:${idxName.toLowerCase()}`;
        const colsKey = `${tMeta.name}:${cols.join(",").toLowerCase()}`;
        if (seenIdxByName.has(nameKey) || seenIdxByCols.has(colsKey)) continue;
        const allColsExist = cols.every((cn) => tMeta.columns.some((c) => c.name === cn));
        if (!allColsExist) continue;
        const entry = {
          name: idxName,
          columns: cols,
          unique: Boolean(idxSpec.unique),
          rootPages: [],
        };
        seenIdxByName.set(nameKey, entry);
        seenIdxByCols.set(colsKey, entry);
        if (!indexesByTable.has(tMeta.name)) indexesByTable.set(tMeta.name, []);
        indexesByTable.get(tMeta.name)!.push(entry);
      }
    }
  }
  report.deduplicatedIndexes = deduplicatedIndexes;

  // Map every orphan page -> chain head, and gather index votes per orphan chain
  const pageToChainHead = new Map<number, number>();
  for (const ch of orphanChains) {
    for (const pid of ch.pages) pageToChainHead.set(pid, ch.head);
  }

  const chainVotes = new Map<number, Map<string, number>>();
  const tablePkScan = new Map<
    string,
    Array<{ keyBytes: Uint8Array; targetPage: number; targetSlot: number }>
  >();

  for (const t of loadedTables) {
    const pkRoot = (t as any).pkRootPageId as number | undefined;
    const rootsToScan: Array<{ isPk: boolean; root: number }> = [];
    if (pkRoot && pkRoot > 1) {
      rootsToScan.push({ isPk: true, root: pkRoot });
    }
    for (const idx of indexesByTable.get(t.name) ?? []) {
      for (const rp of idx.rootPages) {
        rootsToScan.push({ isPk: false, root: rp });
      }
    }

    for (const { isPk, root } of rootsToScan) {
      const scan = scanIndexCells(pager, root);
      if (isPk && !tablePkScan.has(t.name)) {
        tablePkScan.set(t.name, scan.entries);
      }
      for (const entry of scan.entries) {
        const chHead = pageToChainHead.get(entry.targetPage);
        if (chHead !== undefined) {
          if (!chainVotes.has(chHead)) chainVotes.set(chHead, new Map());
          const tVotes = chainVotes.get(chHead)!;
          tVotes.set(t.name, (tVotes.get(t.name) ?? 0) + (isPk ? 3 : 1));
        }
      }
    }
  }

  // Assign each orphan chain deterministically
  const orphanPagesByTable = new Map<string, number[]>();
  const orphanLeafPagesRecoveredSet = new Set<number>();

  for (const ch of orphanChains) {
    const firstNonEmptyPid = ch.pages.find((pid) => {
      const pv = pager.getPageView(pid)!;
      return page_get_cell_count(pv, 0) > 0;
    });

    let assignedTable: string | null = null;

    // Signal 1: Index back-pointer voting
    const votes = chainVotes.get(ch.head);
    if (votes && votes.size > 0) {
      const sortedVotes = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      for (const [candidateName] of sortedVotes) {
        const meta = metaByName.get(candidateName);
        if (!meta) continue;
        if (!firstNonEmptyPid) {
          assignedTable = candidateName;
          break;
        }
        const pv = pager.getPageView(firstNonEmptyPid)!;
        const off = page_get_cell_offset(pv, 0, 0);
        const row = page_deserialize_row(pv, off, meta);
        if (row && rowSatisfiesSchemaHeuristically(row, meta).ok) {
          assignedTable = candidateName;
          break;
        }
      }
    }

    // Signal 2: Strict schema deserialization fallback when index pages are also absent/zeroed
    if (!assignedTable && firstNonEmptyPid) {
      const pv = pager.getPageView(firstNonEmptyPid)!;
      const cnt = Math.min(page_get_cell_count(pv, 0), MAX_SLOTS_PER_PAGE);
      const candidates: Array<{ name: string; score: number }> = [];

      for (const t of loadedTables) {
        const hadBrokenChain = (brokenChainsByTable.get(t.name)?.length ?? 0) > 0;
        const reachableCount = (reachablePagesByTable.get(t.name) ?? []).reduce((s, p) => {
          return s + page_get_cell_count(pager.getPageView(p)!, 0);
        }, 0);
        const likelyMissing = hadBrokenChain || reachableCount < t.rowCountEstimate;
        if (!likelyMissing) continue;

        let allOk = true;
        let totalScore = 0;
        for (let i = 0; i < cnt; i++) {
          const off = page_get_cell_offset(pv, 0, i);
          const row = page_deserialize_row(pv, off, t);
          if (!row) {
            allOk = false;
            break;
          }
          const h = rowSatisfiesSchemaHeuristically(row, t);
          if (!h.ok) {
            allOk = false;
            break;
          }
          totalScore += h.score;
        }
        if (allOk && cnt > 0) {
          candidates.push({ name: t.name, score: totalScore / cnt });
        }
      }

      if (candidates.length === 1) {
        assignedTable = candidates[0].name;
      } else if (candidates.length > 1) {
        candidates.sort((a, b) => b.score - a.score);
        if (candidates[0].score > candidates[1].score + 0.5) {
          assignedTable = candidates[0].name;
        }
      }
    }

    if (assignedTable) {
      if (!orphanPagesByTable.has(assignedTable)) orphanPagesByTable.set(assignedTable, []);
      orphanPagesByTable.get(assignedTable)!.push(...ch.pages);
      for (const pid of ch.pages) orphanLeafPagesRecoveredSet.add(pid);
    } else {
      const hasRows = firstNonEmptyPid !== undefined;
      if (hasRows) {
        report.unmappedOrphanPages.push(...ch.pages);
        warnings.push(
          `Could not map orphan 0x0D leaf chain [${summarizePageList(ch.pages)}] to any table schema`,
        );
      }
    }
  }
  report.orphanLeafPagesRecovered = orphanLeafPagesRecoveredSet.size;

  // 5. Deserialize rows per table and track missing PK entries
  const rowsByTable = new Map<string, DbRow[]>();

  for (const t of loadedTables) {
    const reachPages = reachablePagesByTable.get(t.name) ?? [];
    const orphPages = orphanPagesByTable.get(t.name) ?? [];
    const seenPks = new Set<string>();
    const rows: DbRow[] = [];
    let reachableRows = 0;
    let orphanRowsRecovered = 0;

    const extractPageRows = (pid: number, isOrphan: boolean): number => {
      const pv = pager.getPageView(pid)!;
      const cnt = Math.min(page_get_cell_count(pv, 0), MAX_SLOTS_PER_PAGE);
      let added = 0;
      for (let i = 0; i < cnt; i++) {
        const off = page_get_cell_offset(pv, 0, i);
        const row = deserializeRowWithOverflow(pager, pv, off, t, t.name, pid, warnings);
        if (!row) {
          warnings.push(`Table "${t.name}" page ${pid} slot ${i}: skipped corrupt row`);
          continue;
        }
        const pkKey = makePkDedupKey(t, row);
        if (pkKey !== null) {
          if (seenPks.has(pkKey)) continue;
          seenPks.add(pkKey);
        }
        rows.push(row);
        added++;
      }
      if (isOrphan) orphanRowsRecovered += added;
      else reachableRows += added;
      return added;
    };

    for (const pid of reachPages) extractPageRows(pid, false);
    for (const pid of orphPages) extractPageRows(pid, true);
    rowsByTable.set(t.name, rows);

    // Inspect PK index entries pointing to dead (non-0x0D / unmapped) pages
    const recoveredLeafSet = new Set([...reachPages, ...orphPages]);
    const pkEntries = tablePkScan.get(t.name) ?? [];
    const lostKeysSample: string[] = [];
    let lostIndexEntries = 0;

    if (pkEntries.length > 0 && t.primaryKey && t.primaryKey.length > 0) {
      const pkCols = t.primaryKey
        .map((n) => t.getColumn(n))
        .filter((c): c is ColumnMeta => Boolean(c));
      for (const e of pkEntries) {
        if (!recoveredLeafSet.has(e.targetPage)) {
          lostIndexEntries++;
          if (lostKeysSample.length < 50 && pkCols.length > 0) {
            lostKeysSample.push(decodeIndexKeySample(e.keyBytes, pkCols));
          }
        }
      }
    } else if (t.rowCountEstimate > rows.length) {
      lostIndexEntries = t.rowCountEstimate - rows.length;
    }

    report.tables.push({
      tableId: t.tableId,
      name: t.name,
      status: "recovered",
      columnCount: t.columnCount,
      rowCountEstimate: t.rowCountEstimate,
      reachableRows,
      orphanRowsRecovered,
      totalRecoveredRows: rows.length,
      lostIndexEntries,
      ...(lostKeysSample.length > 0 ? { lostKeysSample } : {}),
      repairedColCatalog: repairedColCatTables.has(t.name),
      brokenChainPages: brokenChainsByTable.get(t.name) ?? [],
    });
    report.tablesRecovered++;
    report.totalRowsRecovered += rows.length;
  }

  for (const skipped of skippedTables) {
    report.tables.push({
      tableId: skipped.tableId,
      name: skipped.name,
      status: "skipped_missing_schema",
      columnCount: skipped.columnCount,
      rowCountEstimate: skipped.rowCountEstimate,
      reachableRows: 0,
      orphanRowsRecovered: 0,
      totalRecoveredRows: 0,
      lostIndexEntries: skipped.rowCountEstimate,
      repairedColCatalog: false,
      brokenChainPages: [],
    });
    report.tablesSkipped++;
  }
  report.tables.sort((a, b) => a.tableId - b.tableId);

  if (options.dryRun) {
    return { binary: null, report };
  }

  // 6. Rebuild cleanly in fresh WebDB instance
  const slotCount = Math.min(65536, Math.max(2048, inputPages + 256));
  const db = await WebDB.open({
    storage: new MemoryStorage(),
    engine: createEngine(options.core ?? "js"),
    slotCount,
    crossTabSync: false,
  });

  try {
    for (const t of loadedTables) {
      const colDefs: ColumnDefinition[] = t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        primaryKey: (c.flags & ColumnFlag.PRIMARY_KEY) !== 0,
        notNull: (c.flags & ColumnFlag.NOT_NULL) !== 0,
        indexed: (c.flags & ColumnFlag.INDEXED) !== 0,
        autoInc: (c.flags & ColumnFlag.AUTO_INC) !== 0,
      }));
      await db.createTable(t.name, colDefs);
    }

    for (const t of loadedTables) {
      const rows = rowsByTable.get(t.name) ?? [];
      if (rows.length === 0) continue;
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        try {
          await db.insertMany(t.name, chunk);
        } catch {
          for (const row of chunk) {
            try {
              await db.insertMany(t.name, [row]);
            } catch (err: any) {
              warnings.push(
                `Table "${t.name}": rejected row during rebuild (${err?.message ?? String(err)})`,
              );
            }
          }
        }
      }
    }

    for (const t of loadedTables) {
      for (const idx of indexesByTable.get(t.name) ?? []) {
        try {
          await db.createIndex(t.name, idx.columns, {
            name: idx.name,
            unique: idx.unique,
          });
        } catch (err: any) {
          if (idx.unique) {
            warnings.push(
              `Index "${idx.name}" on "${t.name}": unique build failed (${err?.message ?? String(err)}); rebuilding as non-unique`,
            );
            try {
              await db.createIndex(t.name, idx.columns, {
                name: idx.name,
                unique: false,
              });
            } catch (err2: any) {
              warnings.push(
                `Index "${idx.name}" on "${t.name}" skipped: ${err2?.message ?? String(err2)}`,
              );
            }
          } else {
            warnings.push(
              `Index "${idx.name}" on "${t.name}" skipped: ${err?.message ?? String(err)}`,
            );
          }
        }
      }
    }

    const binary = await db.exportBinary();
    report.outputPages = binary.byteLength / PAGE_SIZE;
    return { binary, report };
  } finally {
    await db.close();
  }
}

/**
 * Inspects a damaged database image (repairing overflow catalog headers in memory)
 * and builds an editable schema template JSON map for every table whose column catalog page
 * chain (`0x0C`) is damaged, pre-populating column counts, inferred PK types/flags, and
 * surviving secondary index definitions.
 */
export function buildRecoverySchemaTemplate(
  rawBytes: Uint8Array,
  options: { walBytes?: Uint8Array | null; replayWal?: boolean } = {},
): {
  template: RecoverySchemaMap;
  missingTables: Array<{
    tableId: number;
    name: string;
    columnCount: number;
    colCatalogPageId: number;
    rowCountEstimate: number;
  }>;
} {
  if (rawBytes.byteLength < PAGE_SIZE) {
    throw new Error(
      `Invalid database file (${rawBytes.byteLength} bytes < ${PAGE_SIZE}-byte page size)`,
    );
  }

  const copy = new Uint8Array(rawBytes.byteLength);
  copy.set(rawBytes);

  const pager = new BoundedBufferPager(copy);
  const warnings: string[] = [];

  if (
    options.walBytes &&
    options.walBytes.byteLength >= WAL_FILE_HEADER_SIZE &&
    options.replayWal !== false
  ) {
    replayWalOntoPager(pager, options.walBytes, warnings);
  }

  const p1View = pager.getPageView(1)!;
  catalog_read_page1_header(p1View, false);

  const dummyReport: RecoveryReport = {
    dryRun: true,
    inputPages: pager.totalPages,
    outputPages: 0,
    repairedCatalogPages: [],
    deduplicatedIndexes: 0,
    tablesRecovered: 0,
    tablesSkipped: 0,
    totalRowsRecovered: 0,
    orphanLeafPagesRecovered: 0,
    unmappedOrphanPages: [],
    tables: [],
    warnings,
  };
  repairOverflowCatalogPages(pager, dummyReport);

  const tableSlots: TableDescriptor[] = [];
  const tableCapacity = catalog_get_table_slot_capacity(p1View, pager);
  for (let s = 0; s < tableCapacity; s++) {
    const desc = catalog_read_table_descriptor(p1View, s, pager);
    if (desc && (desc.flags & TableFlag.ACTIVE) !== 0) {
      tableSlots.push(desc);
    }
  }
  tableSlots.sort((a, b) => a.tableId - b.tableId);

  const idxCapacity = (() => {
    const nextIdx = p1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true);
    let total = MAX_INDEXES_PAGE1;
    let cur = nextIdx;
    const seen = new Set<number>();
    while (cur !== 0 && pager.hasPage(cur) && !seen.has(cur)) {
      seen.add(cur);
      total += MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
      const pv = pager.getPageView(cur)!;
      if (page_get_type(pv, 0) !== PAGE_TYPE_CATALOG_PAGE) break;
      cur = pv.getUint32(8, true);
    }
    return total;
  })();

  const rawIdxByTable = new Map<number, IndexDescriptor[]>();
  const seenIdx = new Set<string>();
  for (let i = 0; i < idxCapacity; i++) {
    const idx = catalog_read_index_descriptor(p1View, i, pager);
    if (!idx) continue;
    const key = `${idx.tableId}:${idx.name.toLowerCase()}`;
    if (seenIdx.has(key)) continue;
    seenIdx.add(key);
    if (!rawIdxByTable.has(idx.tableId)) rawIdxByTable.set(idx.tableId, []);
    rawIdxByTable.get(idx.tableId)!.push(idx);
  }

  const template: RecoverySchemaMap = {};
  const missingTables: Array<{
    tableId: number;
    name: string;
    columnCount: number;
    colCatalogPageId: number;
    rowCountEstimate: number;
  }> = [];

  for (const desc of tableSlots) {
    if (isColCatalogIntact(pager, desc)) continue;

    missingTables.push({
      tableId: desc.tableId,
      name: desc.name,
      columnCount: desc.columnCount,
      colCatalogPageId: desc.colCatalogPageId,
      rowCountEstimate: desc.rowCountEstimate,
    });

    const pkColIndices = new Set<number>();
    if (desc.pkColumnCount && desc.pkColumnIndices) {
      for (let i = 0; i < desc.pkColumnCount; i++) {
        pkColIndices.add(desc.pkColumnIndices[i]);
      }
    }

    // Best-guess single-column PK type by inspecting surviving pk index cells if intact
    let guessedPkType: DataTypeString = "TEXT";
    if (pkColIndices.size === 1 && desc.pkRootPageId && desc.pkRootPageId > 1) {
      const pkScan = scanIndexCells(pager, desc.pkRootPageId);
      if (pkScan.entries.length > 0) {
        const len = pkScan.entries[0].keyBytes.byteLength;
        if (len === 16) guessedPkType = "ULID";
        else if (len === 4) guessedPkType = "INT32";
      }
    }

    const tblIdxs = rawIdxByTable.get(desc.tableId) ?? [];
    const colIndexHints = new Map<number, string[]>();
    for (const ix of tblIdxs) {
      for (let k = 0; k < ix.columnCount; k++) {
        const ci = ix.columnIndices[k];
        if (!colIndexHints.has(ci)) colIndexHints.set(ci, []);
        colIndexHints.get(ci)!.push(ix.name);
      }
    }

    const columns: RecoveryColumnSchema[] = [];
    for (let c = 0; c < desc.columnCount; c++) {
      const isPk = pkColIndices.has(c);
      const colName = isPk && c === 0 ? "id" : `col_${c}`;
      const colType: DataTypeString = isPk && pkColIndices.size === 1 ? guessedPkType : "TEXT";
      const hints = colIndexHints.get(c);
      columns.push({
        name: colName,
        type: colType,
        ...(isPk ? { flags: { primaryKey: true, notNull: true } } : {}),
        ...(hints && hints.length > 0
          ? { _hint: `referenced by index: ${hints.join(", ")}` }
          : {}),
      });
    }

    const indexes: RecoveryIndexSchema[] = tblIdxs.map((ix) => {
      const colNames: string[] = [];
      for (let k = 0; k < ix.columnCount; k++) {
        const ci = ix.columnIndices[k];
        colNames.push(columns[ci]?.name ?? `col_${ci}`);
      }
      return {
        name: ix.name,
        columns: colNames,
        ...((ix.flags & IndexFlag.UNIQUE) !== 0 ? { unique: true } : {}),
      };
    });

    template[desc.name] = { columns, indexes };
  }

  return { template, missingTables };
}
