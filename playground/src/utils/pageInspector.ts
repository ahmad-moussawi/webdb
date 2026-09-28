import {
  PAGE_SIZE,
  FILE_HEADER_SIZE,
  MASTER_TABLE_OFFSET,
  INDEX_CATALOG_OFFSET,
  MAX_TABLES_PAGE1,
  MAX_INDEXES_PAGE1,
  TABLE_DESCRIPTOR_SIZE,
  INDEX_DESCRIPTOR_SIZE,
  PAGE_HEADER_SIZE,
  PAGE_HEADER_OFFSET_TYPE,
  PAGE_HEADER_OFFSET_FLAGS,
  PAGE_HEADER_OFFSET_CELL_COUNT,
  PAGE_HEADER_OFFSET_CONTENT_OFFSET,
  PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
  PAGE_HEADER_OFFSET_FREE_BYTES,
  PAGE_HEADER_OFFSET_CHECKSUM,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_LEAF_DATA,
  HEADER_OFFSET_MAGIC,
  HEADER_OFFSET_PAGE_SIZE,
  HEADER_OFFSET_FILE_FORMAT_VERSION,
  HEADER_OFFSET_MIN_READ_VERSION,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_SCHEMA_VERSION,
  HEADER_OFFSET_CHANGE_COUNTER,
  HEADER_OFFSET_PAGE_CHECKSUM,
  page_deserialize_row,
} from '@webdb/core';
import type { TableMeta, TableColumnMeta } from '../types/studio.ts';

export interface DiscoveredPage {
  pageId: number;
  label: string;
  tableName?: string;
  pageType: number;
  role: 'system' | 'root' | 'leaf' | 'catalog' | 'interior' | 'index' | 'free' | 'unknown';
  cellCount?: number;
  usedBytes?: number;
  freeBytes?: number;
  usagePercent?: number;
}

export interface MemorySegment {
  name: string;
  start: number;
  end: number;
  size: number;
  color: string;
  category: 'header' | 'slot_dir' | 'free' | 'payload' | 'reserved';
}

export interface ColumnByteRange {
  colName: string;
  start: number;
  end: number;
  length: number;
  isNull: boolean;
  val?: any;
}

export interface DecodedCell {
  cellIndex: number;
  offset: number;
  length: number;
  data?: any;
  childPageId?: number;
  separatorRowId?: string;
  rawHex?: string;
  error?: string;
  columnRanges?: Record<string, ColumnByteRange>;
}

export interface ColumnCatalogDescriptor {
  columnIndex: number;
  colId: number;
  name: string;
  type: number;
  typeName: string;
  flags: number;
  isPrimaryKey: boolean;
  isNotNull: boolean;
  isAutoInc: boolean;
  colOffset: number;
  rawOffset: number;
  rawBytesHex: string;
}

export interface SysPageTableDesc {
  tableId: number;
  columnCount: number;
  rootPageId: number;
  colCatalogPageId: number;
  name: string;
  flags: number;
  rowCountEstimate: number;
  autoIncNext: number;
}

export interface SysPageIndexDesc {
  indexId: number;
  tableId: number;
  rootPageId: number;
  name: string;
  indexedColCount: number;
}

export interface BTreeNode {
  pageId: number;
  label: string;
  tableName?: string;
  role: string;
  pageType: number;
  pageTypeName: string;
  cellCount?: number;
  usedBytes?: number;
  usagePercent?: number;
  children: BTreeNode[];
  keysSummary?: string;
  isSiblingChain?: boolean;
}

export interface ParsedPage {
  pageId: number;
  bytes: Uint8Array;
  isPage1: boolean;
  header: {
    pageType?: number;
    pageTypeName: string;
    flags?: number;
    cellCount?: number;
    contentOffset?: number;
    nextPageId?: number;
    freeBytes?: number;
    checksum?: number;
    // Page 1 specific
    magic?: string;
    pageSize?: number;
    fileFormatVersion?: number;
    minReadVersion?: number;
    totalPages?: number;
    freePageHead?: number;
    schemaVersion?: number;
    changeCounter?: number;
    tables?: SysPageTableDesc[];
    indexes?: SysPageIndexDesc[];
    // Catalog page specific (0x0C)
    colCountInPage?: number;
    tableId?: number;
    startColIndex?: number;
    nextColCatalogPageId?: number;
  };
  slotOffsets: number[];
  memoryDistribution: {
    segments: MemorySegment[];
    headerBytes: number;
    slotDirBytes: number;
    freeBytes: number;
    payloadBytes: number;
    fragmentedBytes: number;
  };
  cells: DecodedCell[];
  columnCatalogDescriptors?: ColumnCatalogDescriptor[];
  associatedTable?: TableMeta;
}

export const PAGE_TYPE_NAMES: Record<number, string> = {
  [PAGE_TYPE_FREE]: 'Free Page (0x00)',
  [PAGE_TYPE_INDEX_INTERIOR]: 'Index Interior (0x02)',
  [PAGE_TYPE_TABLE_INTERIOR]: 'Table Interior (0x05)',
  [PAGE_TYPE_INDEX_LEAF]: 'Index Leaf (0x0A)',
  [PAGE_TYPE_CATALOG_PAGE]: 'Column Catalog (0x0C)',
  [PAGE_TYPE_LEAF_DATA]: 'Table Leaf Data (0x0D)',
};

export const DATA_TYPE_NAMES: Record<number, string> = {
  0: 'NULL',
  1: 'INT32',
  2: 'INT64',
  3: 'FLOAT64',
  4: 'TEXT',
  5: 'BLOB',
  6: 'UUID',
  7: 'ULID',
};

