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
} from "../../constants.ts";
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
} from "../../types/index.ts";
import { UuidCodec, UlidCodec } from "./codecs.c.ts";

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

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
  page_offset: number,
  page_type: number = PAGE_TYPE_LEAF_DATA,
  next_page_id: number = 0,
): void {
  view.setUint8(page_offset + 0, page_type);
  view.setUint8(page_offset + 1, 0);
  view.setUint16(page_offset + 2, 0, true);
  view.setUint16(page_offset + 4, PAGE_SIZE, true);
  view.setUint32(page_offset + 6, next_page_id, true);
  view.setUint16(page_offset + 10, 0, true);
  view.setUint32(page_offset + PAGE_HEADER_OFFSET_CHECKSUM, 0, true);
}

/**
 * @export_c
 * Initializes a 4KB free-list page header.
 */
export function page_init_free(
  view: DataView,
  page_offset: number,
  next_free_page_id: number = 0,
): void {
  view.setUint8(page_offset + 0, PAGE_TYPE_FREE);
  view.setUint8(page_offset + 1, 0);
  view.setUint16(page_offset + 2, 0, true);
  view.setUint16(page_offset + 4, 0, true);
  view.setUint32(page_offset + 6, next_free_page_id, true);
  view.setUint16(page_offset + 10, 0, true);
  view.setUint32(page_offset + PAGE_HEADER_OFFSET_CHECKSUM, 0, true);
}

/**
 * @export_c
 * Returns the page type byte from a page header.
 */
export function page_get_type(view: DataView, page_offset: number): number {
  return view.getUint8(page_offset + 0);
}

/**
 * @export_c
 * Sets the page type byte in a page header.
 */
export function page_set_type(
  view: DataView,
  page_offset: number,
  type: number,
): void {
  view.setUint8(page_offset + 0, type);
}

/**
 * @export_c
 * Returns the number of cells in the page slot directory.
 */
export function page_get_cell_count(
  view: DataView,
  page_offset: number,
): number {
  return view.getUint16(page_offset + 2, true);
}

/**
 * @export_c
 * Sets the number of cells in the page slot directory.
 */
export function page_set_cell_count(
  view: DataView,
  page_offset: number,
  count: number,
): void {
  view.setUint16(page_offset + 2, count, true);
}

/**
 * @export_c
 * Returns the byte offset within the page where active cell payloads begin.
 */
export function page_get_cell_content_offset(
  view: DataView,
  page_offset: number,
): number {
  return view.getUint16(page_offset + 4, true);
}

/**
 * @export_c
 * Sets the byte offset within the page where active cell payloads begin.
 */
export function page_set_cell_content_offset(
  view: DataView,
  page_offset: number,
  offset: number,
): void {
  view.setUint16(page_offset + 4, offset, true);
}

/**
 * @export_c
 * Returns the next page ID (or right child page ID) stored in the page header.
 */
export function page_get_next_page_id(
  view: DataView,
  page_offset: number,
): number {
  return view.getUint32(page_offset + 6, true);
}

/**
 * @export_c
 * Sets the next page ID (or right child page ID) stored in the page header.
 */
export function page_set_next_page_id(
  view: DataView,
  page_offset: number,
  next_page_id: number,
): void {
  view.setUint32(page_offset + 6, next_page_id, true);
}

/**
 * @export_c
 * Returns cumulative fragmented unallocated bytes in the page.
 */
export function page_get_free_bytes(
  view: DataView,
  page_offset: number,
): number {
  return view.getUint16(page_offset + 10, true);
}

/**
 * @export_c
 * Sets cumulative fragmented unallocated bytes in the page.
 */
export function page_set_free_bytes(
  view: DataView,
  page_offset: number,
  free_bytes: number,
): void {
  view.setUint16(page_offset + 10, free_bytes, true);
}

/**
 * @export_c
 * Returns the checksum stored at bytes 12..15 in the page header.
 */
export function page_get_checksum(view: DataView, page_offset: number): number {
  return view.getUint32(page_offset + PAGE_HEADER_OFFSET_CHECKSUM, true);
}

/**
 * @export_c
 * Sets the checksum stored at bytes 12..15 in the page header.
 */
export function page_set_checksum(
  view: DataView,
  page_offset: number,
  checksum: number,
): void {
  view.setUint32(page_offset + PAGE_HEADER_OFFSET_CHECKSUM, checksum, true);
}

/**
 * @export_c
 * Returns the cell payload offset for the given slot directory index.
 */
export function page_get_cell_offset(
  view: DataView,
  page_offset: number,
  slot_idx: number,
): number {
  const slot_dir_offset = page_offset + PAGE_HEADER_SIZE + slot_idx * 2;
  return view.getUint16(slot_dir_offset, true);
}

/**
 * @export_c
 * Sets the cell payload offset for the given slot directory index.
 */
export function page_set_cell_offset(
  view: DataView,
  page_offset: number,
  slot_idx: number,
  cell_offset: number,
): void {
  const slot_dir_offset = page_offset + PAGE_HEADER_SIZE + slot_idx * 2;
  view.setUint16(slot_dir_offset, cell_offset, true);
}

/**
 * @export_c
 * Returns contiguous free space between slot directory end and cell content offset.
 */
export function page_get_contiguous_free_space(
  view: DataView,
  page_offset: number,
): number {
  const cell_count = page_get_cell_count(view, page_offset);
  const cell_content_offset = page_get_cell_content_offset(view, page_offset);
  const slot_dir_end = PAGE_HEADER_SIZE + cell_count * 2;
  return cell_content_offset - slot_dir_end;
}

