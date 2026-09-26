import {
  PAGE_SIZE,
  MAX_ROW_SIZE,
  PAGE_HEADER_SIZE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_TABLE_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_LEAF_DATA,
  TABLE_INTERIOR_CELL_SIZE,
  MAX_TABLE_INTERIOR_CELLS,
  TABLE_INTERIOR_SPLIT_INDEX,
  MAX_COLUMNS_PER_TABLE,
  PAGE_HEADER_OFFSET_CHECKSUM,
} from '../../constants.js';
import {
  DataType,
  ColumnFlag,
  ColumnMeta,
  TableMeta,
  DbRow,
  DbValue,
  RowSizeLimitExceededError,
  NotNullConstraintError,
  TooManyColumnsError,
} from '../../types/index.js';
import { UuidCodec, UlidCodec } from './codecs.c.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ============================================================================
// 1. Slotted Page Initialization & Header Accessors (16-Byte Header)
// ============================================================================

/**
 * Initializes a standard 16-byte header 4KB page.
 *
 * Header Layout:
 * [0]      uint8_t  page_type
 * [1]      uint8_t  reserved (0x00)
 * [2..3]   uint16_t cell_count (0)
 * [4..5]   uint16_t cell_content_offset (PAGE_SIZE = 4096)
 * [6..9]   uint32_t next_page_id / right_child_page_id / next_free_page_id (0)
 * [10..11] uint16_t free_bytes (0)
 * [12..15] uint32_t checksum (0)
 */

/**
 * @export_c
 * Initializes a 4KB slotted database page header.
 */
export function page_init(
  view: DataView,
  pageOffset: number,
  pageType: number = PAGE_TYPE_LEAF_DATA,
  nextPageId: number = 0
): void {
  view.setUint8(pageOffset + 0, pageType);
  view.setUint8(pageOffset + 1, 0);
  view.setUint16(pageOffset + 2, 0, true);
  view.setUint16(pageOffset + 4, PAGE_SIZE, true);
  view.setUint32(pageOffset + 6, nextPageId, true);
  view.setUint16(pageOffset + 10, 0, true);
  view.setUint32(pageOffset + PAGE_HEADER_OFFSET_CHECKSUM, 0, true);
}

/**
 * @export_c
 * Initializes a 4KB free-list page header.
 */
export function page_init_free(
  view: DataView,
  pageOffset: number,
  nextFreePageId: number = 0
): void {
  view.setUint8(pageOffset + 0, PAGE_TYPE_FREE);
  view.setUint8(pageOffset + 1, 0);
  view.setUint16(pageOffset + 2, 0, true);
  view.setUint16(pageOffset + 4, 0, true);
  view.setUint32(pageOffset + 6, nextFreePageId, true);
  view.setUint16(pageOffset + 10, 0, true);
  view.setUint32(pageOffset + PAGE_HEADER_OFFSET_CHECKSUM, 0, true);
}

/**
 * @export_c
 * Returns the page type byte from a page header.
 */
export function page_get_type(view: DataView, pageOffset: number): number {
  return view.getUint8(pageOffset + 0);
}

/**
 * @export_c
 * Sets the page type byte in a page header.
 */
export function page_set_type(view: DataView, pageOffset: number, type: number): void {
  view.setUint8(pageOffset + 0, type);
}

/**
 * @export_c
 * Returns the number of cells in the page slot directory.
 */
export function page_get_cell_count(view: DataView, pageOffset: number): number {
  return view.getUint16(pageOffset + 2, true);
}

/**
 * @export_c
 * Sets the number of cells in the page slot directory.
 */
export function page_set_cell_count(view: DataView, pageOffset: number, count: number): void {
  view.setUint16(pageOffset + 2, count, true);
}

/**
 * @export_c
 * Returns the byte offset within the page where active cell payloads begin.
 */
export function page_get_cell_content_offset(view: DataView, pageOffset: number): number {
  return view.getUint16(pageOffset + 4, true);
}

/**
 * @export_c
 * Sets the byte offset within the page where active cell payloads begin.
 */
export function page_set_cell_content_offset(view: DataView, pageOffset: number, offset: number): void {
  view.setUint16(pageOffset + 4, offset, true);
}

/**
 * @export_c
 * Returns the next page ID (or right child page ID) stored in the page header.
 */
export function page_get_next_page_id(view: DataView, pageOffset: number): number {
  return view.getUint32(pageOffset + 6, true);
}

/**
 * @export_c
 * Sets the next page ID (or right child page ID) stored in the page header.
 */
export function page_set_next_page_id(view: DataView, pageOffset: number, nextPageId: number): void {
  view.setUint32(pageOffset + 6, nextPageId, true);
}

/**
 * @export_c
 * Returns cumulative fragmented unallocated bytes in the page.
 */
export function page_get_free_bytes(view: DataView, pageOffset: number): number {
  return view.getUint16(pageOffset + 10, true);
}

/**
 * @export_c
 * Sets cumulative fragmented unallocated bytes in the page.
 */
export function page_set_free_bytes(view: DataView, pageOffset: number, freeBytes: number): void {
  view.setUint16(pageOffset + 10, freeBytes, true);
}

/**
 * @export_c
 * Returns the checksum stored at bytes 12..15 in the page header.
 */