export const PAGE_TYPE_RGB: Record<number, [number, number, number]> = {
  [-1]: [139, 92, 246], // System Page 1: Purple
  [PAGE_TYPE_LEAF_DATA]: [16, 185, 129], // Table Leaf Data: Emerald
  [PAGE_TYPE_TABLE_INTERIOR]: [59, 130, 246], // Table Interior: Blue
  [PAGE_TYPE_CATALOG_PAGE]: [6, 182, 212], // Column Catalog: Cyan
  [PAGE_TYPE_INDEX_LEAF]: [245, 158, 11], // Index Leaf: Amber
  [PAGE_TYPE_INDEX_INTERIOR]: [99, 102, 241], // Index Interior: Indigo
  [PAGE_TYPE_FREE]: [100, 116, 139], // Free Page: Slate
};

export function getPageTypeRgbColor(pageType: number, alpha: number = 1): string {
  const rgb = PAGE_TYPE_RGB[pageType] || [148, 163, 184];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * In the heatmap: color indicates type, opacity indicates utilization!
 */
export function getPageHeatColorByUtilization(pageType: number, usagePercent: number = 0): {
  fill: string;
  border: string;
} {
  const rgb = PAGE_TYPE_RGB[pageType] || [148, 163, 184];
  const pct = Math.max(0, Math.min(100, usagePercent));
  // Scale opacity smoothly: 0% -> 0.15, 100% -> 1.0
  const alpha = 0.15 + 0.85 * (pct / 100);
  return {
    fill: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(2)})`,
    border: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.min(1, alpha + 0.15).toFixed(2)})`,
  };
}

/**
 * Fetch raw 4KB page bytes from resident buffer pool or persistent VFS
 */
export async function readPageBytes(db: any, pageId: number): Promise<Uint8Array | null> {
  if (!db || pageId <= 0) return null;

  // 1. Check if resident in BufferPoolDriver
  try {
    if (db.driver && typeof db.driver.getResidentSlot === 'function') {
      const slot = db.driver.getResidentSlot(pageId);
      if (slot !== -1 && slot !== undefined) {
        const slotBytes = db.driver.getPageBytesInSlot(slot);
        return new Uint8Array(slotBytes);
      }
    }
  } catch (err) {
    console.warn(`Buffer pool read error for page ${pageId}:`, err);
  }

  // 2. Read through VFS
  try {
    if (db.vfs && typeof db.vfs.readPage === 'function') {
      const vfsBytes = await db.vfs.readPage(pageId);
      if (vfsBytes) {
        return new Uint8Array(vfsBytes);
      }
    }
  } catch (err) {
    console.warn(`VFS read error for page ${pageId}:`, err);
  }

  return null;
}

function computePageStats(pageBytes: Uint8Array | null, pageId: number) {
  if (!pageBytes || pageBytes.byteLength < 16) {
    return { pageType: PAGE_TYPE_FREE, cellCount: 0, usedBytes: 0, freeBytes: 4096, usagePercent: 0 };
  }
  const v = new DataView(pageBytes.buffer, pageBytes.byteOffset, pageBytes.byteLength);
  if (pageId === 1) {
    const usedBytes = 100 + 2048 + 1024;
    return {
      pageType: -1,
      cellCount: 0,
      usedBytes,
      freeBytes: 924,
      usagePercent: Math.round((usedBytes / 4096) * 100),
    };
  }

  const pageType = v.getUint8(PAGE_HEADER_OFFSET_TYPE);
  if (pageType === PAGE_TYPE_FREE) {
    return { pageType: PAGE_TYPE_FREE, cellCount: 0, usedBytes: 16, freeBytes: 4080, usagePercent: 1 };
  }

  if (pageType === PAGE_TYPE_CATALOG_PAGE) {
    const colCount = v.getUint16(2, true);
    const usedBytes = 16 + colCount * 72;
    const freeBytes = Math.max(0, 4096 - usedBytes);
    const usagePercent = Math.min(100, Math.max(0, Math.round((usedBytes / 4096) * 100)));
    return { pageType, cellCount: colCount, usedBytes, freeBytes, usagePercent };
  }

  const cellCount = v.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true);
  const contentOffset = v.getUint16(PAGE_HEADER_OFFSET_CONTENT_OFFSET, true);
  const slotDirEnd = 16 + cellCount * 2;
  const safeContentOffset = Math.min(4096, Math.max(contentOffset, slotDirEnd));
  const payloadSize = Math.max(0, 4096 - safeContentOffset);
  const usedBytes = 16 + cellCount * 2 + payloadSize;
  const freeBytes = Math.max(0, 4096 - usedBytes);
  const usagePercent = Math.min(100, Math.max(0, Math.round((usedBytes / 4096) * 100)));

  return { pageType, cellCount, usedBytes, freeBytes, usagePercent };
}

/**
 * Discovers all accessible database pages by scanning Page 1, table descriptors, and pointer chains
 */
