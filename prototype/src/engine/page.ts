import {
  PAGE_SIZE,
  MAX_ROW_SIZE,
  PAGE_HEADER_SIZE,
  PAGE_TYPE_LEAF_DATA,
} from '../constants.js';
import {
  DataType,
  ColumnFlag,
  TableMeta,
  TableColumnMeta,
  DbRow,
  DbValue,
  RowSizeLimitExceededError,
  NotNullConstraintError,
} from '../types.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Initializes a 4KB slotted leaf data page.
 */
export function initPage(
  view: DataView,
  pageOffset: number,
  pageType: number = PAGE_TYPE_LEAF_DATA
): void {
  view.setUint8(pageOffset + 0, pageType);           // page_type (0x0D = Leaf Data)
  view.setUint8(pageOffset + 1, 0);                  // reserved
  view.setUint16(pageOffset + 2, 0, true);           // cell_count = 0
  view.setUint16(pageOffset + 4, PAGE_SIZE, true);   // cell_content_offset = 4096 (empty)
  view.setUint32(pageOffset + 6, 0, true);           // next_page_id = 0
  view.setUint16(pageOffset + 10, 0, true);          // reserved
}

export function getCellCount(view: DataView, pageOffset: number): number {
  return view.getUint16(pageOffset + 2, true);
}

export function getCellContentOffset(view: DataView, pageOffset: number): number {
  return view.getUint16(pageOffset + 4, true);
}

export function getNextPageId(view: DataView, pageOffset: number): number {
  return view.getUint32(pageOffset + 6, true);
}

export function setNextPageId(view: DataView, pageOffset: number, nextPageId: number): void {
  view.setUint32(pageOffset + 6, nextPageId, true);
}

export function getCellOffset(view: DataView, pageOffset: number, slotIdx: number): number {
  const slotDirOffset = pageOffset + PAGE_HEADER_SIZE + (slotIdx * 2);
  return view.getUint16(slotDirOffset, true);
}

/**
 * Calculates remaining free space in a slotted page.
 */
export function getFreeSpace(view: DataView, pageOffset: number): number {
  const cellCount = getCellCount(view, pageOffset);
  const cellContentOffset = getCellContentOffset(view, pageOffset);
  const slotDirEnd = PAGE_HEADER_SIZE + (cellCount * 2);
  return cellContentOffset - slotDirEnd;
}

/**
 * Inserts a serialized row record into a slotted data page.
 * Returns the slot index (0-indexed) or -1 if the row does not fit in this page.
 */
export function insertRowIntoPage(
  view: DataView,
  pageOffset: number,
  rowBytes: Uint8Array
): number {
  const cellCount = getCellCount(view, pageOffset);
  const cellContentOffset = getCellContentOffset(view, pageOffset);
  const neededBytes = rowBytes.byteLength + 2; // Payload + 2B slot directory entry

  const slotDirEnd = PAGE_HEADER_SIZE + (cellCount * 2);
  const freeSpace = cellContentOffset - slotDirEnd;

  if (neededBytes > freeSpace) {
    return -1; // Page full
  }

  // Allocate payload from bottom up
  const newContentOffset = cellContentOffset - rowBytes.byteLength;
  const targetOffset = pageOffset + newContentOffset;

  // Copy row bytes into page
  const pageUint8 = new Uint8Array(view.buffer, targetOffset, rowBytes.byteLength);
  pageUint8.set(rowBytes);

  // Write new slot directory entry
  const slotDirOffset = pageOffset + PAGE_HEADER_SIZE + (cellCount * 2);
  view.setUint16(slotDirOffset, newContentOffset, true);

  // Update page header
  view.setUint16(pageOffset + 2, cellCount + 1, true);
  view.setUint16(pageOffset + 4, newContentOffset, true);

  return cellCount;
}

/**
 * Calculates fixed slice size and var column counts for a table.
 */
export function getTableLayout(columns: TableColumnMeta[]) {
  let fixedSliceSize = 0;
  let varColCount = 0;

  for (const col of columns) {
    if (col.type === DataType.INT32) {
      fixedSliceSize += 4;
    } else if (col.type === DataType.INT64 || col.type === DataType.FLOAT64) {
      fixedSliceSize += 8;
    } else if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
      varColCount++;
    }
  }

  const nullBitmapBytes = (columns.length + 7) >> 3;
  return { fixedSliceSize, varColCount, nullBitmapBytes };
}

/**
 * Serializes a user record into binary format according to TableMeta.
 */