export function page_get_checksum(view: DataView, pageOffset: number): number {
  return view.getUint32(pageOffset + PAGE_HEADER_OFFSET_CHECKSUM, true);
}

/**
 * @export_c
 * Sets the checksum stored at bytes 12..15 in the page header.
 */
export function page_set_checksum(view: DataView, pageOffset: number, checksum: number): void {
  view.setUint32(pageOffset + PAGE_HEADER_OFFSET_CHECKSUM, checksum, true);
}

/**
 * @export_c
 * Returns the cell payload offset for the given slot directory index.
 */
export function page_get_cell_offset(view: DataView, pageOffset: number, slotIdx: number): number {
  const slotDirOffset = pageOffset + PAGE_HEADER_SIZE + (slotIdx * 2);
  return view.getUint16(slotDirOffset, true);
}

/**
 * @export_c
 * Sets the cell payload offset for the given slot directory index.
 */
export function page_set_cell_offset(view: DataView, pageOffset: number, slotIdx: number, cellOffset: number): void {
  const slotDirOffset = pageOffset + PAGE_HEADER_SIZE + (slotIdx * 2);
  view.setUint16(slotDirOffset, cellOffset, true);
}

/**
 * @export_c
 * Returns contiguous free space between slot directory end and cell content offset.
 */
export function page_get_contiguous_free_space(view: DataView, pageOffset: number): number {
  const cellCount = page_get_cell_count(view, pageOffset);
  const cellContentOffset = page_get_cell_content_offset(view, pageOffset);
  const slotDirEnd = PAGE_HEADER_SIZE + (cellCount * 2);
  return cellContentOffset - slotDirEnd;
}

/**
 * @export_c
 * Returns total free space on the page (contiguous + fragmented free_bytes).
 */
export function page_get_total_free_space(view: DataView, pageOffset: number): number {
  return page_get_contiguous_free_space(view, pageOffset) + page_get_free_bytes(view, pageOffset);
}

// ============================================================================
// 2. In-Place Page Compaction / Defragmentation (Zero-Allocation via Scratchpad)
// ============================================================================

export interface ReplacementCell {
  cellIdx: number;
  rowBytes: Uint8Array;
}

/**
 * @export_c
 * Defragments a slotted data page using a 4KB staging scratchpad.
 * Collapses fragmented holes to the bottom, rewrites slot directory entries,
 * and sets free_bytes to 0. Optionally replaces a cell in-place during compaction.
 */
export function page_compact(
  view: DataView,
  pageOffset: number,
  scratchpadOffset?: number,
  replacement?: ReplacementCell
): void {
  const cellCount = page_get_cell_count(view, pageOffset);
  if (cellCount === 0) {
    page_set_cell_content_offset(view, pageOffset, PAGE_SIZE);
    page_set_free_bytes(view, pageOffset, 0);
    return;
  }

  const absPageStart = view.byteOffset + pageOffset;
  const uint8 = new Uint8Array(view.buffer);

  // Read all active cell offsets and their lengths
  interface CellInfo {
    slotIdx: number;
    offset: number;
    length: number;
    replacementBytes?: Uint8Array;
  }

  const cells: CellInfo[] = [];
  for (let i = 0; i < cellCount; i++) {
    if (replacement && i === replacement.cellIdx) {
      cells.push({
        slotIdx: i,
        offset: -1,
        length: replacement.rowBytes.byteLength,
        replacementBytes: replacement.rowBytes,
      });
    } else {
      const offset = page_get_cell_offset(view, pageOffset, i);
      const len = page_get_row_length(view, pageOffset + offset);
      cells.push({ slotIdx: i, offset, length: len });
    }
  }

  // Create staging scratchpad (either at designated scratchpad offset in ArrayBuffer or locally)
  let scratchOffset: number;
  let useLocalScratch = false;
  let localScratch: Uint8Array | null = null;

  if (scratchpadOffset !== undefined) {
    scratchOffset = scratchpadOffset;
  } else {
    // If not provided in standalone tests, use a local 4KB buffer
    useLocalScratch = true;
    localScratch = new Uint8Array(PAGE_SIZE);
    scratchOffset = 0;
  }

  const scratchView = useLocalScratch
    ? new DataView(localScratch!.buffer)
    : new DataView(view.buffer, scratchOffset, PAGE_SIZE);

  // Copy header (first 16 bytes)
  const headerBytes = new Uint8Array(view.buffer, absPageStart, PAGE_HEADER_SIZE);
  if (useLocalScratch) {
    localScratch!.set(headerBytes, 0);
  } else {
    uint8.set(headerBytes, scratchOffset);
  }

  // Pack active cells contiguously from byte 4096 upwards
  let currentOffset = PAGE_SIZE;
  for (let i = 0; i < cellCount; i++) {
    const cell = cells[i];
    currentOffset -= cell.length;

    // Copy cell payload into scratchpad
    if (cell.replacementBytes) {
      if (useLocalScratch) {
        localScratch!.set(cell.replacementBytes, currentOffset);
      } else {
        uint8.set(cell.replacementBytes, scratchOffset + currentOffset);
      }
    } else {
      const cellBytes = new Uint8Array(view.buffer, absPageStart + cell.offset, cell.length);
      if (useLocalScratch) {
        localScratch!.set(cellBytes, currentOffset);
      } else {
        uint8.set(cellBytes, scratchOffset + currentOffset);
      }
    }

    // Write new slot directory offset in scratchpad
    scratchView.setUint16(PAGE_HEADER_SIZE + (cell.slotIdx * 2), currentOffset, true);
  }

  // Update scratchpad header fields
  scratchView.setUint16(4, currentOffset, true); // cell_content_offset
  scratchView.setUint16(10, 0, true);            // free_bytes = 0

  // Copy compacted scratchpad back into target page slot
  if (useLocalScratch) {
    uint8.set(localScratch!, absPageStart);
  } else {
    uint8.copyWithin(absPageStart, scratchOffset, scratchOffset + PAGE_SIZE);
  }
}