export async function discoverDatabasePages(db: any, tables: TableMeta[]): Promise<DiscoveredPage[]> {
  const result: DiscoveredPage[] = [];
  if (!db) return result;

  const page1Bytes = await readPageBytes(db, 1);
  let totalPages = 1;
  let freePageHead = 0;

  if (page1Bytes && page1Bytes.byteLength >= 100) {
    const view = new DataView(page1Bytes.buffer, page1Bytes.byteOffset, page1Bytes.byteLength);
    totalPages = view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true) || 1;
    freePageHead = view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
  }

  const p1Stats = computePageStats(page1Bytes, 1);

  // Page 1 is always the System Catalog
  result.push({
    pageId: 1,
    label: `Page 1 • System Catalog`,
    role: 'system',
    pageType: -1,
    cellCount: p1Stats.cellCount,
    usedBytes: p1Stats.usedBytes,
    freeBytes: p1Stats.freeBytes,
    usagePercent: p1Stats.usagePercent,
  });

  const visited = new Set<number>([1]);

  // Map known tables and follow page chains (BFS queue for interior and leaf nodes)
  for (const tbl of tables) {
    if (tbl.rootPageId > 1 && !visited.has(tbl.rootPageId)) {
      const queue = [tbl.rootPageId];
      let isFirst = true;

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);

        const curBytes = await readPageBytes(db, cur);
        if (!curBytes || curBytes.byteLength < 16) continue;
        const curStats = computePageStats(curBytes, cur);
        const v = new DataView(curBytes.buffer, curBytes.byteOffset, curBytes.byteLength);

        let role: DiscoveredPage['role'] = isFirst ? 'root' : 'leaf';
        if (curStats.pageType === PAGE_TYPE_TABLE_INTERIOR) {
          role = isFirst ? 'root' : 'interior';
          // Queue routing cell children
          const cellCount = curStats.cellCount || v.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true);
          for (let i = 0; i < cellCount; i++) {
            const off = v.getUint16(16 + i * 2, true);
            if (off > 0 && off + 4 <= PAGE_SIZE) {
              const childId = v.getUint32(off, true);
              if (childId > 1 && !visited.has(childId)) {
                queue.push(childId);
              }
            }
          }
          // Queue rightmost child
          const rightChildId = v.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
          if (rightChildId > 1 && !visited.has(rightChildId)) {
            queue.push(rightChildId);
          }
        } else if (curStats.pageType === PAGE_TYPE_LEAF_DATA) {
          role = isFirst ? 'root' : 'leaf';
          // Queue next sibling leaf in scan chain
          const nextId = v.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
          if (nextId > 1 && !visited.has(nextId) && nextId <= Math.max(totalPages, 500)) {
            queue.push(nextId);
          }
        }

        const roleLabel = role === 'root' ? 'Root' : role === 'interior' ? 'Interior' : 'Leaf';
        result.push({
          pageId: cur,
          label: `Page ${cur} • ${tbl.name} [${roleLabel}]`,
          tableName: tbl.name,
          role,
          pageType: curStats.pageType,
          cellCount: curStats.cellCount,
          usedBytes: curStats.usedBytes,
          freeBytes: curStats.freeBytes,
          usagePercent: curStats.usagePercent,
        });

        isFirst = false;
      }
    }

    if (
      tbl.colCatalogPageId > 1 &&
      tbl.colCatalogPageId !== tbl.rootPageId &&
      !visited.has(tbl.colCatalogPageId)
    ) {
      visited.add(tbl.colCatalogPageId);
      const catBytes = await readPageBytes(db, tbl.colCatalogPageId);
      const catStats = computePageStats(catBytes, tbl.colCatalogPageId);

      result.push({
        pageId: tbl.colCatalogPageId,
        label: `Page ${tbl.colCatalogPageId} • ${tbl.name} [Column Catalog]`,
        tableName: tbl.name,
        role: 'catalog',
        pageType: catStats.pageType,
        cellCount: catStats.cellCount,
        usedBytes: catStats.usedBytes,
        freeBytes: catStats.freeBytes,
        usagePercent: catStats.usagePercent,
      });
    }
  }

  // Follow free page list if any
  let freeCur = freePageHead;
  while (freeCur > 0 && freeCur <= Math.max(totalPages, 500) && !visited.has(freeCur)) {
    visited.add(freeCur);
    const fb = await readPageBytes(db, freeCur);
    const freeStats = computePageStats(fb, freeCur);

    result.push({
      pageId: freeCur,
      label: `Page ${freeCur} • Free Page`,
      role: 'free',
      pageType: PAGE_TYPE_FREE,
      cellCount: freeStats.cellCount,
      usedBytes: freeStats.usedBytes,
      freeBytes: freeStats.freeBytes,
      usagePercent: freeStats.usagePercent,
    });
    if (!fb || fb.byteLength < 16) break;
    const fv = new DataView(fb.buffer, fb.byteOffset, fb.byteLength);
    freeCur = fv.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
  }

  // Fill in any other allocated pages up to totalPages
  for (let p = 2; p <= totalPages; p++) {
    if (!visited.has(p)) {
      visited.add(p);
      const pb = await readPageBytes(db, p);
      const pStats = computePageStats(pb, p);
      let role: DiscoveredPage['role'] = 'unknown';
      let matchedTableName: string | undefined;

      if (pStats.pageType === PAGE_TYPE_LEAF_DATA) {
        role = 'leaf';
        // Try matching table via row deserialization
        if (pb && pb.byteLength === PAGE_SIZE && tables.length > 0) {
          const pv = new DataView(pb.buffer, pb.byteOffset, pb.byteLength);
          const cellCount = pv.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true);
          if (cellCount > 0) {
            const firstOff = pv.getUint16(16, true);
            if (firstOff >= 16 && firstOff < PAGE_SIZE) {
              for (const tbl of tables) {
                if (tbl.columns && tbl.columns.length > 0) {
                  try {
                    const colMetas = tbl.columns.map((c, cIdx) => ({
                      name: c.name,
                      type: typeof c.type === 'number' ? c.type : 4,
                      flags: typeof c.flags === 'number' ? c.flags : 0,
                      columnIndex: cIdx,
                    }));
                    const row = page_deserialize_row(colMetas as any, pv, firstOff);
                    if (row && typeof row === 'object' && Object.keys(row).length > 0) {
                      matchedTableName = tbl.name;
                      break;
                    }
                  } catch {}
                }
              }
            }
          }
        }
      } else if (pStats.pageType === PAGE_TYPE_TABLE_INTERIOR) {
        role = 'interior';
      } else if (pStats.pageType === PAGE_TYPE_CATALOG_PAGE) {
        role = 'catalog';
      } else if (pStats.pageType === PAGE_TYPE_INDEX_LEAF || pStats.pageType === PAGE_TYPE_INDEX_INTERIOR) {
        role = 'index';
      } else if (pStats.pageType === PAGE_TYPE_FREE) {
        role = 'free';
      }

      const typeName = PAGE_TYPE_NAMES[pStats.pageType] || `Type 0x${pStats.pageType.toString(16)}`;
      const label = matchedTableName ? `Page ${p} • ${matchedTableName} [Leaf]` : `Page ${p} • ${typeName}`;
      result.push({
        pageId: p,
        label,
        tableName: matchedTableName,
        role,
        pageType: pStats.pageType,
        cellCount: pStats.cellCount,
        usedBytes: pStats.usedBytes,
        freeBytes: pStats.freeBytes,
        usagePercent: pStats.usagePercent,
      });
    }
  }

  result.sort((a, b) => a.pageId - b.pageId);
  return result;
}