/**
 * @export_c
 * Returns total free space on the page (contiguous + fragmented free_bytes).
 */
export function page_get_total_free_space(
  view: DataView,
  page_offset: number,
): number {
  return (
    page_get_contiguous_free_space(view, page_offset) +
    page_get_free_bytes(view, page_offset)
  );
}

// ============================================================================
// 2. In-Place Page Compaction / Defragmentation (Zero-Allocation via Scratchpad)
// ============================================================================

export interface ReplacementCell {
  cell_idx: number;
  row_bytes: Uint8Array;
}

/**
 * @export_c
 * Defragments a slotted data page using a 4KB staging scratchpad.
 * Collapses fragmented holes to the bottom, rewrites slot directory entries,
 * and sets free_bytes to 0. Optionally replaces a cell in-place during compaction.
 */
export function page_compact(
  view: DataView,
  page_offset: number,
  scratchpad_offset?: number,
  replacement?: ReplacementCell,
): void {
  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_count === 0) {
    page_set_cell_content_offset(view, page_offset, PAGE_SIZE);
    page_set_free_bytes(view, page_offset, 0);
    return;
  }

  const abs_page_start = view.byteOffset + page_offset;
  const uint8 = new Uint8Array(view.buffer);

  // Read all active cell offsets and their lengths
  interface CellInfo {
    slot_idx: number;
    offset: number;
    length: number;
    replacement_bytes?: Uint8Array;
  }

  const cells: CellInfo[] = [];
  for (let i = 0; i < cell_count; i++) {
    if (replacement && i === replacement.cell_idx) {
      cells.push({
        slot_idx: i,
        offset: -1,
        length: replacement.row_bytes.byteLength,
        replacement_bytes: replacement.row_bytes,
      });
    } else {
      const offset = page_get_cell_offset(view, page_offset, i);
      const len = page_get_row_length(view, page_offset + offset);
      cells.push({ slot_idx: i, offset, length: len });
    }
  }

  // Create staging scratchpad (either at designated scratchpad offset in ArrayBuffer or locally)
  let scratch_offset: number;
  let use_local_search = false;
  let local_scratch: Uint8Array | null = null;

  if (scratchpad_offset !== undefined) {
    scratch_offset = scratchpad_offset;
  } else {
    // If not provided in standalone tests, use a local 4KB buffer
    use_local_search = true;
    local_scratch = new Uint8Array(PAGE_SIZE);
    scratch_offset = 0;
  }

  const scratch_view = use_local_search
    ? new DataView(local_scratch!.buffer)
    : new DataView(view.buffer, scratch_offset, PAGE_SIZE);

  // Copy header (first 16 bytes)
  const header_bytes = new Uint8Array(
    view.buffer,
    abs_page_start,
    PAGE_HEADER_SIZE,
  );
  if (use_local_search) {
    local_scratch!.set(header_bytes, 0);
  } else {
    uint8.set(header_bytes, scratch_offset);
  }

  // Pack active cells contiguously from byte 4096 upwards
  let current_offset = PAGE_SIZE;
  for (let i = 0; i < cell_count; i++) {
    const cell = cells[i];
    current_offset -= cell.length;

    // Copy cell payload into scratchpad
    if (cell.replacement_bytes) {
      if (use_local_search) {
        local_scratch!.set(cell.replacement_bytes, current_offset);
      } else {
        uint8.set(cell.replacement_bytes, scratch_offset + current_offset);
      }
    } else {
      const cell_bytes = new Uint8Array(
        view.buffer,
        abs_page_start + cell.offset,
        cell.length,
      );
      if (use_local_search) {
        local_scratch!.set(cell_bytes, current_offset);
      } else {
        uint8.set(cell_bytes, scratch_offset + current_offset);
      }
    }

    // Write new slot directory offset in scratchpad
    scratch_view.setUint16(
      PAGE_HEADER_SIZE + cell.slot_idx * 2,
      current_offset,
      true,
    );
  }

  // Update scratchpad header fields
  scratch_view.setUint16(4, current_offset, true); // cell_content_offset
  scratch_view.setUint16(10, 0, true); // free_bytes = 0

  // Copy compacted scratchpad back into target page slot
  if (use_local_search) {
    uint8.set(local_scratch!, abs_page_start);
  } else {
    uint8.copyWithin(
      abs_page_start,
      scratch_offset,
      scratch_offset + PAGE_SIZE,
    );
  }
}

/**
 * @export_c
 * Calculates row length in bytes from the serialized row at row_offset.
 */