/**
 * @export_c
 * Calculates row length in bytes from the serialized row at rowOffset.
 */
export function page_get_row_length(view: DataView, rowOffset: number): number {
  return view.getUint16(rowOffset + 1, true);
}

// ============================================================================
// 3. Row Insert, Delete, and Update Mechanics
// ============================================================================

/**
 * @export_c
 * Inserts a serialized row record into a slotted data page.
 * Returns the slot index (0-indexed) or -1 if the row cannot fit in this page.
 */
export function page_insert_row(
  view: DataView,
  pageOffset: number,
  rowBytes: Uint8Array,
  scratchpadOffset?: number
): number {
  const cellCount = page_get_cell_count(view, pageOffset);
  const cellContentOffset = page_get_cell_content_offset(view, pageOffset);
  const neededBytes = rowBytes.byteLength + 2; // payload + 2B slot directory entry

  const slotDirEnd = PAGE_HEADER_SIZE + (cellCount * 2);
  const contiguousFree = cellContentOffset - slotDirEnd;
  const totalFree = contiguousFree + page_get_free_bytes(view, pageOffset);

  if (neededBytes > totalFree) {
    return -1; // Cannot fit even after defragmentation
  }

  if (neededBytes > contiguousFree) {
    // In-place compaction collapses all fragmented holes
    page_compact(view, pageOffset, scratchpadOffset);
  }

  const currentContentOffset = page_get_cell_content_offset(view, pageOffset);
  const currentCellCount = page_get_cell_count(view, pageOffset);

  // Allocate payload from bottom up
  const newContentOffset = currentContentOffset - rowBytes.byteLength;
  const absTarget = view.byteOffset + pageOffset + newContentOffset;

  // Copy row bytes into page
  const uint8 = new Uint8Array(view.buffer);
  uint8.set(rowBytes, absTarget);

  // Write new slot directory entry
  page_set_cell_offset(view, pageOffset, currentCellCount, newContentOffset);

  // Update page header
  page_set_cell_count(view, pageOffset, currentCellCount + 1);
  page_set_cell_content_offset(view, pageOffset, newContentOffset);

  return currentCellCount;
}

/**
 * @export_c
 * Deletes a row from a slotted data page.
 * Shifts subsequent slot directory entries left by 2 bytes (memmove) and increments free_bytes.
 */
export function page_delete_row(
  view: DataView,
  pageOffset: number,
  cellIdx: number
): void {
  const cellCount = page_get_cell_count(view, pageOffset);
  if (cellIdx < 0 || cellIdx >= cellCount) {
    throw new Error(`Invalid cell index ${cellIdx} for deletion (cellCount=${cellCount})`);
  }

  const offset = page_get_cell_offset(view, pageOffset, cellIdx);
  const rowLen = page_get_row_length(view, pageOffset + offset);

  // Shift slot directory entries left by 2 bytes
  const uint8 = new Uint8Array(view.buffer);
  const absPageStart = view.byteOffset + pageOffset;
  const slotDirStart = absPageStart + PAGE_HEADER_SIZE;
  const src = slotDirStart + (cellIdx + 1) * 2;
  const dst = slotDirStart + cellIdx * 2;
  const shiftLength = (cellCount - 1 - cellIdx) * 2;

  if (shiftLength > 0) {
    uint8.copyWithin(dst, src, src + shiftLength);
  }

  // Update header
  page_set_cell_count(view, pageOffset, cellCount - 1);
  page_set_free_bytes(view, pageOffset, page_get_free_bytes(view, pageOffset) + rowLen);
}

/**
 * @export_c
 * Updates an existing row in a slotted data page following the 3 scenarios in §4.5.
 * Returns true if update succeeded on this page, or false if it exceeded page capacity (Scenario C).
 */