/**
 * Computes exact byte ranges for each column in a serialized row
 */
export function computeRowColumnByteRanges(
  view: DataView,
  recordOffset: number,
  columns: TableColumnMeta[]
): Record<string, ColumnByteRange> {
  const result: Record<string, ColumnByteRange> = {};
  if (!columns || columns.length === 0 || recordOffset + 3 > view.byteLength) return result;

  const colCount = columns.length;
  const nullBitmapBytes = Math.ceil(colCount / 8);

  if (recordOffset + 3 + nullBitmapBytes > view.byteLength) return result;

  // Read null bits
  const nullBits: boolean[] = [];
  for (let i = 0; i < colCount; i++) {
    const byteIdx = recordOffset + 3 + (i >> 3);
    const bitMask = 1 << (i & 7);
    const isNull = (view.getUint8(byteIdx) & bitMask) !== 0;
    nullBits.push(isNull);
  }

  // Calculate fixed offsets
  let curFixedOffset = recordOffset + 3 + nullBitmapBytes;
  const varCols: Array<{ index: number; col: TableColumnMeta }> = [];

  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    const typeNum = typeof col.type === 'number' ? col.type : 4;
    const isNull = nullBits[i];

    if (typeNum === 4 || typeNum === 5) {
      // TEXT or BLOB
      varCols.push({ index: i, col });
    } else {
      let size = 0;
      if (typeNum === 1) size = 4; // INT32
      else if (typeNum === 2 || typeNum === 3) size = 8; // INT64, FLOAT64
      else if (typeNum === 6 || typeNum === 7) size = 16; // UUID, ULID

      if (!isNull && curFixedOffset + size <= view.byteLength) {
        result[col.name] = {
          colName: col.name,
          start: curFixedOffset,
          end: curFixedOffset + size - 1,
          length: size,
          isNull: false,
        };
        curFixedOffset += size;
      } else {
        result[col.name] = {
          colName: col.name,
          start: curFixedOffset,
          end: curFixedOffset,
          length: 0,
          isNull: true,
        };
      }
    }
  }

  // Process var-offset table and payloads
  let curVarTableOffset = curFixedOffset;
  for (let v = 0; v < varCols.length; v++) {
    const { col, index } = varCols[v];
    const isNull = nullBits[index];
    if (isNull || curVarTableOffset + 4 > view.byteLength) {
      result[col.name] = {
        colName: col.name,
        start: curVarTableOffset,
        end: curVarTableOffset,
        length: 0,
        isNull: true,
      };
    } else {
      const relOffset = view.getUint16(curVarTableOffset, true);
      const len = view.getUint16(curVarTableOffset + 2, true);
      const payloadStart = recordOffset + relOffset;
      const payloadEnd = payloadStart + len - 1;

      if (len > 0 && payloadEnd < view.byteLength) {
        result[col.name] = {
          colName: col.name,
          start: payloadStart,
          end: payloadEnd,
          length: len,
          isNull: false,
        };
      } else {
        result[col.name] = {
          colName: col.name,
          start: payloadStart,
          end: payloadStart,
          length: 0,
          isNull: len === 0,
        };
      }
    }
    curVarTableOffset += 4;
  }

  return result;
}

/**
 * Builds the hierarchical B-tree and database structure of pages
 */