export function page_get_row_length(
  view: DataView,
  row_offset: number,
): number {
  return view.getUint16(row_offset + 1, true);
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
  page_offset: number,
  row_bytes: Uint8Array,
  scratchpad_offset?: number,
): number {
  const cell_count = page_get_cell_count(view, page_offset);
  const cell_content_offset = page_get_cell_content_offset(view, page_offset);
  const needed_bytes = row_bytes.byteLength + 2; // payload + 2B slot directory entry

  const slot_dir_end = PAGE_HEADER_SIZE + cell_count * 2;
  const contiguous_free = cell_content_offset - slot_dir_end;
  const total_free = contiguous_free + page_get_free_bytes(view, page_offset);

  if (needed_bytes > total_free) {
    return -1; // Cannot fit even after defragmentation
  }

  if (needed_bytes > contiguous_free) {
    // In-place compaction collapses all fragmented holes
    page_compact(view, page_offset, scratchpad_offset);
  }

  const current_content_offset = page_get_cell_content_offset(
    view,
    page_offset,
  );
  const current_cell_count = page_get_cell_count(view, page_offset);

  // Allocate payload from bottom up
  const new_content_offset = current_content_offset - row_bytes.byteLength;
  const abs_target = view.byteOffset + page_offset + new_content_offset;

  // Copy row bytes into page
  const uint8 = new Uint8Array(view.buffer);
  uint8.set(row_bytes, abs_target);

  // Write new slot directory entry
  page_set_cell_offset(
    view,
    page_offset,
    current_cell_count,
    new_content_offset,
  );

  // Update page header
  page_set_cell_count(view, page_offset, current_cell_count + 1);
  page_set_cell_content_offset(view, page_offset, new_content_offset);

  return current_cell_count;
}

/**
 * @export_c
 * Deletes a row from a slotted data page.
 * Shifts subsequent slot directory entries left by 2 bytes (memmove) and increments free_bytes.
 */
export function page_delete_row(
  view: DataView,
  page_offset: number,
  cell_idx: number,
): void {
  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_idx < 0 || cell_idx >= cell_count) {
    throw new Error(
      `Invalid cell index ${cell_idx} for deletion (cell_count=${cell_count})`,
    );
  }

  const offset = page_get_cell_offset(view, page_offset, cell_idx);
  const row_len = page_get_row_length(view, page_offset + offset);

  // Shift slot directory entries left by 2 bytes
  const uint8 = new Uint8Array(view.buffer);
  const abs_page_start = view.byteOffset + page_offset;
  const slot_dir_start = abs_page_start + PAGE_HEADER_SIZE;
  const src = slot_dir_start + (cell_idx + 1) * 2;
  const dst = slot_dir_start + cell_idx * 2;
  const shift_length = (cell_count - 1 - cell_idx) * 2;

  if (shift_length > 0) {
    uint8.copyWithin(dst, src, src + shift_length);
  }

  // Update header
  page_set_cell_count(view, page_offset, cell_count - 1);
  page_set_free_bytes(
    view,
    page_offset,
    page_get_free_bytes(view, page_offset) + row_len,
  );
}

/**
 * @export_c
 * Updates an existing row in a slotted data page following the 3 scenarios in §4.5.
 * Returns true if update succeeded on this page, or false if it exceeded page capacity (Scenario C).
 */
export function page_update_row(
  view: DataView,
  page_offset: number,
  cell_idx: number,
  new_row_bytes: Uint8Array,
  scratchpad_offset?: number,
): boolean {
  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_idx < 0 || cell_idx >= cell_count) {
    throw new Error(`Invalid cell index ${cell_idx} for update`);
  }

  const old_offset = page_get_cell_offset(view, page_offset, cell_idx);
  const old_len = page_get_row_length(view, page_offset + old_offset);
  const new_len = new_row_bytes.byteLength;
  const uint8 = new Uint8Array(view.buffer);

  // Scenario A: Same-size or shrinking update
  if (new_len <= old_len) {
    uint8.set(new_row_bytes, view.byteOffset + page_offset + old_offset);
    if (new_len < old_len) {
      page_set_free_bytes(
        view,
        page_offset,
        page_get_free_bytes(view, page_offset) + (old_len - new_len),
      );
    }
    return true;
  }

  // Scenario B: Expanding update fitting on current page
  const total_free = page_get_total_free_space(view, page_offset);
  const needed_extra = new_len - old_len;

  if (total_free >= needed_extra) {
    const contiguous_free = page_get_contiguous_free_space(view, page_offset);
    if (contiguous_free < new_len) {
      // Compacting directly replaces the old record with the new record,
      // avoiding dead ghost copies and slot directory boundary overflows
      page_compact(view, page_offset, scratchpad_offset, {
        cell_idx,
        row_bytes: new_row_bytes,
      });
      return true;
    }

    // Mark old record space as hole
    page_set_free_bytes(
      view,
      page_offset,
      page_get_free_bytes(view, page_offset) + old_len,
    );

    const content_offset = page_get_cell_content_offset(view, page_offset);
    const new_content_offset = content_offset - new_len;
    uint8.set(
      new_row_bytes,
      view.byteOffset + page_offset + new_content_offset,
    );

    // Update slot directory entry
    page_set_cell_offset(view, page_offset, cell_idx, new_content_offset);
    page_set_cell_content_offset(view, page_offset, new_content_offset);
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
export function page_get_table_layout(
  table_or_columns: TableMeta | ColumnMeta[],
) {
  const columns = Array.isArray(table_or_columns)
    ? table_or_columns
    : (table_or_columns as TableMeta).columns;
  const null_bitmap_bytes = Math.ceil(columns.length / 8);
  let fixed_slice_size = 0;
  let var_col_count = 0;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (c.type === DataType.INT32) fixed_slice_size += 4;
    else if (c.type === DataType.INT64 || c.type === DataType.FLOAT64)
      fixed_slice_size += 8;
    else if (c.type === DataType.UUID || c.type === DataType.ULID)
      fixed_slice_size += 16;
    else if (c.type === DataType.TEXT || c.type === DataType.BLOB)
      var_col_count++;
  }
  return { null_bitmap_bytes, fixed_slice_size, var_col_count };
}