export function page_update_row(
  view: DataView,
  pageOffset: number,
  cellIdx: number,
  newRowBytes: Uint8Array,
  scratchpadOffset?: number
): boolean {
  const cellCount = page_get_cell_count(view, pageOffset);
  if (cellIdx < 0 || cellIdx >= cellCount) {
    throw new Error(`Invalid cell index ${cellIdx} for update`);
  }

  const oldOffset = page_get_cell_offset(view, pageOffset, cellIdx);
  const oldLen = page_get_row_length(view, pageOffset + oldOffset);
  const newLen = newRowBytes.byteLength;
  const uint8 = new Uint8Array(view.buffer);

  // Scenario A: Same-size or shrinking update
  if (newLen <= oldLen) {
    uint8.set(newRowBytes, view.byteOffset + pageOffset + oldOffset);
    if (newLen < oldLen) {
      page_set_free_bytes(view, pageOffset, page_get_free_bytes(view, pageOffset) + (oldLen - newLen));
    }
    return true;
  }

  // Scenario B: Expanding update fitting on current page
  const totalFree = page_get_total_free_space(view, pageOffset);
  const neededExtra = newLen - oldLen;

  if (totalFree >= neededExtra) {
    const contiguousFree = page_get_contiguous_free_space(view, pageOffset);
    if (contiguousFree < newLen) {
      // Compacting directly replaces the old record with the new record,
      // avoiding dead ghost copies and slot directory boundary overflows
      page_compact(view, pageOffset, scratchpadOffset, { cellIdx, rowBytes: newRowBytes });
      return true;
    }

    // Mark old record space as hole
    page_set_free_bytes(view, pageOffset, page_get_free_bytes(view, pageOffset) + oldLen);

    const contentOffset = page_get_cell_content_offset(view, pageOffset);
    const newContentOffset = contentOffset - newLen;
    uint8.set(newRowBytes, view.byteOffset + pageOffset + newContentOffset);

    // Update slot directory entry
    page_set_cell_offset(view, pageOffset, cellIdx, newContentOffset);
    page_set_cell_content_offset(view, pageOffset, newContentOffset);
    return true;
  }

  // Scenario C: Exceeding page capacity
  return false;
}

// ============================================================================
// 4. Row Record Serialization & Deserialization
// ============================================================================

/**
 * @export_c
 * Calculates null-bitmap bytes, fixed slice size, and variable column count for row layout.
 */
export function page_get_table_layout(tableOrColumns: TableMeta | ColumnMeta[]) {
  const columns = Array.isArray(tableOrColumns) ? tableOrColumns : (tableOrColumns as TableMeta).columns;
  const nullBitmapBytes = Math.ceil(columns.length / 8);
  let fixedSliceSize = 0;
  let varColCount = 0;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (c.type === DataType.INT32) fixedSliceSize += 4;
    else if (c.type === DataType.INT64 || c.type === DataType.FLOAT64) fixedSliceSize += 8;
    else if (c.type === DataType.UUID || c.type === DataType.ULID) fixedSliceSize += 16;
    else if (c.type === DataType.TEXT || c.type === DataType.BLOB) varColCount++;
  }
  return { nullBitmapBytes, fixedSliceSize, varColCount };
}

/**
 * @export_c
 * Serializes a user row into WebDB Phase 1 binary format:
 *
 * [0]: Flags (1B: 0x01 = Active)
 * [1..2]: Row Length (2B uint16 LE)
 * [3..(3 + nullBitmapBytes - 1)]: Null-Bitmap (ceil(N/8) bytes)
 * Followed by: Fixed Slice (INT32 4B, INT64 8B, FLOAT64 8B, UUID 16B, ULID 16B)
 * Followed by: Var-Offset Table (4B per TEXT/BLOB column: 2B rel_offset, 2B length)
 * Followed by: Var Payloads (raw UTF-8 string or binary bytes)
 *
 * Strict 2048-Byte boundary enforced.
 */