export async function buildBTreeHierarchy(
  db: any,
  tables: TableMeta[],
  discoveredPages: DiscoveredPage[]
): Promise<BTreeNode> {
  const pageMap = new Map<number, DiscoveredPage>();
  for (const p of discoveredPages) {
    pageMap.set(p.pageId, p);
  }

  const rootNode: BTreeNode = {
    pageId: 1,
    label: 'Database System Catalog',
    role: 'system',
    pageType: -1,
    pageTypeName: 'System Page & Catalog',
    cellCount: tables.length,
    children: [],
  };

  for (const tbl of tables) {
    const rootPageInfo = pageMap.get(tbl.rootPageId);
    const rootBytes = await readPageBytes(db, tbl.rootPageId);
    let rType = PAGE_TYPE_LEAF_DATA;
    let rv: DataView | null = null;

    if (rootBytes && rootBytes.byteLength >= 16) {
      rv = new DataView(rootBytes.buffer, rootBytes.byteOffset, rootBytes.byteLength);
      rType = rv.getUint8(PAGE_HEADER_OFFSET_TYPE);
    }

    if (rType === PAGE_TYPE_TABLE_INTERIOR && rv) {
      // Table Interior Root Node with Routing Branches
      const cellCount = rv.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true);
      const interiorNode: BTreeNode = {
        pageId: tbl.rootPageId,
        label: `${tbl.name} • Interior B-Tree Root`,
        tableName: tbl.name,
        role: 'interior_root',
        pageType: PAGE_TYPE_TABLE_INTERIOR,
        pageTypeName: 'Table Interior',
        cellCount,
        usagePercent: rootPageInfo?.usagePercent,
        children: [],
      };

      // Read routing cells
      for (let i = 0; i < cellCount; i++) {
        const off = rv.getUint16(16 + i * 2, true);
        if (off > 0 && off + 12 <= PAGE_SIZE) {
          const childId = rv.getUint32(off, true);
          const sepRowId = rv.getBigInt64(off + 4, true).toString();
          const childInfo = pageMap.get(childId);
          interiorNode.children.push({
            pageId: childId,
            label: `Page ${childId} • Leaf Data Branch`,
            tableName: tbl.name,
            role: 'leaf_child',
            pageType: childInfo?.pageType ?? PAGE_TYPE_LEAF_DATA,
            pageTypeName: PAGE_TYPE_NAMES[childInfo?.pageType ?? PAGE_TYPE_LEAF_DATA],
            cellCount: childInfo?.cellCount,
            usagePercent: childInfo?.usagePercent,
            keysSummary: `≤ RowID ${sepRowId}`,
            children: [],
          });
        }
      }

      // Right child
      const rightChildId = rv.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
      if (rightChildId > 0) {
        const rightInfo = pageMap.get(rightChildId);
        interiorNode.children.push({
          pageId: rightChildId,
          label: `Page ${rightChildId} • Rightmost Leaf Branch`,
          tableName: tbl.name,
          role: 'leaf_child',
          pageType: rightInfo?.pageType ?? PAGE_TYPE_LEAF_DATA,
          pageTypeName: PAGE_TYPE_NAMES[rightInfo?.pageType ?? PAGE_TYPE_LEAF_DATA],
          cellCount: rightInfo?.cellCount,
          usagePercent: rightInfo?.usagePercent,
          keysSummary: '> Highest Key',
          children: [],
        });
      }

      // Column Catalog Page
      if (tbl.colCatalogPageId > 1 && tbl.colCatalogPageId !== tbl.rootPageId) {
        const catInfo = pageMap.get(tbl.colCatalogPageId);
        interiorNode.children.push({
          pageId: tbl.colCatalogPageId,
          label: `Page ${tbl.colCatalogPageId} • Column Catalog`,
          tableName: tbl.name,
          role: 'catalog',
          pageType: PAGE_TYPE_CATALOG_PAGE,
          pageTypeName: 'Column Catalog',
          cellCount: tbl.columns?.length,
          usagePercent: catInfo?.usagePercent,
          children: [],
        });
      }

      rootNode.children.push(interiorNode);
    } else {
      // Table Leaf Root Node with Sibling Sequence
      const cellCount = rv ? rv.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true) : (rootPageInfo?.cellCount || tbl.rowCountEstimate);
      const leafRootNode: BTreeNode = {
        pageId: tbl.rootPageId,
        label: `${tbl.name} • Leaf Data Root`,
        tableName: tbl.name,
        role: 'leaf_root',
        pageType: PAGE_TYPE_LEAF_DATA,
        pageTypeName: 'Table Leaf Data',
        cellCount,
        usagePercent: rootPageInfo?.usagePercent,
        children: [],
      };

      // Follow sibling scan chain
      let curId = tbl.rootPageId;
      const visitedChain = new Set<number>([curId]);
      while (true) {
        const curBytes = await readPageBytes(db, curId);
        if (!curBytes || curBytes.byteLength < 16) break;
        const cv = new DataView(curBytes.buffer, curBytes.byteOffset, curBytes.byteLength);
        const nextId = cv.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);

        if (nextId > 0 && !visitedChain.has(nextId)) {
          visitedChain.add(nextId);
          const nextInfo = pageMap.get(nextId);
          leafRootNode.children.push({
            pageId: nextId,
            label: `Page ${nextId} • Linked Sibling Leaf`,
            tableName: tbl.name,
            role: 'leaf_sibling',
            pageType: nextInfo?.pageType ?? PAGE_TYPE_LEAF_DATA,
            pageTypeName: 'Table Leaf Data',
            cellCount: nextInfo?.cellCount,
            usagePercent: nextInfo?.usagePercent,
            isSiblingChain: true,
            children: [],
          });
          curId = nextId;
        } else {
          break;
        }
      }

      // Column Catalog Page
      if (tbl.colCatalogPageId > 1 && tbl.colCatalogPageId !== tbl.rootPageId) {
        const catInfo = pageMap.get(tbl.colCatalogPageId);
        leafRootNode.children.push({
          pageId: tbl.colCatalogPageId,
          label: `Page ${tbl.colCatalogPageId} • Column Catalog`,
          tableName: tbl.name,
          role: 'catalog',
          pageType: PAGE_TYPE_CATALOG_PAGE,
          pageTypeName: 'Column Catalog',
          cellCount: tbl.columns?.length,
          usagePercent: catInfo?.usagePercent,
          children: [],
        });
      }

      rootNode.children.push(leafRootNode);
    }
  }

  // 3. Free Pages List
  const freePages = discoveredPages.filter((p) => p.role === 'free');
  if (freePages.length > 0) {
    const freeGroupNode: BTreeNode = {
      pageId: freePages[0].pageId,
      label: `Recycled Free Pages Chain (${freePages.length} pages)`,
      role: 'free_group',
      pageType: PAGE_TYPE_FREE,
      pageTypeName: 'Free Pages List',
      cellCount: freePages.length,
      children: freePages.map((fp) => ({
        pageId: fp.pageId,
        label: `Page ${fp.pageId} • Free / Recycled`,
        role: 'free',
        pageType: PAGE_TYPE_FREE,
        pageTypeName: 'Free Page',
        children: [],
      })),
    };
    rootNode.children.push(freeGroupNode);
  }

  return rootNode;
}

/**
 * Parses a 4KB page and calculates its slotted memory distribution, cells, or column catalog descriptors
 */