export function serializeRow(table: TableMeta, row: DbRow): Uint8Array {
  const { fixedSliceSize, varColCount, nullBitmapBytes } = getTableLayout(table.columns);

  // Var-offset table: 2B offset + 2B length per var column (TEXT or BLOB)
  const varTableSize = varColCount * 4;
  const headerAndFixedSize = 1 + nullBitmapBytes + fixedSliceSize + varTableSize;

  // First pass: validate constraints and calculate var payloads
  const varPayloads: Uint8Array[] = [];
  let varPayloadTotalBytes = 0;

  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i];
    const val = row[col.name];

    // Check NOT NULL constraint
    if ((col.flags & ColumnFlag.NOT_NULL) !== 0) {
      if (val === null || val === undefined) {
        throw new NotNullConstraintError(col.name, table.name);
      }
    }

    if (col.type === DataType.TEXT) {
      if (val !== null && val !== undefined) {
        const encoded = textEncoder.encode(String(val));
        varPayloads.push(encoded);
        varPayloadTotalBytes += encoded.byteLength;
      } else {
        varPayloads.push(new Uint8Array(0));
      }
    } else if (col.type === DataType.BLOB) {
      if (val !== null && val !== undefined) {
        const bytes = val instanceof Uint8Array ? val : new Uint8Array(0);
        varPayloads.push(bytes);
        varPayloadTotalBytes += bytes.byteLength;
      } else {
        varPayloads.push(new Uint8Array(0));
      }
    }
  }

  const totalRecordSize = headerAndFixedSize + varPayloadTotalBytes;
  if (totalRecordSize > MAX_ROW_SIZE) {
    throw new RowSizeLimitExceededError(totalRecordSize, MAX_ROW_SIZE);
  }

  // Allocate buffer for this row
  const buffer = new ArrayBuffer(totalRecordSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // 1. Flags (1 byte, 0x01 = Active)
  view.setUint8(0, 0x01);

  // 2. Dynamic Null-Bitmap
  const nullBitmapOffset = 1;
  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i];
    const val = row[col.name];
    if (val === null || val === undefined) {
      const byteIdx = nullBitmapOffset + (i >> 3);
      const bitMask = 1 << (i & 7);
      view.setUint8(byteIdx, view.getUint8(byteIdx) | bitMask);
    }
  }

  // 3. Fixed-Width Column Slice
  const fixedSliceOffset = nullBitmapOffset + nullBitmapBytes;
  // 4. Var-Offset Table
  const varTableOffset = fixedSliceOffset + fixedSliceSize;

  let currentVarPayloadOffset = headerAndFixedSize;
  let varIdx = 0;

  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i];
    const val = row[col.name];
    const isNull = (val === null || val === undefined);

    if (col.type === DataType.INT32) {
      if (!isNull) {
        view.setInt32(fixedSliceOffset + col.colOffset, Number(val), true);
      }
    } else if (col.type === DataType.INT64) {
      if (!isNull) {
        view.setBigInt64(fixedSliceOffset + col.colOffset, BigInt(val as any), true);
      }
    } else if (col.type === DataType.FLOAT64) {
      if (!isNull) {
        view.setFloat64(fixedSliceOffset + col.colOffset, Number(val), true);
      }
    } else if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
      const entryOffset = varTableOffset + (varIdx * 4);
      if (isNull) {
        // Offset 0, length 0
        view.setUint16(entryOffset, 0, true);
        view.setUint16(entryOffset + 2, 0, true);
      } else {
        const payload = varPayloads[varIdx];
        view.setUint16(entryOffset, currentVarPayloadOffset, true);
        view.setUint16(entryOffset + 2, payload.byteLength, true);

        // Copy payload into variable area
        uint8.set(payload, currentVarPayloadOffset);
        currentVarPayloadOffset += payload.byteLength;
      }
      varIdx++;
    }
  }

  return uint8;
}

/**
 * Deserializes a row record from binary format at a specific offset.
 */
export function deserializeRow(
  view: DataView,
  rowOffset: number,
  table: TableMeta
): DbRow {
  const { fixedSliceSize, nullBitmapBytes } = getTableLayout(table.columns);

  const flags = view.getUint8(rowOffset);
  if (flags === 0) {
    // Deleted row
    return {};
  }

  const nullBitmapOffset = rowOffset + 1;
  const fixedSliceOffset = nullBitmapOffset + nullBitmapBytes;
  const varTableOffset = fixedSliceOffset + fixedSliceSize;

  const result: DbRow = {};
  let varIdx = 0;

  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i];

    // Check Null-Bitmap bit
    const byteVal = view.getUint8(nullBitmapOffset + (i >> 3));
    const isNull = (byteVal & (1 << (i & 7))) !== 0;

    if (isNull) {
      result[col.name] = null;
      if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
        varIdx++;
      }
      continue;
    }

    if (col.type === DataType.INT32) {
      result[col.name] = view.getInt32(fixedSliceOffset + col.colOffset, true);
    } else if (col.type === DataType.INT64) {
      result[col.name] = view.getBigInt64(fixedSliceOffset + col.colOffset, true);
    } else if (col.type === DataType.FLOAT64) {
      result[col.name] = view.getFloat64(fixedSliceOffset + col.colOffset, true);
    } else if (col.type === DataType.TEXT) {
      const entryOffset = varTableOffset + (varIdx * 4);
      const payloadRelOffset = view.getUint16(entryOffset, true);
      const payloadLen = view.getUint16(entryOffset + 2, true);

      if (payloadLen === 0) {
        result[col.name] = '';
      } else {
        const payloadAbsOffset = rowOffset + payloadRelOffset;
        const textBytes = new Uint8Array(view.buffer, payloadAbsOffset, payloadLen);
        result[col.name] = textDecoder.decode(textBytes);
      }
      varIdx++;
    } else if (col.type === DataType.BLOB) {
      const entryOffset = varTableOffset + (varIdx * 4);
      const payloadRelOffset = view.getUint16(entryOffset, true);
      const payloadLen = view.getUint16(entryOffset + 2, true);

      if (payloadLen === 0) {
        result[col.name] = new Uint8Array(0);
      } else {
        const payloadAbsOffset = rowOffset + payloadRelOffset;
        const copy = new Uint8Array(payloadLen);
        copy.set(new Uint8Array(view.buffer, payloadAbsOffset, payloadLen));
        result[col.name] = copy;
      }
      varIdx++;
    }
  }

  return result;
}