export function page_serialize_row(
  tableOrColumns: TableMeta | ColumnMeta[],
  values: Record<string, DbValue>
): Uint8Array {
  const columns = Array.isArray(tableOrColumns) ? tableOrColumns : (tableOrColumns as TableMeta).columns;
  const colCount = columns.length;
  if (colCount > MAX_COLUMNS_PER_TABLE) {
    throw new TooManyColumnsError(colCount, MAX_COLUMNS_PER_TABLE);
  }

  const nullBitmapBytes = Math.ceil(colCount / 8);
  const nullBitmap = new Uint8Array(nullBitmapBytes);

  // Validate NOT NULL constraints & compute null bits
  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    const val = values[col.name];
    const isNull = val === null || val === undefined;

    if (isNull) {
      if ((col.flags & ColumnFlag.NOT_NULL) !== 0) {
        throw new NotNullConstraintError(col.name);
      }
      const byteIdx = i >> 3;
      const bitMask = 1 << (i & 7);
      nullBitmap[byteIdx] |= bitMask;
    }
  }

  // Calculate fixed-width slice and var-length payloads
  let fixedSliceSize = 0;
  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    const isNull = (nullBitmap[i >> 3] & (1 << (i & 7))) !== 0;
    if (!isNull) {
      switch (col.type) {
        case DataType.INT32:
          fixedSliceSize += 4;
          break;
        case DataType.INT64:
        case DataType.FLOAT64:
          fixedSliceSize += 8;
          break;
        case DataType.UUID:
        case DataType.ULID:
          fixedSliceSize += 16;
          break;
      }
    }
  }

  // Variable columns offset table (4 bytes each)
  const varColumns: Array<{ colIdx: number; col: ColumnMeta; payload: Uint8Array | null }> = [];
  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
      const isNull = (nullBitmap[i >> 3] & (1 << (i & 7))) !== 0;
      if (isNull) {
        varColumns.push({ colIdx: i, col, payload: null });
      } else {
        const val = values[col.name];
        let bytes: Uint8Array;
        if (col.type === DataType.TEXT) {
          bytes = textEncoder.encode(String(val ?? ''));
        } else {
          bytes = val instanceof Uint8Array ? val : new Uint8Array(val as any);
        }
        varColumns.push({ colIdx: i, col, payload: bytes });
      }
    }
  }

  const varOffsetTableSize = varColumns.length * 4;
  const headerAndTablesSize = 3 + nullBitmapBytes + fixedSliceSize + varOffsetTableSize;

  let totalVarPayloadSize = 0;
  for (let i = 0; i < varColumns.length; i++) {
    const item = varColumns[i];
    if (item.payload) {
      totalVarPayloadSize += item.payload.byteLength;
    }
  }

  const totalRowSize = headerAndTablesSize + totalVarPayloadSize;
  if (totalRowSize > MAX_ROW_SIZE) {
    throw new RowSizeLimitExceededError(totalRowSize, MAX_ROW_SIZE);
  }

  const rowBuffer = new Uint8Array(totalRowSize);
  const rowView = new DataView(rowBuffer.buffer);

  // [0]: Flags (0x01 = Active)
  rowView.setUint8(0, 0x01);
  // [1..2]: Stored Row Length
  rowView.setUint16(1, totalRowSize, true);
  // [3..]: Null-Bitmap
  rowBuffer.set(nullBitmap, 3);

  let currentFixedOffset = 3 + nullBitmapBytes;
  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    const isNull = (nullBitmap[i >> 3] & (1 << (i & 7))) !== 0;
    if (!isNull) {
      const val = values[col.name];
      switch (col.type) {
        case DataType.INT32:
          rowView.setInt32(currentFixedOffset, Number(val), true);
          currentFixedOffset += 4;
          break;
        case DataType.INT64:
          rowView.setBigInt64(currentFixedOffset, BigInt(val as any), true);
          currentFixedOffset += 8;
          break;
        case DataType.FLOAT64:
          rowView.setFloat64(currentFixedOffset, Number(val), true);
          currentFixedOffset += 8;
          break;
        case DataType.UUID:
          UuidCodec.encode(String(val), rowBuffer, currentFixedOffset);
          currentFixedOffset += 16;
          break;
        case DataType.ULID:
          UlidCodec.encode(String(val), rowBuffer, currentFixedOffset);
          currentFixedOffset += 16;
          break;
      }
    }
  }

  // Write var-offset table and payloads
  let currentVarTableOffset = currentFixedOffset;
  let currentPayloadOffset = headerAndTablesSize;

  for (let i = 0; i < varColumns.length; i++) {
    const item = varColumns[i];
    if (item.payload === null) {
      // Null column: rel_offset 0, length 0
      rowView.setUint16(currentVarTableOffset, 0, true);
      rowView.setUint16(currentVarTableOffset + 2, 0, true);
    } else {
      rowView.setUint16(currentVarTableOffset, currentPayloadOffset, true);
      rowView.setUint16(currentVarTableOffset + 2, item.payload.byteLength, true);
      rowBuffer.set(item.payload, currentPayloadOffset);
      currentPayloadOffset += item.payload.byteLength;
    }
    currentVarTableOffset += 4;
  }

  return rowBuffer;
}

/**
 * @export_c
 * Deserializes a row record from a DataView into a user-facing DbRow object.
 */
export function page_deserialize_row(
  arg1: TableMeta | ColumnMeta[] | DataView,
  arg2: DataView | number,
  arg3?: number | TableMeta | ColumnMeta[]
): DbRow {
  let columns: ColumnMeta[];
  let view: DataView;
  let recordOffset: number;

  if (arg1 instanceof DataView) {
    view = arg1;
    recordOffset = arg2 as number;
    const tableOrCols = arg3 as (TableMeta | ColumnMeta[]);
    columns = Array.isArray(tableOrCols) ? tableOrCols : (tableOrCols as TableMeta).columns;
  } else {
    columns = Array.isArray(arg1) ? arg1 : (arg1 as TableMeta).columns;
    view = arg2 as DataView;
    recordOffset = arg3 as number;
  }

  const row: DbRow = {};
  const colCount = columns.length;
  const nullBitmapBytes = Math.ceil(colCount / 8);

  const nullBitmap = new Uint8Array(view.buffer, view.byteOffset + recordOffset + 3, nullBitmapBytes);

  let currentFixedOffset = recordOffset + 3 + nullBitmapBytes;

  // Track var-column index
  let varColIdx = 0;
  // Calculate where the var-offset table starts
  // We need to advance fixed offset for non-null fixed columns
  const fixedStart = currentFixedOffset;
  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    const isNull = (nullBitmap[i >> 3] & (1 << (i & 7))) !== 0;
    if (!isNull) {
      switch (col.type) {
        case DataType.INT32:
          currentFixedOffset += 4;
          break;
        case DataType.INT64:
        case DataType.FLOAT64:
          currentFixedOffset += 8;
          break;
        case DataType.UUID:
        case DataType.ULID:
          currentFixedOffset += 16;
          break;
      }
    }
  }

  const varOffsetTableStart = currentFixedOffset;
  currentFixedOffset = fixedStart;

  for (let i = 0; i < colCount; i++) {
    const col = columns[i];
    const isNull = (nullBitmap[i >> 3] & (1 << (i & 7))) !== 0;

    if (isNull) {
      row[col.name] = null;
      if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
        varColIdx++;
      }
      continue;
    }

    switch (col.type) {
      case DataType.INT32:
        row[col.name] = view.getInt32(currentFixedOffset, true);
        currentFixedOffset += 4;
        break;
      case DataType.INT64:
        row[col.name] = view.getBigInt64(currentFixedOffset, true);
        currentFixedOffset += 8;
        break;
      case DataType.FLOAT64:
        row[col.name] = view.getFloat64(currentFixedOffset, true);
        currentFixedOffset += 8;
        break;
      case DataType.UUID: {
        const slice = new Uint8Array(view.buffer, view.byteOffset + currentFixedOffset, 16);
        row[col.name] = UuidCodec.decode(slice, 0);
        currentFixedOffset += 16;
        break;
      }
      case DataType.ULID: {
        const slice = new Uint8Array(view.buffer, view.byteOffset + currentFixedOffset, 16);
        row[col.name] = UlidCodec.decode(slice, 0);
        currentFixedOffset += 16;
        break;
      }
      case DataType.TEXT: {
        const tableEntryOffset = varOffsetTableStart + (varColIdx * 4);
        const relOffset = view.getUint16(tableEntryOffset, true);
        const len = view.getUint16(tableEntryOffset + 2, true);
        const payloadOffset = view.byteOffset + recordOffset + relOffset;
        const textBytes = new Uint8Array(view.buffer, payloadOffset, len);
        row[col.name] = textDecoder.decode(textBytes);
        varColIdx++;
        break;
      }
      case DataType.BLOB: {
        const tableEntryOffset = varOffsetTableStart + (varColIdx * 4);
        const relOffset = view.getUint16(tableEntryOffset, true);
        const len = view.getUint16(tableEntryOffset + 2, true);
        const payloadOffset = view.byteOffset + recordOffset + relOffset;
        const blobBytes = new Uint8Array(len);
        blobBytes.set(new Uint8Array(view.buffer, payloadOffset, len));
        row[col.name] = blobBytes;
        varColIdx++;
        break;
      }
    }
  }

  return row;
}