export async function parsePage(
  db: any,
  pageId: number,
  tables: TableMeta[],
  discoveredPages?: DiscoveredPage[],
): Promise<ParsedPage | null> {
  const bytes = await readPageBytes(db, pageId);
  if (!bytes || bytes.byteLength !== PAGE_SIZE) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // --- PAGE 1: SYSTEM PAGE ---
  if (pageId === 1) {
    const magicDecoder = new TextDecoder();
    const magic = magicDecoder.decode(bytes.subarray(0, 5));
    const pageSize = view.getUint16(HEADER_OFFSET_PAGE_SIZE, true);
    const fileFormatVersion = view.getUint16(HEADER_OFFSET_FILE_FORMAT_VERSION, true);
    const minReadVersion = view.getUint16(HEADER_OFFSET_MIN_READ_VERSION, true);
    const totalPages = view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
    const freePageHead = view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
    const schemaVersion = view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
    const changeCounter = view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
    const storedChecksum = view.getUint32(HEADER_OFFSET_PAGE_CHECKSUM, true);

    // Read Master Table Descriptors (16 x 128B)
    const tableDescs: SysPageTableDesc[] = [];
    const textDecoder = new TextDecoder();
    for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
      const offset = MASTER_TABLE_OFFSET + i * TABLE_DESCRIPTOR_SIZE;
      const tableId = view.getUint16(offset, true);
      if (tableId === 0) continue;
      const columnCount = view.getUint16(offset + 2, true);
      const rootPageId = view.getUint32(offset + 4, true);
      const colCatalogPageId = view.getUint32(offset + 8, true);

      let nameEnd = 0;
      while (nameEnd < 64 && bytes[offset + 12 + nameEnd] !== 0) {
        nameEnd++;
      }
      const name = textDecoder.decode(bytes.subarray(offset + 12, offset + 12 + nameEnd));
      const flags = view.getUint32(offset + 76, true);
      const rowCountEstimate = view.getUint32(offset + 80, true);
      const autoIncNext = Number(view.getBigUint64(offset + 84, true));

      tableDescs.push({
        tableId,
        columnCount,
        rootPageId,
        colCatalogPageId,
        name,
        flags,
        rowCountEstimate,
        autoIncNext,
      });
    }

    // Read Index Descriptors (8 x 128B)
    const indexDescs: SysPageIndexDesc[] = [];
    for (let i = 0; i < MAX_INDEXES_PAGE1; i++) {
      const offset = INDEX_CATALOG_OFFSET + i * INDEX_DESCRIPTOR_SIZE;
      const indexId = view.getUint16(offset, true);
      if (indexId === 0) continue;
      const tableId = view.getUint16(offset + 2, true);
      const rootPageId = view.getUint32(offset + 4, true);
      let nameEnd = 0;
      while (nameEnd < 64 && bytes[offset + 8 + nameEnd] !== 0) {
        nameEnd++;
      }
      const name = textDecoder.decode(bytes.subarray(offset + 8, offset + 8 + nameEnd));
      const indexedColCount = view.getUint16(offset + 72, true);

      indexDescs.push({
        indexId,
        tableId,
        rootPageId,
        name,
        indexedColCount,
      });
    }

    const segments: MemorySegment[] = [
      {
        name: 'Database Header (100B)',
        start: 0,
        end: 99,
        size: 100,
        color: '#8b5cf6', // purple
        category: 'header',
      },
      {
        name: 'Master Table Catalog (16 × 128B = 2,048B)',
        start: 100,
        end: 2147,
        size: 2048,
        color: '#06b6d4', // cyan
        category: 'slot_dir',
      },
      {
        name: 'Index Catalog (8 × 128B = 1,024B)',
        start: 2148,
        end: 3171,
        size: 1024,
        color: '#3b82f6', // blue
        category: 'slot_dir',
      },
      {
        name: 'SysPage Reserved Area (924B)',
        start: 3172,
        end: 4095,
        size: 924,
        color: '#64748b', // slate
        category: 'reserved',
      },
    ];

    return {
      pageId: 1,
      bytes,
      isPage1: true,
      header: {
        pageTypeName: 'System Page & Catalog',
        magic,
        pageSize,
        fileFormatVersion,
        minReadVersion,
        totalPages,
        freePageHead,
        schemaVersion,
        changeCounter,
        checksum: storedChecksum,
        tables: tableDescs,
        indexes: indexDescs,
      },
      slotOffsets: [],
      memoryDistribution: {
        segments,
        headerBytes: 100,
        slotDirBytes: 3072,
        freeBytes: 924,
        payloadBytes: 0,
        fragmentedBytes: 0,
      },
      cells: [],
    };
  }

  // --- PAGES 2+: SLOTTED DATA, CATALOG & INTERIOR PAGES ---
  const pageType = view.getUint8(PAGE_HEADER_OFFSET_TYPE);
  const flags = view.getUint8(PAGE_HEADER_OFFSET_FLAGS);
  const pageTypeName = PAGE_TYPE_NAMES[pageType] || `Unknown (0x${pageType.toString(16)})`;

  // Ensure tables list is available
  let activeTables = tables;
  if ((!activeTables || activeTables.length === 0) && db && typeof db.listTables === 'function') {
    try {
      activeTables = await db.listTables();
    } catch {
      // fallback
    }
  }

  // Find associated table
  let associatedTable: TableMeta | undefined;

  // 1. Direct match on rootPageId or colCatalogPageId
  for (const tbl of activeTables) {
    if (tbl.rootPageId === pageId || tbl.colCatalogPageId === pageId) {
      associatedTable = tbl;
      break;
    }
  }

  // 2. Lookup via discoveredPages mapping
  if (!associatedTable && discoveredPages && discoveredPages.length > 0) {
    const pageEntry = discoveredPages.find((p) => p.pageId === pageId);
    if (pageEntry?.tableName) {
      associatedTable = activeTables.find((t) => t.name.toLowerCase() === pageEntry.tableName!.toLowerCase());
    }
  }

  // 3. Scan table page chains (sibling leaf chain or interior child pointers)
  if (!associatedTable && activeTables.length > 0) {
    for (const tbl of activeTables) {
      let cur = tbl.rootPageId;
      const visited = new Set<number>();
      while (cur > 0 && !visited.has(cur) && visited.size < 500) {
        visited.add(cur);
        if (cur === pageId) {
          associatedTable = tbl;
          break;
        }
        const b = await readPageBytes(db, cur);
        if (!b || b.byteLength < 16) break;
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const pType = v.getUint8(PAGE_HEADER_OFFSET_TYPE);

        if (pType === PAGE_TYPE_TABLE_INTERIOR) {
          const count = v.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true);
          for (let i = 0; i < count; i++) {
            const off = v.getUint16(16 + i * 2, true);
            if (off > 0 && off + 4 <= PAGE_SIZE) {
              const childId = v.getUint32(off, true);
              if (childId === pageId) {
                associatedTable = tbl;
                break;
              }
            }
          }
          const rightChild = v.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
          if (rightChild === pageId) {
            associatedTable = tbl;
            break;
          }
        }
        const next = v.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
        cur = next;
      }
      if (associatedTable) break;
    }
  }

  // 4. Default to single user table if page is Table Leaf Data
  if (!associatedTable && pageType === PAGE_TYPE_LEAF_DATA && activeTables.length === 1) {
    associatedTable = activeTables[0];
  }

  // 5. Ensure columns are loaded on the associated table
  if (
    associatedTable &&
    (!associatedTable.columns || associatedTable.columns.length === 0) &&
    db &&
    typeof db.getTable === 'function'
  ) {
    try {
      const fullTbl = await db.getTable(associatedTable.name);
      if (fullTbl && fullTbl.columns?.length) {
        associatedTable = fullTbl;
      }
    } catch {
      // fallback
    }
  }

  // === SPECIAL CASE: COLUMN CATALOG PAGE (0x0C) ===
  if (pageType === PAGE_TYPE_CATALOG_PAGE) {
    const colCountInPage = view.getUint16(2, true);
    const tableId = view.getUint16(4, true);
    const startColIndex = view.getUint16(6, true);
    const nextColCatalogPageId = view.getUint32(8, true);
    const checksum = view.getUint32(12, true);

    const columnCatalogDescriptors: ColumnCatalogDescriptor[] = [];
    const textDecoder = new TextDecoder();

    for (let i = 0; i < colCountInPage; i++) {
      const rawOffset = 16 + i * 72;
      if (rawOffset + 72 <= PAGE_SIZE) {
        const type = view.getUint8(rawOffset);
        const colFlags = view.getUint8(rawOffset + 1);
        const colOffset = view.getUint16(rawOffset + 2, true);

        let nameEnd = 0;
        while (nameEnd < 64 && bytes[rawOffset + 4 + nameEnd] !== 0) {
          nameEnd++;
        }
        const name = textDecoder.decode(bytes.subarray(rawOffset + 4, rawOffset + 4 + nameEnd));

        const isPrimaryKey = (colFlags & 0x01) !== 0;
        const isNotNull = (colFlags & 0x02) !== 0;
        const isAutoInc = (colFlags & 0x08) !== 0;

        columnCatalogDescriptors.push({
          columnIndex: startColIndex + i,
          colId: i + 1,
          name,
          type,
          typeName: DATA_TYPE_NAMES[type] || `TYPE_${type}`,
          flags: colFlags,
          isPrimaryKey,
          isNotNull,
          isAutoInc,
          colOffset,
          rawOffset,
          rawBytesHex: formatBytesHex(bytes.subarray(rawOffset, rawOffset + 72)),
        });
      }
    }

    const colAreaSize = colCountInPage * 72;
    const freeSpace = Math.max(0, PAGE_SIZE - (16 + colAreaSize));

    const segments: MemorySegment[] = [
      {
        name: 'Catalog Page Header (16B)',
        start: 0,
        end: 15,
        size: 16,
        color: '#8b5cf6',
        category: 'header',
      },
    ];

    if (colAreaSize > 0) {
      segments.push({
        name: `Column Descriptors (${colCountInPage} × 72B = ${colAreaSize}B)`,
        start: 16,
        end: 16 + colAreaSize - 1,
        size: colAreaSize,
        color: '#06b6d4',
        category: 'slot_dir',
      });
    }

    if (freeSpace > 0) {
      segments.push({
        name: `Free Catalog Space (${freeSpace}B)`,
        start: 16 + colAreaSize,
        end: PAGE_SIZE - 1,
        size: freeSpace,
        color: 'var(--card-border)',
        category: 'free',
      });
    }

    return {
      pageId,
      bytes,
      isPage1: false,
      header: {
        pageType,
        pageTypeName,
        flags,
        cellCount: colCountInPage,
        contentOffset: 16 + colAreaSize,
        nextPageId: nextColCatalogPageId,
        freeBytes: freeSpace,
        checksum,
        colCountInPage,
        tableId,
        startColIndex,
        nextColCatalogPageId,
      },
      slotOffsets: [],
      memoryDistribution: {
        segments,
        headerBytes: 16,
        slotDirBytes: colAreaSize,
        freeBytes: freeSpace,
        payloadBytes: 0,
        fragmentedBytes: 0,
      },
      cells: [],
      columnCatalogDescriptors,
      associatedTable,
    };
  }

  // === STANDARD SLOTTED DATA OR INTERIOR PAGE (0x0D, 0x05, etc.) ===
  const cellCount = view.getUint16(PAGE_HEADER_OFFSET_CELL_COUNT, true);
  const contentOffset = view.getUint16(PAGE_HEADER_OFFSET_CONTENT_OFFSET, true);
  const nextPageId = view.getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
  const freeBytes = view.getUint16(PAGE_HEADER_OFFSET_FREE_BYTES, true);
  const checksum = view.getUint32(PAGE_HEADER_OFFSET_CHECKSUM, true);

  // Read Slot Directory
  const slotOffsets: number[] = [];
  const slotDirEnd = PAGE_HEADER_SIZE + cellCount * 2;
  for (let i = 0; i < cellCount; i++) {
    const slotPos = PAGE_HEADER_SIZE + i * 2;
    if (slotPos + 2 <= PAGE_SIZE) {
      const cellOff = view.getUint16(slotPos, true);
      slotOffsets.push(cellOff);
    }
  }

  // Decode Cells
  const cells: DecodedCell[] = [];
  for (let i = 0; i < slotOffsets.length; i++) {
    const off = slotOffsets[i];
    if (off < 0 || off >= PAGE_SIZE) {
      cells.push({
        cellIndex: i,
        offset: off,
        length: 0,
        error: `Invalid cell pointer offset: ${off}`,
      });
      continue;
    }

    if (pageType === PAGE_TYPE_LEAF_DATA) {
      let rowLen = 0;
      if (off + 3 <= PAGE_SIZE) {
        rowLen = view.getUint16(off + 1, true);
      }
      if (rowLen === 0 || off + rowLen > PAGE_SIZE) {
        const nextLowest = slotOffsets.filter((o) => o > off).sort((a, b) => a - b)[0] || PAGE_SIZE;
        rowLen = Math.max(0, nextLowest - off);
      }

      let rowData: any = undefined;
      let parseErr: string | undefined;
      let columnRanges: Record<string, ColumnByteRange> | undefined;

      if (associatedTable && associatedTable.columns && associatedTable.columns.length > 0) {
        try {
          const colMetas = associatedTable.columns.map((c, cIdx) => ({
            name: c.name,
            type: typeof c.type === 'number' ? c.type : 4,
            flags: typeof c.flags === 'number' ? c.flags : 0,
            columnIndex: cIdx,
          }));
          rowData = page_deserialize_row(colMetas as any, view, off);
          columnRanges = computeRowColumnByteRanges(view, off, associatedTable.columns);
        } catch (e: any) {
          parseErr = e?.message || 'Deserialization error';
        }
      }

      cells.push({
        cellIndex: i,
        offset: off,
        length: rowLen,
        data: rowData,
        error: parseErr,
        columnRanges,
        rawHex: formatBytesHex(bytes.subarray(off, Math.min(off + 32, off + rowLen))),
      });
    } else if (pageType === PAGE_TYPE_TABLE_INTERIOR) {
      const childPageId = view.getUint32(off, true);
      const rowId = view.getBigInt64(off + 4, true).toString();
      cells.push({
        cellIndex: i,
        offset: off,
        length: 12,
        childPageId,
        separatorRowId: rowId,
      });
    } else {
      cells.push({
        cellIndex: i,
        offset: off,
        length: Math.max(0, PAGE_SIZE - off),
      });
    }
  }

  // Calculate Memory Distribution Segments
  const segments: MemorySegment[] = [];

  // 1. Header (0..15)
  segments.push({
    name: 'Slotted Page Header (16B)',
    start: 0,
    end: 15,
    size: 16,
    color: '#8b5cf6',
    category: 'header',
  });

  // 2. Slot Directory (16 .. slotDirEnd - 1)
  const slotDirSize = cellCount * 2;
  if (slotDirSize > 0) {
    segments.push({
      name: `Slot Directory (${cellCount} × 2B = ${slotDirSize}B)`,
      start: PAGE_HEADER_SIZE,
      end: slotDirEnd - 1,
      size: slotDirSize,
      color: '#06b6d4',
      category: 'slot_dir',
    });
  }

  // 3. Contiguous Free Space
  const safeContentOffset = Math.min(Math.max(contentOffset, slotDirEnd), PAGE_SIZE);
  const contiguousFree = Math.max(0, safeContentOffset - slotDirEnd);
  if (contiguousFree > 0) {
    segments.push({
      name: `Contiguous Free Space (${contiguousFree.toLocaleString()}B)`,
      start: slotDirEnd,
      end: safeContentOffset - 1,
      size: contiguousFree,
      color: 'var(--card-border)',
      category: 'free',
    });
  }

  // 4. Payloads
  const payloadSize = PAGE_SIZE - safeContentOffset;
  if (payloadSize > 0) {
    segments.push({
      name: `Cell Payloads (${payloadSize.toLocaleString()}B)`,
      start: safeContentOffset,
      end: PAGE_SIZE - 1,
      size: payloadSize,
      color: '#10b981',
      category: 'payload',
    });
  }

  return {
    pageId,
    bytes,
    isPage1: false,
    header: {
      pageType,
      pageTypeName,
      flags,
      cellCount,
      contentOffset,
      nextPageId,
      freeBytes,
      checksum,
    },
    slotOffsets,
    memoryDistribution: {
      segments,
      headerBytes: PAGE_HEADER_SIZE,
      slotDirBytes: slotDirSize,
      freeBytes: contiguousFree,
      payloadBytes: payloadSize,
      fragmentedBytes: freeBytes,
    },
    cells,
    associatedTable,
  };
}

function formatBytesHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return hex.join(' ');
}

/**
 * Categorizes a specific byte offset for interactive hex highlighting
 */
export function getByteCategory(
  offset: number,
  parsed: ParsedPage,
  highlightedCell?: DecodedCell | null,
  highlightedColumnRange?: ColumnByteRange | null,
): { category: string; tooltip: string } {
  // 1. Column-specific highlight (highest precedence when hovering on a table cell)
  if (
    highlightedColumnRange &&
    highlightedColumnRange.length > 0 &&
    offset >= highlightedColumnRange.start &&
    offset <= highlightedColumnRange.end
  ) {
    return {
      category: 'column-highlight',
      tooltip: `Column '${highlightedColumnRange.colName}' (0x${highlightedColumnRange.start.toString(16).padStart(4, '0')}..0x${highlightedColumnRange.end.toString(16).padStart(4, '0')}, ${highlightedColumnRange.length}B)`,
    };
  }

  // 2. Full row / cell record highlight
  if (highlightedCell && offset >= highlightedCell.offset && offset < highlightedCell.offset + highlightedCell.length) {
    return {
      category: 'cell-highlight',
      tooltip: `Slot #${highlightedCell.cellIndex} (0x${highlightedCell.offset.toString(16).padStart(4, '0')}..0x${(highlightedCell.offset + highlightedCell.length - 1).toString(16).padStart(4, '0')}, ${highlightedCell.length}B)`,
    };
  }

  // 3. Page layout segments
  for (const seg of parsed.memoryDistribution.segments) {
    if (offset >= seg.start && offset <= seg.end) {
      return {
        category: seg.category,
        tooltip: `${seg.name} (0x${seg.start.toString(16).padStart(4, '0')}..0x${seg.end.toString(16).padStart(4, '0')})`,
      };
    }
  }

  return {
    category: 'unknown',
    tooltip: `Offset 0x${offset.toString(16).padStart(4, '0')}`,
  };
}