/**
 * @export_c
 * Serializes a user row into WebDB Phase 1 binary format:
 *
 * [0]: Flags (1B: 0x01 = Active)
 * [1..2]: Row _length (2B uint16 LE)
 * [3..(3 + null_bitmap_bytes - 1)]: _null-_bitmap (ceil(N/8) bytes)
 * Followed by: Fixed Slice (INT32 4B, INT64 8B, FLOAT64 8B, UUID 16B, ULID 16B)
 * Followed by: Var-_offset Table (4B per TEXT/BLOB column: 2B rel_offset, 2B length)
 * Followed by: Var Payloads (raw UTF-8 string or binary bytes)
 *
 * Strict 2048-Byte boundary enforced.
 */
export function page_serialize_row(
  table_or_columns: TableMeta | ColumnMeta[],
  values: Record<string, DbValue>,
): Uint8Array {
  const columns = Array.isArray(table_or_columns)
    ? table_or_columns
    : (table_or_columns as TableMeta).columns;
  const col_count = columns.length;
  if (col_count > MAX_COLUMNS_PER_TABLE) {
    throw new TooManyColumnsError(col_count, MAX_COLUMNS_PER_TABLE);
  }

  const null_bitmap_bytes = Math.ceil(col_count / 8);
  const null_bitmap = new Uint8Array(null_bitmap_bytes);

  // Validate NOT NULL constraints & compute null bits
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const val = values[col.name];
    const is_null = val === null || val === undefined;

    if (is_null) {
      if ((col.flags & ColumnFlag.NOT_NULL) !== 0) {
        throw new NotNullConstraintError(col.name);
      }
      const byte_idx = i >> 3;
      const bit_mask = 1 << (i & 7);
      null_bitmap[byte_idx] |= bit_mask;
    }
  }

  // Calculate fixed-width slice and var-length payloads
  let fixed_slice_size = 0;
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const is_null = (null_bitmap[i >> 3] & (1 << (i & 7))) !== 0;
    if (!is_null) {
      switch (col.type) {
        case DataType.INT32:
          fixed_slice_size += 4;
          break;
        case DataType.INT64:
        case DataType.FLOAT64:
          fixed_slice_size += 8;
          break;
        case DataType.UUID:
        case DataType.ULID:
          fixed_slice_size += 16;
          break;
      }
    }
  }

  // Variable columns offset table (4 bytes each)
  const var_columns: Array<{
    col_idx: number;
    col: ColumnMeta;
    payload: Uint8Array | null;
  }> = [];
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
      const is_null = (null_bitmap[i >> 3] & (1 << (i & 7))) !== 0;
      if (is_null) {
        var_columns.push({ col_idx: i, col, payload: null });
      } else {
        const val = values[col.name];
        let bytes: Uint8Array;
        if (col.type === DataType.TEXT) {
          bytes = text_encoder.encode(String(val ?? ""));
        } else {
          bytes = val instanceof Uint8Array ? val : new Uint8Array(val as any);
        }
        var_columns.push({ col_idx: i, col, payload: bytes });
      }
    }
  }

  const var_offset_table_size = var_columns.length * 4;
  const header_and_tables_size =
    3 + null_bitmap_bytes + fixed_slice_size + var_offset_table_size;

  let total_var_payload_size = 0;
  for (let i = 0; i < var_columns.length; i++) {
    const item = var_columns[i];
    if (item.payload) {
      total_var_payload_size += item.payload.byteLength;
    }
  }

  const total_row_size = header_and_tables_size + total_var_payload_size;
  if (total_row_size > MAX_ROW_SIZE) {
    throw new RowSizeLimitExceededError(total_row_size, MAX_ROW_SIZE);
  }

  const row_buffer = new Uint8Array(total_row_size);
  const row_view = new DataView(row_buffer.buffer);

  // [0]: Flags (0x01 = Active)
  row_view.setUint8(0, 0x01);
  // [1..2]: Stored Row _length
  row_view.setUint16(1, total_row_size, true);
  // [3..]: _null-_bitmap
  row_buffer.set(null_bitmap, 3);

  let current_fixed_offset = 3 + null_bitmap_bytes;
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const is_null = (null_bitmap[i >> 3] & (1 << (i & 7))) !== 0;
    if (!is_null) {
      const val = values[col.name];
      switch (col.type) {
        case DataType.INT32:
          row_view.setInt32(current_fixed_offset, Number(val), true);
          current_fixed_offset += 4;
          break;
        case DataType.INT64:
          row_view.setBigInt64(current_fixed_offset, BigInt(val as any), true);
          current_fixed_offset += 8;
          break;
        case DataType.FLOAT64:
          row_view.setFloat64(current_fixed_offset, Number(val), true);
          current_fixed_offset += 8;
          break;
        case DataType.UUID:
          UuidCodec.encode(String(val), row_buffer, current_fixed_offset);
          current_fixed_offset += 16;
          break;
        case DataType.ULID:
          UlidCodec.encode(String(val), row_buffer, current_fixed_offset);
          current_fixed_offset += 16;
          break;
      }
    }
  }

  // Write var-offset table and payloads
  let current_var_table_offset = current_fixed_offset;
  let current_payload_offset = header_and_tables_size;

  for (let i = 0; i < var_columns.length; i++) {
    const item = var_columns[i];
    if (item.payload === null) {
      // _null column: rel_offset 0, length 0
      row_view.setUint16(current_var_table_offset, 0, true);
      row_view.setUint16(current_var_table_offset + 2, 0, true);
    } else {
      row_view.setUint16(
        current_var_table_offset,
        current_payload_offset,
        true,
      );
      row_view.setUint16(
        current_var_table_offset + 2,
        item.payload.byteLength,
        true,
      );
      row_buffer.set(item.payload, current_payload_offset);
      current_payload_offset += item.payload.byteLength;
    }
    current_var_table_offset += 4;
  }

  return row_buffer;
}