// ============================================================================
// 5. Table Interior Page Mechanics (page_type = 0x05, 12-Byte Cells)
// ============================================================================

/**
 * @export_c
 * Initializes a Table Interior Page with rightChildPageId.
 */
export function page_init_interior(
  view: DataView,
  pageOffset: number,
  rightChildPageId: number = 0
): void {
  page_init(view, pageOffset, PAGE_TYPE_TABLE_INTERIOR, rightChildPageId);
}

/**
 * @export_c
 * Returns right child page ID of a Table Interior Page.
 */
export function page_get_right_child_page_id(view: DataView, pageOffset: number): number {
  return view.getUint32(pageOffset + 6, true);
}

/**
 * @export_c
 * Sets right child page ID of a Table Interior Page.
 */
export function page_set_right_child_page_id(view: DataView, pageOffset: number, rightChildPageId: number): void {
  view.setUint32(pageOffset + 6, rightChildPageId, true);
}

/**
 * @export_c
 * Inserts a 12-byte routing cell into a Table Interior Page.
 * Returns new cell count or -1 if page has reached max entries (291 entries).
 */
export function page_insert_interior_cell(
  view: DataView,
  pageOffset: number,
  childPageId: number,
  rowid: bigint
): number {
  const cellCount = page_get_cell_count(view, pageOffset);
  if (cellCount >= MAX_TABLE_INTERIOR_CELLS) {
    return -1; // Interior page full
  }

  const contentOffset = page_get_cell_content_offset(view, pageOffset);
  const newContentOffset = contentOffset - TABLE_INTERIOR_CELL_SIZE;

  // Write 12-byte cell payload
  const targetOffset = pageOffset + newContentOffset;
  view.setUint32(targetOffset, childPageId, true);
  view.setBigInt64(targetOffset + 4, rowid, true);

  // Write slot directory entry
  page_set_cell_offset(view, pageOffset, cellCount, newContentOffset);

  page_set_cell_count(view, pageOffset, cellCount + 1);
  page_set_cell_content_offset(view, pageOffset, newContentOffset);

  return cellCount + 1;
}

/**
 * @export_c
 * Performs binary search on a Table Interior Page to route traversal for targetRowid.
 * Returns the child_page_id to traverse.
 */
