import { TableMeta } from '../types/studio';
import {
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_FREE,
  PAGE_SIZE,
  page_deserialize_row,
} from '@webdb/core';
import { PAGE_TYPE_NAMES } from './pageInspector';

export interface PoolSlotInfo {
  slotIndex: number;
  offset: number;
  pageId: number; // 0 if unassigned / free
  isDirty: boolean;
  isPinned: boolean;
  pinCount: number;
  refBit: number; // 0 or 1 for CLOCK eviction policy
  dirtyGeneration: number;
  tableName?: string;
  pageType?: number;
  pageTypeName?: string;
  usagePercent?: number;
  usedBytes?: number;
  cellCount?: number;
  rawSnippetHex?: string;
}

export interface PoolStats {
  totalSlots: number;
  residentCount: number;
  freeSlotsCount: number;
  dirtyCount: number;
  pinnedCount: number;
  clockHand?: number;
  arenaUsedBytes: number;
  arenaMaxBytes: number;
  totalPoolMemoryBytes: number;
  dirtyPercent: number;
  residentPercent: number;
}

function formatBytesHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return hex.join(' ');
}

/**
 * Inspects all resident slots and metadata in the BufferPoolDriver
 */
export function inspectBufferPool(
  db: any,
  tables: TableMeta[] = [],
  pageToTableMap?: Map<number, string> | Record<number, string>,
): { stats: PoolStats; slots: PoolSlotInfo[] } {
  const driver = db?.driver || db?.pool;

  if (!driver || typeof driver.getAssignedPage !== 'function') {
    return {
      stats: {
        totalSlots: 0,
        residentCount: 0,
        freeSlotsCount: 0,
        dirtyCount: 0,
        pinnedCount: 0,
        clockHand: 0,
        arenaUsedBytes: 0,
        arenaMaxBytes: 0,
        totalPoolMemoryBytes: 0,
        dirtyPercent: 0,
        residentPercent: 0,
      },
      slots: [],
    };
  }

  const slotCount = driver.slotCount || 64;
  const slots: PoolSlotInfo[] = [];

  // =========================================================================
  // 1. Build Comprehensive Page-to-Table Association Map
  // =========================================================================
  const tableMap = new Map<number, string>();

  // Layer A: Precomputed mapping (e.g. from discoverDatabasePages)
  if (pageToTableMap) {
    if (pageToTableMap instanceof Map) {
      for (const [pId, name] of pageToTableMap.entries()) {
        if (name) tableMap.set(Number(pId), name);
      }
    } else {
      for (const [pId, name] of Object.entries(pageToTableMap)) {
        if (name) tableMap.set(Number(pId), String(name));
      }
    }
  }

  // Layer B: Known tables from studio context + direct Page 1 inspection
  interface CandidateTable {
    name: string;
    rootPageId: number;
    colCatalogPageId: number;
    columns?: any[];
  }
  const knownTables: CandidateTable[] = [];
  for (const t of tables) {
    knownTables.push({
      name: t.name,
      rootPageId: t.rootPageId,
      colCatalogPageId: t.colCatalogPageId,
      columns: t.columns,
    });
  }

  // Also read table descriptors directly from Slot 0 (which is permanently Page 1)
  try {
    const page1Bytes = driver.getPageBytesInSlot(0);
    if (page1Bytes && page1Bytes.byteLength >= 2148) {
      const p1View = new DataView(page1Bytes.buffer, page1Bytes.byteOffset, page1Bytes.byteLength);
      const textDecoder = new TextDecoder();
      for (let i = 0; i < 16; i++) {
        const off = 100 + i * 128;
        const tableId = p1View.getUint16(off, true);
        const flags = p1View.getUint32(off + 76, true);
        if (tableId > 0 && (flags & 1) !== 0) {
          const rootPageId = p1View.getUint32(off + 4, true);
          const colCatalogPageId = p1View.getUint32(off + 8, true);
          let endName = 0;
          while (endName < 64 && page1Bytes[off + 12 + endName] !== 0) endName++;
          const name = textDecoder.decode(page1Bytes.subarray(off + 12, off + 12 + endName)).trim();
          if (name && !knownTables.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
            knownTables.push({ name, rootPageId, colCatalogPageId });
          }
        }
      }
    }
  } catch (err) {
    // Ignore Page 1 read errors
  }

  // Seed tableMap with root and catalog pages
  for (const tbl of knownTables) {
    if (tbl.rootPageId > 1 && !tableMap.has(tbl.rootPageId)) {
      tableMap.set(tbl.rootPageId, tbl.name);
    }
    if (tbl.colCatalogPageId > 1 && !tableMap.has(tbl.colCatalogPageId)) {
      tableMap.set(tbl.colCatalogPageId, tbl.name);
    }
  }

  // Layer C: Iterative propagation over all resident slots in the buffer pool
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 12) {
    changed = false;
    iterations++;

    for (let slotIdx = 0; slotIdx < slotCount; slotIdx++) {
      const pId = driver.getAssignedPage(slotIdx);
      if (pId <= 1) continue;

      const slotBytes = driver.getPageBytesInSlot(slotIdx);
      if (!slotBytes || slotBytes.byteLength < 16) continue;
      const view = new DataView(slotBytes.buffer, slotBytes.byteOffset, slotBytes.byteLength);
      const pType = view.getUint8(0);

      const tblName = tableMap.get(pId);
      if (tblName) {
        // Forward propagate via next_page_id (leaf data or interior)
        if (pType === PAGE_TYPE_LEAF_DATA || pType === PAGE_TYPE_TABLE_INTERIOR) {
          const nextId = view.getUint32(8, true);
          if (nextId > 1 && !tableMap.has(nextId)) {
            tableMap.set(nextId, tblName);
            changed = true;
          }
        }

        // Forward propagate via routing cells (interior)
        if (pType === PAGE_TYPE_TABLE_INTERIOR) {
          const cellCount = view.getUint16(2, true);
          for (let i = 0; i < cellCount; i++) {
            const off = view.getUint16(16 + i * 2, true);
            if (off > 0 && off + 4 <= 4096) {
              const childId = view.getUint32(off, true);
              if (childId > 1 && !tableMap.has(childId)) {
                tableMap.set(childId, tblName);
                changed = true;
              }
            }
          }
          const rightChildId = view.getUint32(8, true);
          if (rightChildId > 1 && !tableMap.has(rightChildId)) {
            tableMap.set(rightChildId, tblName);
            changed = true;
          }
        }

        // Forward propagate via nextColCatalogPageId (catalog)
        if (pType === PAGE_TYPE_CATALOG_PAGE) {
          const nextCatId = view.getUint32(6, true);
          if (nextCatId > 1 && !tableMap.has(nextCatId)) {
            tableMap.set(nextCatId, tblName);
            changed = true;
          }
        }
      } else {
        // Backward check: Does another slot point to this pId?
        const nextId = view.getUint32(8, true);
        if (nextId > 1 && tableMap.has(nextId)) {
          tableMap.set(pId, tableMap.get(nextId)!);
          changed = true;
        }
      }
    }
  }

  // Layer D: Content-based row deserialization for any unassociated leaf pages
  for (let slotIdx = 0; slotIdx < slotCount; slotIdx++) {
    const pId = driver.getAssignedPage(slotIdx);
    if (pId <= 1 || tableMap.has(pId)) continue;

    const slotBytes = driver.getPageBytesInSlot(slotIdx);
    if (!slotBytes || slotBytes.byteLength < 16) continue;
    const view = new DataView(slotBytes.buffer, slotBytes.byteOffset, slotBytes.byteLength);
    const pType = view.getUint8(0);

    if (pType === PAGE_TYPE_LEAF_DATA) {
      if (knownTables.length === 1) {
        tableMap.set(pId, knownTables[0].name);
        continue;
      }

      const cellCount = view.getUint16(2, true);
      if (cellCount > 0) {
        const firstOff = view.getUint16(16, true);
        if (firstOff >= 16 && firstOff < 4096) {
          for (const tbl of knownTables) {
            if (tbl.columns && tbl.columns.length > 0) {
              try {
                const colMetas = tbl.columns.map((c: any, cIdx: number) => ({
                  name: c.name,
                  type: typeof c.type === 'number' ? c.type : 4,
                  flags: typeof c.flags === 'number' ? c.flags : 0,
                  columnIndex: cIdx,
                }));
                const row = page_deserialize_row(colMetas as any, view, firstOff);
                if (row && typeof row === 'object' && Object.keys(row).length > 0) {
                  tableMap.set(pId, tbl.name);
                  break;
                }
              } catch {
                // Not this table
              }
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // 2. Iterate Slots and Build Detailed PoolSlotInfo Array
  // =========================================================================
  let residentCount = 0;
  let dirtyCount = 0;
  let pinnedCount = 0;

  for (let slotIdx = 0; slotIdx < slotCount; slotIdx++) {
    const pageId = driver.getAssignedPage(slotIdx);
    const isDirty = driver.isDirty(slotIdx);
    const isPinned = driver.isSlotPinned(slotIdx);
    const pinCount = driver.getPinCount(slotIdx);
    const refBit = driver.getRefBit(slotIdx);
    const dirtyGeneration = driver.slot_dirty_generations ? driver.slot_dirty_generations[slotIdx] : 0;
    const offset = driver.getSlotOffset(slotIdx);

    if (isDirty) dirtyCount++;
    if (isPinned) pinnedCount++;

    let tableName: string | undefined;
    let pageType: number | undefined;
    let pageTypeName = 'Unassigned Slot';
    let usagePercent = 0;
    let usedBytes = 0;
    let cellCount = 0;
    let rawSnippetHex = '';

    if (pageId > 0) {
      residentCount++;
      const slotBytes = driver.getPageBytesInSlot(slotIdx);
      if (slotBytes && slotBytes.byteLength >= 16) {
        rawSnippetHex = formatBytesHex(slotBytes.subarray(0, 16));
        const view = new DataView(slotBytes.buffer, slotBytes.byteOffset, slotBytes.byteLength);

        if (pageId === 1) {
          pageType = -1;
          pageTypeName = 'System Page (0x01)';
          tableName = 'System Catalog';
          usedBytes = 100 + 2048 + 1024;
          usagePercent = Math.round((usedBytes / 4096) * 100);
          cellCount = knownTables.length;
        } else {
          pageType = view.getUint8(0);
          pageTypeName = PAGE_TYPE_NAMES[pageType] || `Type 0x${pageType.toString(16)}`;

          // Lookup from our multi-layer tableMap
          tableName = tableMap.get(pageId);

          // Fallback if only 1 table exists
          if (!tableName && knownTables.length === 1 && pageType === PAGE_TYPE_LEAF_DATA) {
            tableName = knownTables[0].name;
          }

          if (pageType === PAGE_TYPE_CATALOG_PAGE) {
            cellCount = view.getUint16(2, true);
            usedBytes = 16 + cellCount * 72;
            usagePercent = Math.min(100, Math.round((usedBytes / 4096) * 100));
          } else if (pageType === PAGE_TYPE_LEAF_DATA || pageType === PAGE_TYPE_TABLE_INTERIOR) {
            cellCount = view.getUint16(2, true);
            const contentOffset = view.getUint16(4, true);
            const payloadSize = Math.max(0, 4096 - Math.max(contentOffset, 16 + cellCount * 2));
            usedBytes = 16 + cellCount * 2 + payloadSize;
            usagePercent = Math.min(100, Math.round((usedBytes / 4096) * 100));
          } else if (pageType === PAGE_TYPE_FREE) {
            usedBytes = 16;
            usagePercent = 1;
          }
        }
      }
    }

    slots.push({
      slotIndex: slotIdx,
      offset,
      pageId,
      isDirty,
      isPinned,
      pinCount,
      refBit,
      dirtyGeneration,
      tableName,
      pageType,
      pageTypeName,
      usagePercent,
      usedBytes,
      cellCount,
      rawSnippetHex,
    });
  }

  const freeSlotsCount = Math.max(0, slotCount - residentCount);
  const residentPercent = slotCount > 0 ? Math.round((residentCount / slotCount) * 100) : 0;
  const dirtyPercent = residentCount > 0 ? Math.round((dirtyCount / residentCount) * 100) : 0;
  const arenaUsedBytes = typeof driver.getArenaOffset === 'function' ? driver.getArenaOffset() : 0;
  const arenaMaxBytes = driver.maxQueryMemory || 262144;
  const totalPoolMemoryBytes = slotCount * 4096 + arenaMaxBytes;

  return {
    stats: {
      totalSlots: slotCount,
      residentCount,
      freeSlotsCount,
      dirtyCount,
      pinnedCount,
      clockHand: typeof driver.clock_hand === 'number' ? driver.clock_hand : 0,
      arenaUsedBytes,
      arenaMaxBytes,
      totalPoolMemoryBytes,
      dirtyPercent,
      residentPercent,
    },
    slots,
  };
}