/**
 * @export_c
 * Deserializes a row record from a DataView into a user-facing DbRow object.
 */
export function page_deserialize_row(
  arg1: TableMeta | ColumnMeta[] | DataView,
  arg2: DataView | number,
  arg3?: number | TableMeta | ColumnMeta[],
): DbRow {
  let columns: ColumnMeta[];
  let view: DataView;
  let record_offset: number;

  if (arg1 instanceof DataView) {
    view = arg1;
    record_offset = arg2 as number;
    const table_or_cols = arg3 as TableMeta | ColumnMeta[];
    columns = Array.isArray(table_or_cols)
      ? table_or_cols
      : (table_or_cols as TableMeta).columns;
  } else {
    columns = Array.isArray(arg1) ? arg1 : (arg1 as TableMeta).columns;
    view = arg2 as DataView;
    record_offset = arg3 as number;
  }

  const row: DbRow = {};
  const col_count = columns.length;
  const null_bitmap_bytes = Math.ceil(col_count / 8);

  const null_bitmap = new Uint8Array(
    view.buffer,
    view.byteOffset + record_offset + 3,
    null_bitmap_bytes,
  );

  let current_fixed_offset = record_offset + 3 + null_bitmap_bytes;

  // Track var-column index
  let var_col_idx = 0;
  // Calculate where the var-offset table starts
  // We need to advance fixed offset for non-null fixed columns
  const fixed_start = current_fixed_offset;
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const is_null = (null_bitmap[i >> 3] & (1 << (i & 7))) !== 0;
    if (!is_null) {
      switch (col.type) {
        case DataType.INT32:
          current_fixed_offset += 4;
          break;
        case DataType.INT64:
        case DataType.FLOAT64:
          current_fixed_offset += 8;
          break;
        case DataType.UUID:
        case DataType.ULID:
          current_fixed_offset += 16;
          break;
      }
    }
  }

  const var_offset_table_start = current_fixed_offset;
  current_fixed_offset = fixed_start;

  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const is_null = (null_bitmap[i >> 3] & (1 << (i & 7))) !== 0;

    if (is_null) {
      row[col.name] = null;
      if (col.type === DataType.TEXT || col.type === DataType.BLOB) {
        var_col_idx++;
      }
      continue;
    }

    switch (col.type) {
      case DataType.INT32:
        row[col.name] = view.getInt32(current_fixed_offset, true);
        current_fixed_offset += 4;
        break;
      case DataType.INT64:
        row[col.name] = view.getBigInt64(current_fixed_offset, true);
        current_fixed_offset += 8;
        break;
      case DataType.FLOAT64:
        row[col.name] = view.getFloat64(current_fixed_offset, true);
        current_fixed_offset += 8;
        break;
      case DataType.UUID: {
        const slice = new Uint8Array(
          view.buffer,
          view.byteOffset + current_fixed_offset,
          16,
        );
        row[col.name] = UuidCodec.decode(slice, 0);
        current_fixed_offset += 16;
        break;
      }
      case DataType.ULID: {
        const slice = new Uint8Array(
          view.buffer,
          view.byteOffset + current_fixed_offset,
          16,
        );
        row[col.name] = UlidCodec.decode(slice, 0);
        current_fixed_offset += 16;
        break;
      }
      case DataType.TEXT: {
        const table_entry_offset = var_offset_table_start + var_col_idx * 4;
        const rel_offset = view.getUint16(table_entry_offset, true);
        const len = view.getUint16(table_entry_offset + 2, true);
        const payload_offset = view.byteOffset + record_offset + rel_offset;
        const text_bytes = new Uint8Array(view.buffer, payload_offset, len);
        row[col.name] = text_decoder.decode(text_bytes);
        var_col_idx++;
        break;
      }
      case DataType.BLOB: {
        const table_entry_offset = var_offset_table_start + var_col_idx * 4;
        const rel_offset = view.getUint16(table_entry_offset, true);
        const len = view.getUint16(table_entry_offset + 2, true);
        const payload_offset = view.byteOffset + record_offset + rel_offset;
        const blob_bytes = new Uint8Array(len);
        blob_bytes.set(new Uint8Array(view.buffer, payload_offset, len));
        row[col.name] = blob_bytes;
        var_col_idx++;
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
 * Initializes a Table Interior Page with right_child_page_id.
 */
export function page_init_interior(
  view: DataView,
  page_offset: number,
  right_child_page_id: number = 0,
): void {
  page_init(view, page_offset, PAGE_TYPE_TABLE_INTERIOR, right_child_page_id);
}

/**
 * @export_c
 * Returns right child page ID of a Table Interior Page.
 */
export function page_get_right_child_page_id(
  view: DataView,
  page_offset: number,
): number {
  return view.getUint32(page_offset + 6, true);
}

/**
 * @export_c
 * Sets right child page ID of a Table Interior Page.
 */
export function page_set_right_child_page_id(
  view: DataView,
  page_offset: number,
  right_child_page_id: number,
): void {
  view.setUint32(page_offset + 6, right_child_page_id, true);
}

/**
 * @export_c
 * Inserts a 12-byte routing cell into a Table Interior Page.
 * Returns new cell count or -1 if page has reached max entries (291 entries).
 */
export function page_insert_interior_cell(
  view: DataView,
  page_offset: number,
  child_page_id: number,
  rowid: bigint,
): number {
  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_count >= MAX_TABLE_INTERIOR_CELLS) {
    return -1; // Interior page full
  }

  const content_offset = page_get_cell_content_offset(view, page_offset);
  const new_content_offset = content_offset - TABLE_INTERIOR_CELL_SIZE;

  // Write 12-byte cell payload
  const target_offset = page_offset + new_content_offset;
  view.setUint32(target_offset, child_page_id, true);
  view.setBigInt64(target_offset + 4, rowid, true);

  // Write slot directory entry
  page_set_cell_offset(view, page_offset, cell_count, new_content_offset);

  page_set_cell_count(view, page_offset, cell_count + 1);
  page_set_cell_content_offset(view, page_offset, new_content_offset);

  return cell_count + 1;
}

/**
 * @export_c
 * Performs binary search on a Table Interior Page to route traversal for target_row_id.
 * Returns the child_page_id to traverse.
 */
export function page_binary_search_interior(
  view: DataView,
  page_offset: number,
  target_row_id: bigint,
): number {
  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_count === 0) {
    return page_get_right_child_page_id(view, page_offset);
  }

  let lo = 0;
  let hi = cell_count - 1;
  let candidate_child = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cell_offset = page_get_cell_offset(view, page_offset, mid);
    const cell_rowid = view.getBigInt64(page_offset + cell_offset + 4, true);

    if (target_row_id <= cell_rowid) {
      candidate_child = view.getUint32(page_offset + cell_offset, true);
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  if (candidate_child !== -1) {
    return candidate_child;
  }

  // If target_row_id > all keys on this page, follow right_child_page_id
  return page_get_right_child_page_id(view, page_offset);
}

/**
 * @export_c
 * Splits a Table Interior Page at median entry (index 145), promoting the median key.
 */
export function page_split_interior(
  view: DataView,
  page_offset: number,
  new_page_offset: number,
): {
  median_rowid: bigint;
  promoted_child_page_id: number;
  right_child_page_id: number;
} {
  const cell_count = page_get_cell_count(view, page_offset);
  const median_idx = TABLE_INTERIOR_SPLIT_INDEX; // 145

  if (cell_count <= median_idx) {
    throw new Error(`Cannot split interior page with only ${cell_count} cells`);
  }

  // Read median cell
  const median_cell_offset = page_get_cell_offset(
    view,
    page_offset,
    median_idx,
  );
  const promoted_child_page_id = view.getUint32(
    page_offset + median_cell_offset,
    true,
  );
  const median_rowid = view.getBigInt64(
    page_offset + median_cell_offset + 4,
    true,
  );

  // Initialize right sibling interior page
  const old_right_child = page_get_right_child_page_id(view, page_offset);
  page_init_interior(view, new_page_offset, old_right_child);

  // Copy entries 146..cell_count-1 to new sibling page
  for (let i = median_idx + 1; i < cell_count; i++) {
    const offset = page_get_cell_offset(view, page_offset, i);
    const child_id = view.getUint32(page_offset + offset, true);
    const r_id = view.getBigInt64(page_offset + offset + 4, true);
    page_insert_interior_cell(view, new_page_offset, child_id, r_id);
  }

  // Left page keeps entries 0..144, and its right_child_page_id becomes median's child_page_id
  page_set_right_child_page_id(view, page_offset, promoted_child_page_id);
  page_set_cell_count(view, page_offset, median_idx);

  return {
    median_rowid,
    promoted_child_page_id,
    right_child_page_id: old_right_child,
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
  page_offset: number,
  next_page_id: number = 0,
): void {
  page_init(view, page_offset, PAGE_TYPE_INDEX_LEAF, next_page_id);
}

/**
 * @export_c
 * Compares two index keys according to SQLite 3VL collation order:
 * NULL < -Infinity < Numbers < TEXT (UTF-8) < BLOB
 */
export function page_compare_index_keys(
  type_a: DataType,
  val_a: any,
  rowid_a: bigint,
  type_b: DataType,
  val_b: any,
  rowid_b: bigint,
): number {
  if (type_a !== type_b) {
    // 3VL collation precedence order
    return type_a - type_b;
  }

  if (type_a === DataType.NULL) {
    return rowid_a < rowid_b ? -1 : rowid_a > rowid_b ? 1 : 0;
  }

  let diff = 0;
  if (
    type_a === DataType.INT32 ||
    type_a === DataType.INT64 ||
    type_a === DataType.FLOAT64
  ) {
    const num_a = typeof val_a === "bigint" ? Number(val_a) : val_a;
    const num_b = typeof val_b === "bigint" ? Number(val_b) : val_b;
    diff = num_a < num_b ? -1 : num_a > num_b ? 1 : 0;
  } else if (
    type_a === DataType.TEXT ||
    type_a === DataType.UUID ||
    type_a === DataType.ULID
  ) {
    const str_a = String(val_a);
    const str_b = String(val_b);
    diff = str_a < str_b ? -1 : str_a > str_b ? 1 : 0;
  } else if (type_a === DataType.BLOB) {
    const b_a = val_a as Uint8Array;
    const b_b = val_b as Uint8Array;
    const min_len = Math.min(b_a.length, b_b.length);
    for (let i = 0; i < min_len; i++) {
      if (b_a[i] !== b_b[i]) {
        diff = b_a[i] < b_b[i] ? -1 : 1;
        break;
      }
    }
    if (diff === 0) {
      diff = b_a.length - b_b.length;
    }
  }

  if (diff !== 0) return diff;
  return rowid_a < rowid_b ? -1 : rowid_a > rowid_b ? 1 : 0;
}

function page_decode_index_cell(
  view: DataView,
  cell_data_offset: number,
  k_len: number,
  context_type: DataType,
): { cellType: DataType; cellVal: any } {
  const k_data = new Uint8Array(
    view.buffer,
    view.byteOffset + cell_data_offset,
    k_len,
  );
  if (k_len === 0) {
    return { cellType: DataType.NULL, cellVal: null };
  }
  if (context_type === DataType.TEXT) {
    if (
      k_len === 4 &&
      ((k_data[2] === 0 && k_data[3] === 0) ||
        (k_data[2] === 0xff && k_data[3] === 0xff))
    ) {
      return {
        cellType: DataType.INT32,
        cellVal: new DataView(k_data.buffer, k_data.byteOffset).getInt32(
          0,
          true,
        ),
      };
    }
    if (k_len === 2 && k_data[0] < 32 && k_data[1] < 32) {
      return { cellType: DataType.BLOB, cellVal: k_data };
    }
    return { cellType: DataType.TEXT, cellVal: text_decoder.decode(k_data) };
  }
  if (k_len === 2) {
    return { cellType: DataType.BLOB, cellVal: k_data };
  }
  if (k_len === 4) {
    return {
      cellType: DataType.INT32,
      cellVal: new DataView(k_data.buffer, k_data.byteOffset).getInt32(0, true),
    };
  }
  if (context_type === DataType.UUID && k_len === 16) {
    return { cellType: DataType.UUID, cellVal: UuidCodec.decode(k_data, 0) };
  }
  if (context_type === DataType.ULID && k_len === 16) {
    return { cellType: DataType.ULID, cellVal: UlidCodec.decode(k_data, 0) };
  }
  if (context_type === DataType.FLOAT64 && k_len === 8) {
    return {
      cellType: DataType.FLOAT64,
      cellVal: new DataView(k_data.buffer, k_data.byteOffset).getFloat64(
        0,
        true,
      ),
    };
  }
  if (context_type === DataType.INT64 && k_len === 8) {
    return {
      cellType: DataType.INT64,
      cellVal: new DataView(k_data.buffer, k_data.byteOffset).getBigInt64(
        0,
        true,
      ),
    };
  }
  if (context_type === DataType.BLOB) {
    if (k_len === 5 || k_len === 6) {
      return { cellType: DataType.TEXT, cellVal: text_decoder.decode(k_data) };
    }
    return { cellType: DataType.BLOB, cellVal: k_data };
  }
  return { cellType: DataType.TEXT, cellVal: text_decoder.decode(k_data) };
}

/**
 * @export_c
 * Inserts a key and rowid into a Secondary Index Leaf Page, maintaining sorted slot directory.
 */
export function page_insert_index_leaf_cell(
  view: DataView,
  page_offset: number,
  key_type: DataType,
  key_value: any,
  rowid: bigint,
  scratchpad_offset?: number,
): number {
  let key_bytes: Uint8Array;
  if (
    key_type === DataType.NULL ||
    key_value === null ||
    key_value === undefined
  ) {
    key_bytes = new Uint8Array(0);
  } else if (key_type === DataType.INT32) {
    key_bytes = new Uint8Array(4);
    new DataView(key_bytes.buffer).setInt32(0, Number(key_value), true);
  } else if (key_type === DataType.INT64) {
    key_bytes = new Uint8Array(8);
    new DataView(key_bytes.buffer).setBigInt64(0, BigInt(key_value), true);
  } else if (key_type === DataType.FLOAT64) {
    key_bytes = new Uint8Array(8);
    new DataView(key_bytes.buffer).setFloat64(0, Number(key_value), true);
  } else if (key_type === DataType.UUID) {
    key_bytes = new Uint8Array(16);
    UuidCodec.encode(String(key_value), key_bytes, 0);
  } else if (key_type === DataType.ULID) {
    key_bytes = new Uint8Array(16);
    UlidCodec.encode(String(key_value), key_bytes, 0);
  } else if (key_type === DataType.TEXT) {
    key_bytes = text_encoder.encode(String(key_value));
  } else {
    key_bytes =
      key_value instanceof Uint8Array ? key_value : new Uint8Array(key_value);
  }

  // Cell format: [key_len uint16][key_data][rowid int64]
  const cell_length = 2 + key_bytes.byteLength + 8;
  const needed_bytes = cell_length + 2; // + 2B slot directory entry

  const cell_count = page_get_cell_count(view, page_offset);
  const contiguous_free = page_get_contiguous_free_space(view, page_offset);
  const total_free = contiguous_free + page_get_free_bytes(view, page_offset);

  if (needed_bytes > total_free) {
    return -1; // Index leaf full
  }

  if (needed_bytes > contiguous_free) {
    page_compact(view, page_offset, scratchpad_offset);
  }

  const content_offset = page_get_cell_content_offset(view, page_offset);
  const new_content_offset = content_offset - cell_length;
  const target_offset = page_offset + new_content_offset;

  // Write cell
  const abs_target = view.byteOffset + target_offset;
  view.setUint16(target_offset, key_bytes.byteLength, true);
  new Uint8Array(view.buffer).set(key_bytes, abs_target + 2);
  view.setBigInt64(target_offset + 2 + key_bytes.byteLength, rowid, true);

  // Binary search to find sorted insertion slot index
  let lo = 0;
  let hi = cell_count - 1;
  let insert_slot = cell_count;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const offset = page_get_cell_offset(view, page_offset, mid);
    const existing_k_len = view.getUint16(page_offset + offset, true);
    const r_id = view.getBigInt64(
      page_offset + offset + 2 + existing_k_len,
      true,
    );
    const { cellType: mid_type, cellVal: mid_val } = page_decode_index_cell(
      view,
      page_offset + offset + 2,
      existing_k_len,
      key_type,
    );

    const cmp = page_compare_index_keys(
      key_type,
      key_value,
      rowid,
      mid_type,
      mid_val,
      r_id,
    );
    if (cmp < 0) {
      insert_slot = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // Shift slot directory entries from insert_slot right by 2 bytes
  const uint8 = new Uint8Array(view.buffer);
  const abs_page_start = view.byteOffset + page_offset;
  const slot_dir_start = abs_page_start + PAGE_HEADER_SIZE;
  const src = slot_dir_start + insert_slot * 2;
  const dst = slot_dir_start + (insert_slot + 1) * 2;
  const shift_len = (cell_count - insert_slot) * 2;

  if (shift_len > 0) {
    uint8.copyWithin(dst, src, src + shift_len);
  }

  // Write new slot entry
  page_set_cell_offset(view, page_offset, insert_slot, new_content_offset);

  page_set_cell_count(view, page_offset, cell_count + 1);
  page_set_cell_content_offset(view, page_offset, new_content_offset);

  return insert_slot;
}

/**
 * @export_c
 * Binary searches an Index Leaf Page for target key and optional rowid.
 */
export function page_binary_search_index_leaf(
  view: DataView,
  page_offset: number,
  target_type: DataType,
  target_value: any,
  target_row_id?: bigint,
): { found: boolean; slot_idx: number } {
  const cell_count = page_get_cell_count(view, page_offset);
  let lo = 0;
  let hi = cell_count - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const offset = page_get_cell_offset(view, page_offset, mid);
    const k_len = view.getUint16(page_offset + offset, true);
    const r_id = view.getBigInt64(page_offset + offset + 2 + k_len, true);
    const { cellType: mid_type, cellVal: mid_val } = page_decode_index_cell(
      view,
      page_offset + offset + 2,
      k_len,
      target_type,
    );

    const rowid_to_compare = target_row_id !== undefined ? target_row_id : r_id;
    const cmp = page_compare_index_keys(
      target_type,
      target_value,
      rowid_to_compare,
      mid_type,
      mid_val,
      r_id,
    );

    if (cmp === 0) {
      if (target_row_id === undefined) {
        let first_slot = mid;
        while (first_slot > 0) {
          const prev_slot = first_slot - 1;
          const prev_offset = page_get_cell_offset(view, page_offset, prev_slot);
          const prev_k_len = view.getUint16(page_offset + prev_offset, true);
          const { cellType: prev_type, cellVal: prev_val } = page_decode_index_cell(
            view,
            page_offset + prev_offset + 2,
            prev_k_len,
            target_type,
          );
          if (
            page_compare_index_keys(
              target_type,
              target_value,
              0n,
              prev_type,
              prev_val,
              0n,
            ) === 0
          ) {
            first_slot = prev_slot;
          } else {
            break;
          }
        }
        return { found: true, slot_idx: first_slot };
      }
      return { found: true, slot_idx: mid };
    } else if (cmp < 0) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return { found: false, slot_idx: lo };
}

/**
 * @export_c
 * Encodes a single column value to a byte array based on its DataType.
 */
export function serialize_single_key(type: DataType, val: any): Uint8Array {
  if (val === null || val === undefined) {
    return new Uint8Array(0);
  }
  if (type === DataType.INT32) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, Number(val), true);
    return b;
  }
  if (type === DataType.INT64) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(val), true);
    return b;
  }
  if (type === DataType.FLOAT64) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, Number(val), true);
    return b;
  }
  if (type === DataType.UUID) {
    const b = new Uint8Array(16);
    UuidCodec.encode(String(val), b, 0);
    return b;
  }
  if (type === DataType.ULID) {
    const b = new Uint8Array(16);
    UlidCodec.encode(String(val), b, 0);
    return b;
  }
  if (type === DataType.TEXT) {
    return text_encoder.encode(String(val));
  }
  return val instanceof Uint8Array ? val : new Uint8Array(val);
}

/**
 * @export_c
 * Serializes a composite key tuple into a deterministic, comparable binary buffer.
 */
export function serialize_composite_key(
  columns: ColumnMeta[],
  col_indices: number[],
  col_count: number,
  row: DbRow,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let total_len = 0;
  for (let i = 0; i < col_count; i++) {
    const col = columns[col_indices[i]];
    const val = row[col.name];
    const encoded = serialize_single_key(col.type, val);
    const part = new Uint8Array(1 + 2 + encoded.byteLength);
    part[0] = col.type;
    part[1] = encoded.byteLength & 0xff;
    part[2] = (encoded.byteLength >> 8) & 0xff;
    part.set(encoded, 3);
    parts.push(part);
    total_len += part.byteLength;
  }
  const result = new Uint8Array(total_len);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    result.set(p, offset);
    offset += p.byteLength;
  }
  return result;
}