export function page_binary_search_interior(
  view: DataView,
  pageOffset: number,
  targetRowid: bigint
): number {
  const cellCount = page_get_cell_count(view, pageOffset);
  if (cellCount === 0) {
    return page_get_right_child_page_id(view, pageOffset);
  }

  let lo = 0;
  let hi = cellCount - 1;
  let candidateChild = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cellOffset = page_get_cell_offset(view, pageOffset, mid);
    const cellRowid = view.getBigInt64(pageOffset + cellOffset + 4, true);

    if (targetRowid <= cellRowid) {
      candidateChild = view.getUint32(pageOffset + cellOffset, true);
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  if (candidateChild !== -1) {
    return candidateChild;
  }

  // If targetRowid > all keys on this page, follow right_child_page_id
  return page_get_right_child_page_id(view, pageOffset);
}

/**
 * @export_c
 * Splits a Table Interior Page at median entry (index 145), promoting the median key.
 */
export function page_split_interior(
  view: DataView,
  pageOffset: number,
  newPageOffset: number
): { medianRowid: bigint; promotedChildPageId: number; rightChildPageId: number } {
  const cellCount = page_get_cell_count(view, pageOffset);
  const medianIdx = TABLE_INTERIOR_SPLIT_INDEX; // 145

  if (cellCount <= medianIdx) {
    throw new Error(`Cannot split interior page with only ${cellCount} cells`);
  }

  // Read median cell
  const medianCellOffset = page_get_cell_offset(view, pageOffset, medianIdx);
  const promotedChildPageId = view.getUint32(pageOffset + medianCellOffset, true);
  const medianRowid = view.getBigInt64(pageOffset + medianCellOffset + 4, true);

  // Initialize right sibling interior page
  const oldRightChild = page_get_right_child_page_id(view, pageOffset);
  page_init_interior(view, newPageOffset, oldRightChild);

  // Copy entries 146..cellCount-1 to new sibling page
  for (let i = medianIdx + 1; i < cellCount; i++) {
    const offset = page_get_cell_offset(view, pageOffset, i);
    const childId = view.getUint32(pageOffset + offset, true);
    const rId = view.getBigInt64(pageOffset + offset + 4, true);
    page_insert_interior_cell(view, newPageOffset, childId, rId);
  }

  // Left page keeps entries 0..144, and its right_child_page_id becomes median's childPageId
  page_set_right_child_page_id(view, pageOffset, promotedChildPageId);
  page_set_cell_count(view, pageOffset, medianIdx);

  return {
    medianRowid,
    promotedChildPageId,
    rightChildPageId: oldRightChild,
  };
}

// ============================================================================
// 6. Secondary Index Leaf Page Mechanics (page_type = 0x0A)
// ============================================================================

/**
 * @export_c
 * Initializes a Secondary Index Leaf Page.
 */
export function page_init_index_leaf(
  view: DataView,
  pageOffset: number,
  nextPageId: number = 0
): void {
  page_init(view, pageOffset, PAGE_TYPE_INDEX_LEAF, nextPageId);
}

/**
 * @export_c
 * Compares two index keys according to SQLite 3VL collation order:
 * NULL < -Infinity < Numbers < TEXT (UTF-8) < BLOB
 */
export function page_compare_index_keys(
  typeA: DataType,
  valA: any,
  rowidA: bigint,
  typeB: DataType,
  valB: any,
  rowidB: bigint
): number {
  if (typeA !== typeB) {
    // 3VL collation precedence order
    return typeA - typeB;
  }

  if (typeA === DataType.NULL) {
    return rowidA < rowidB ? -1 : (rowidA > rowidB ? 1 : 0);
  }

  let diff = 0;
  if (typeA === DataType.INT32 || typeA === DataType.INT64 || typeA === DataType.FLOAT64) {
    const numA = typeof valA === 'bigint' ? Number(valA) : valA;
    const numB = typeof valB === 'bigint' ? Number(valB) : valB;
    diff = numA < numB ? -1 : (numA > numB ? 1 : 0);
  } else if (typeA === DataType.TEXT || typeA === DataType.UUID || typeA === DataType.ULID) {
    const strA = String(valA);
    const strB = String(valB);
    diff = strA < strB ? -1 : (strA > strB ? 1 : 0);
  } else if (typeA === DataType.BLOB) {
    const bA = valA as Uint8Array;
    const bB = valB as Uint8Array;
    const minLen = Math.min(bA.length, bB.length);
    for (let i = 0; i < minLen; i++) {
      if (bA[i] !== bB[i]) {
        diff = bA[i] < bB[i] ? -1 : 1;
        break;
      }
    }
    if (diff === 0) {
      diff = bA.length - bB.length;
    }
  }

  if (diff !== 0) return diff;
  return rowidA < rowidB ? -1 : (rowidA > rowidB ? 1 : 0);
}

function page_decode_index_cell(
  view: DataView,
  cellDataOffset: number,
  kLen: number,
  contextType: DataType
): { cellType: DataType; cellVal: any } {
  const kData = new Uint8Array(view.buffer, view.byteOffset + cellDataOffset, kLen);
  if (kLen === 0) {
    return { cellType: DataType.NULL, cellVal: null };
  }
  if (kLen === 2) {
    return { cellType: DataType.BLOB, cellVal: kData };
  }
  if (kLen === 4) {
    return { cellType: DataType.INT32, cellVal: new DataView(kData.buffer, kData.byteOffset).getInt32(0, true) };
  }
  if (contextType === DataType.UUID && kLen === 16) {
    return { cellType: DataType.UUID, cellVal: UuidCodec.decode(kData, 0) };
  }
  if (contextType === DataType.ULID && kLen === 16) {
    return { cellType: DataType.ULID, cellVal: UlidCodec.decode(kData, 0) };
  }
  if (contextType === DataType.FLOAT64 && kLen === 8) {
    return { cellType: DataType.FLOAT64, cellVal: new DataView(kData.buffer, kData.byteOffset).getFloat64(0, true) };
  }
  if (contextType === DataType.INT64 && kLen === 8) {
    return { cellType: DataType.INT64, cellVal: new DataView(kData.buffer, kData.byteOffset).getBigInt64(0, true) };
  }
  return { cellType: DataType.TEXT, cellVal: textDecoder.decode(kData) };
}

/**
 * @export_c
 * Inserts a key and rowid into a Secondary Index Leaf Page, maintaining sorted slot directory.
 */
export function page_insert_index_leaf_cell(
  view: DataView,
  pageOffset: number,
  keyType: DataType,
  keyValue: any,
  rowid: bigint,
  scratchpadOffset?: number
): number {
  let keyBytes: Uint8Array;
  if (keyType === DataType.NULL || keyValue === null || keyValue === undefined) {
    keyBytes = new Uint8Array(0);
  } else if (keyType === DataType.INT32) {
    keyBytes = new Uint8Array(4);
    new DataView(keyBytes.buffer).setInt32(0, Number(keyValue), true);
  } else if (keyType === DataType.INT64) {
    keyBytes = new Uint8Array(8);
    new DataView(keyBytes.buffer).setBigInt64(0, BigInt(keyValue), true);
  } else if (keyType === DataType.FLOAT64) {
    keyBytes = new Uint8Array(8);
    new DataView(keyBytes.buffer).setFloat64(0, Number(keyValue), true);
  } else if (keyType === DataType.UUID) {
    keyBytes = new Uint8Array(16);
    UuidCodec.encode(String(keyValue), keyBytes, 0);
  } else if (keyType === DataType.ULID) {
    keyBytes = new Uint8Array(16);
    UlidCodec.encode(String(keyValue), keyBytes, 0);
  } else if (keyType === DataType.TEXT) {
    keyBytes = textEncoder.encode(String(keyValue));
  } else {
    keyBytes = keyValue instanceof Uint8Array ? keyValue : new Uint8Array(keyValue);
  }

  // Cell format: [key_len uint16][key_data][rowid int64]
  const cellLength = 2 + keyBytes.byteLength + 8;
  const neededBytes = cellLength + 2; // + 2B slot directory entry

  const cellCount = page_get_cell_count(view, pageOffset);
  const contiguousFree = page_get_contiguous_free_space(view, pageOffset);
  const totalFree = contiguousFree + page_get_free_bytes(view, pageOffset);

  if (neededBytes > totalFree) {
    return -1; // Index leaf full
  }

  if (neededBytes > contiguousFree) {
    page_compact(view, pageOffset, scratchpadOffset);
  }

  const contentOffset = page_get_cell_content_offset(view, pageOffset);
  const newContentOffset = contentOffset - cellLength;
  const targetOffset = pageOffset + newContentOffset;

  // Write cell
  const absTarget = view.byteOffset + targetOffset;
  view.setUint16(targetOffset, keyBytes.byteLength, true);
  new Uint8Array(view.buffer).set(keyBytes, absTarget + 2);
  view.setBigInt64(targetOffset + 2 + keyBytes.byteLength, rowid, true);

  // Binary search to find sorted insertion slot index
  let lo = 0;
  let hi = cellCount - 1;
  let insertSlot = cellCount;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const offset = page_get_cell_offset(view, pageOffset, mid);
    const existingKLen = view.getUint16(pageOffset + offset, true);
    const rId = view.getBigInt64(pageOffset + offset + 2 + existingKLen, true);
    const { cellType: midType, cellVal: midVal } = page_decode_index_cell(view, pageOffset + offset + 2, existingKLen, keyType);

    const cmp = page_compare_index_keys(keyType, keyValue, rowid, midType, midVal, rId);
    if (cmp < 0) {
      insertSlot = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // Shift slot directory entries from insertSlot right by 2 bytes
  const uint8 = new Uint8Array(view.buffer);
  const absPageStart = view.byteOffset + pageOffset;
  const slotDirStart = absPageStart + PAGE_HEADER_SIZE;
  const src = slotDirStart + insertSlot * 2;
  const dst = slotDirStart + (insertSlot + 1) * 2;
  const shiftLen = (cellCount - insertSlot) * 2;

  if (shiftLen > 0) {
    uint8.copyWithin(dst, src, src + shiftLen);
  }

  // Write new slot entry
  page_set_cell_offset(view, pageOffset, insertSlot, newContentOffset);

  page_set_cell_count(view, pageOffset, cellCount + 1);
  page_set_cell_content_offset(view, pageOffset, newContentOffset);

  return insertSlot;
}

/**
 * @export_c
 * Binary searches an Index Leaf Page for target key and optional rowid.
 */
export function page_binary_search_index_leaf(
  view: DataView,
  pageOffset: number,
  targetType: DataType,
  targetValue: any,
  targetRowid?: bigint
): { found: boolean; slotIdx: number } {
  const cellCount = page_get_cell_count(view, pageOffset);
  let lo = 0;
  let hi = cellCount - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const offset = page_get_cell_offset(view, pageOffset, mid);
    const kLen = view.getUint16(pageOffset + offset, true);
    const rId = view.getBigInt64(pageOffset + offset + 2 + kLen, true);
    const { cellType: midType, cellVal: midVal } = page_decode_index_cell(view, pageOffset + offset + 2, kLen, targetType);

    const rowidToCompare = targetRowid !== undefined ? targetRowid : rId;
    const cmp = page_compare_index_keys(targetType, targetValue, rowidToCompare, midType, midVal, rId);

    if (cmp === 0) {
      return { found: true, slotIdx: mid };
    } else if (cmp < 0) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return { found: false, slotIdx: lo };
}
