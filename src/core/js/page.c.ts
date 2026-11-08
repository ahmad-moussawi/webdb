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
  PAGE_SCRATCHPAD_OFFSET,
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
import type { u8, u16, u32, i32, i64, f64 } from "../types.ts";
import {
  memcpy,
  read_u8,
  read_u16,
  write_u16,
  read_i32,
  write_i32,
  read_i64,
  write_i64,
  read_f64,
  write_f64,
  i64_to_f64,
  f64_to_i32,
} from "../../shared/c_runtime.ts";

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

// Pre-allocated scratch buffers for zero-intermediate-allocation JS operations
const _compactScratchBuf = new Uint8Array(PAGE_SIZE);
const _compactScratchView = new DataView(_compactScratchBuf.buffer);
const _rowScratchBuf = new Uint8Array(8192);
const _rowScratchView = new DataView(_rowScratchBuf.buffer);
const _keyScratchBuf = new Uint8Array(4096);
const _keyScratchView = new DataView(_keyScratchBuf.buffer);

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
  page_offset: u32,
  page_type: u8 = PAGE_TYPE_LEAF_DATA,
  next_page_id: u32 = 0,
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
  page_offset: u32,
  next_free_page_id: u32 = 0,
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
export function page_get_type(view: DataView, page_offset: u32): u8 {
  return view.getUint8(page_offset + 0);
}

/**
 * @export_c
 * Sets the page type byte in a page header.
 */
export function page_set_type(
  view: DataView,
  page_offset: u32,
  type: u8,
): void {
  view.setUint8(page_offset + 0, type);
}

/**
 * @export_c
 * Returns the number of cells in the page slot directory.
 */
export function page_get_cell_count(
  view: DataView,
  page_offset: u32,
): u16 {
  return view.getUint16(page_offset + 2, true);
}

/**
 * @export_c
 * Sets the number of cells in the page slot directory.
 */
export function page_set_cell_count(
  view: DataView,
  page_offset: u32,
  count: u16,
): void {
  view.setUint16(page_offset + 2, count, true);
}

/**
 * @export_c
 * Returns the byte offset within the page where active cell payloads begin.
 */
export function page_get_cell_content_offset(
  view: DataView,
  page_offset: u32,
): u16 {
  return view.getUint16(page_offset + 4, true);
}

/**
 * @export_c
 * Sets the byte offset within the page where active cell payloads begin.
 */
export function page_set_cell_content_offset(
  view: DataView,
  page_offset: u32,
  offset: u16,
): void {
  view.setUint16(page_offset + 4, offset, true);
}

/**
 * @export_c
 * Returns the next page ID (or right child page ID) stored in the page header.
 */
export function page_get_next_page_id(
  view: DataView,
  page_offset: u32,
): u32 {
  return view.getUint32(page_offset + 6, true);
}

/**
 * @export_c
 * Sets the next page ID (or right child page ID) stored in the page header.
 */
export function page_set_next_page_id(
  view: DataView,
  page_offset: u32,
  next_page_id: u32,
): void {
  view.setUint32(page_offset + 6, next_page_id, true);
}

/**
 * @export_c
 * Returns cumulative fragmented unallocated bytes in the page.
 */
export function page_get_free_bytes(
  view: DataView,
  page_offset: u32,
): u16 {
  return view.getUint16(page_offset + 10, true);
}

/**
 * @export_c
 * Sets cumulative fragmented unallocated bytes in the page.
 */
export function page_set_free_bytes(
  view: DataView,
  page_offset: u32,
  free_bytes: u16,
): void {
  view.setUint16(page_offset + 10, free_bytes, true);
}

/**
 * @export_c
 * Returns the checksum stored at bytes 12..15 in the page header.
 */
export function page_get_checksum(view: DataView, page_offset: u32): u32 {
  return view.getUint32(page_offset + PAGE_HEADER_OFFSET_CHECKSUM, true);
}

/**
 * @export_c
 * Sets the checksum stored at bytes 12..15 in the page header.
 */
export function page_set_checksum(
  view: DataView,
  page_offset: u32,
  checksum: u32,
): void {
  view.setUint32(page_offset + PAGE_HEADER_OFFSET_CHECKSUM, checksum, true);
}

/**
 * @export_c
 * Returns the cell payload offset for the given slot directory index.
 */
export function page_get_cell_offset(
  view: DataView,
  page_offset: u32,
  slot_idx: u16,
): u16 {
  const slot_dir_offset = page_offset + PAGE_HEADER_SIZE + slot_idx * 2;
  return view.getUint16(slot_dir_offset, true);
}

/**
 * @export_c
 * Sets the cell payload offset for the given slot directory index.
 */
export function page_set_cell_offset(
  view: DataView,
  page_offset: u32,
  slot_idx: u16,
  cell_offset: u16,
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
  page_offset: u32,
): u16 {
  const cell_count = page_get_cell_count(view, page_offset);
  const cell_content_offset = page_get_cell_content_offset(view, page_offset);
  const slot_dir_end = PAGE_HEADER_SIZE + cell_count * 2;
  return (cell_content_offset - slot_dir_end) as u16;
}

/**
 * @export_c
 * Returns total free space on the page (contiguous + fragmented free_bytes).
 */
export function page_get_total_free_space(
  view: DataView,
  page_offset: u32,
): u16 {
  return (
    page_get_contiguous_free_space(view, page_offset) +
    page_get_free_bytes(view, page_offset)
  ) as u16;
}

// ============================================================================
// 2. In-Place Page Compaction / Defragmentation (Zero-Allocation via Scratchpad)
// ============================================================================

/**
 * @export_c
 * Defragments a slotted data or index leaf page in linear memory using a 4KB staging scratchpad.
 */
export function page_compact_raw(
  view: DataView,
  page_offset: u32,
  scratchpad_offset: u32,
): void {
  const cell_count: u16 = page_get_cell_count(view, page_offset);
  if (cell_count === 0) {
    page_set_cell_content_offset(view, page_offset, PAGE_SIZE);
    page_set_free_bytes(view, page_offset, 0);
    return;
  }

  const scratch: u32 =
    scratchpad_offset === 0 || scratchpad_offset === page_offset
      ? PAGE_SCRATCHPAD_OFFSET
      : scratchpad_offset;

  // 1. Copy page header to scratchpad
  memcpy(view, scratch, view, page_offset, PAGE_HEADER_SIZE);

  // 2. Repack cells from end of page (PAGE_SIZE) downwards
  let current_offset: u16 = PAGE_SIZE;
  const p_type: u8 = page_get_type(view, page_offset);

  for (let i: u32 = 0; i < cell_count; i++) {
    const old_offset: u16 = page_get_cell_offset(view, page_offset, i as u16);
    let len: u16 = 0;
    if (p_type === PAGE_TYPE_INDEX_LEAF) {
      const k_len: u16 = read_u16(view, page_offset + old_offset);
      len = (2 + k_len + 8) as u16;
    } else {
      len = page_get_row_length(view, page_offset + old_offset);
    }

    current_offset = (current_offset - len) as u16;
    memcpy(view, scratch + current_offset, view, page_offset + old_offset, len);
    page_set_cell_offset(view, scratch, i as u16, current_offset);
  }

  // 3. Update scratchpad header fields
  page_set_cell_content_offset(view, scratch, current_offset);
  page_set_free_bytes(view, scratch, 0);

  // 4. Copy back to page
  memcpy(view, page_offset, view, scratch, PAGE_SIZE);
}

/**
 * Defragments a slotted data page using a 4KB staging scratchpad.
 * Collapses fragmented holes to the bottom, rewrites slot directory entries,
 * and sets free_bytes to 0.
 */
export function page_compact(
  view: DataView,
  page_offset: u32,
  scratchpad_offset: u32 = 0,
  replacement?: { cell_idx: number; row_bytes: Uint8Array },
): void {
  if (
    !replacement &&
    scratchpad_offset > 0 &&
    scratchpad_offset !== page_offset &&
    scratchpad_offset + PAGE_SIZE <= view.byteLength
  ) {
    page_compact_raw(view, page_offset, scratchpad_offset);
    return;
  }

  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_count === 0) {
    page_set_cell_content_offset(view, page_offset, PAGE_SIZE);
    page_set_free_bytes(view, page_offset, 0);
    return;
  }

  // If no external scratchpad provided or buffer too small, use pre-allocated 4KB scratchpad
  let scratch_view: DataView = view;
  let scratch: u32 = scratchpad_offset;

  if (
    scratchpad_offset === 0 ||
    scratchpad_offset === page_offset ||
    scratchpad_offset + PAGE_SIZE > view.byteLength
  ) {
    scratch_view = _compactScratchView;
    scratch = 0;
  }

  // 1. Copy page header to scratchpad
  memcpy(scratch_view, scratch, view, page_offset, PAGE_HEADER_SIZE);

  // 2. Repack cells from end of page (PAGE_SIZE) downwards
  let current_offset: u16 = PAGE_SIZE;
  const p_type = page_get_type(view, page_offset);

  for (let i = 0; i < cell_count; i++) {
    let len: u16 = 0;
    let src_view: DataView | Uint8Array = view;
    let src_bytes: u32 = 0;

    if (replacement && i === replacement.cell_idx) {
      len = replacement.row_bytes.byteLength as u16;
      src_view = replacement.row_bytes;
      src_bytes = 0;
    } else {
      const old_offset = page_get_cell_offset(view, page_offset, i as u16);
      if (p_type === PAGE_TYPE_INDEX_LEAF) {
        const k_len = view.getUint16(page_offset + old_offset, true);
        len = (2 + k_len + 8) as u16;
      } else {
        len = page_get_row_length(view, page_offset + old_offset);
      }
      src_view = view;
      src_bytes = page_offset + old_offset;
    }

    current_offset = (current_offset - len) as u16;
    memcpy(scratch_view, scratch + current_offset, src_view, src_bytes, len);

    // Update slot directory in scratchpad
    page_set_cell_offset(scratch_view, scratch, i as u16, current_offset);
  }

  // 3. Update scratchpad header fields
  page_set_cell_content_offset(scratch_view, scratch, current_offset);
  page_set_free_bytes(scratch_view, scratch, 0);

  // 4. Copy back to page
  memcpy(view, page_offset, scratch_view, scratch, PAGE_SIZE);
}

/**
 * @export_c
 * Calculates row length in bytes from the serialized row at row_offset.
 */
export function page_get_row_length(
  view: DataView,
  row_abs_offset: u32,
): u16 {
  return view.getUint16(row_abs_offset + 1, true);
}

// ============================================================================
// 3. Row Insert, Delete, and Update Mechanics
// ============================================================================

/**
 * @export_c
 * Inserts a serialized row record located in linear memory at row_src_offset (of length row_len)
 * into a slotted data page at page_offset.
 * Returns the slot index (0-indexed) or -1 if the row cannot fit in this page.
 */
export function page_insert_row_raw(
  view: DataView,
  page_offset: u32,
  row_src_offset: u32,
  row_len: u16,
  scratchpad_offset: u32,
): i32 {
  const cell_count: u16 = page_get_cell_count(view, page_offset);
  const cell_content_offset: u16 = page_get_cell_content_offset(view, page_offset);
  const needed_bytes: u32 = row_len + 2;

  const slot_dir_end: u32 = PAGE_HEADER_SIZE + cell_count * 2;
  const contiguous_free: u32 = cell_content_offset - slot_dir_end;
  const total_free: u32 = contiguous_free + page_get_free_bytes(view, page_offset);

  if (needed_bytes > total_free) {
    return -1;
  }

  if (needed_bytes > contiguous_free) {
    page_compact_raw(view, page_offset, scratchpad_offset);
  }

  const current_content_offset: u16 = page_get_cell_content_offset(
    view,
    page_offset,
  );
  const current_cell_count: u16 = page_get_cell_count(view, page_offset);

  const new_content_offset: u16 = (current_content_offset - row_len) as u16;
  memcpy(view, page_offset + new_content_offset, view, row_src_offset, row_len);

  page_set_cell_offset(
    view,
    page_offset,
    current_cell_count,
    new_content_offset,
  );
  page_set_cell_count(view, page_offset, (current_cell_count + 1) as u16);
  page_set_cell_content_offset(view, page_offset, new_content_offset);

  return current_cell_count as i32;
}

/**
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
  memcpy(
    view,
    page_offset + new_content_offset,
    row_bytes,
    0,
    row_bytes.byteLength,
  );

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
  page_offset: u32,
  cell_idx: u16,
): void {
  const cell_count = page_get_cell_count(view, page_offset);
  if (cell_idx >= cell_count) {
    return;
  }

  const offset = page_get_cell_offset(view, page_offset, cell_idx);
  const row_len = page_get_row_length(view, page_offset + offset);

  // Shift slot directory entries left by 2 bytes
  const slot_dir_start = page_offset + PAGE_HEADER_SIZE;
  const src = slot_dir_start + (cell_idx + 1) * 2;
  const dst = slot_dir_start + cell_idx * 2;
  const shift_length = (cell_count - 1 - cell_idx) * 2;

  if (shift_length > 0) {
    memcpy(view, dst, view, src, shift_length);
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

  const null_bitmap_bytes = (col_count + 7) >> 3;
  for (let b = 0; b < null_bitmap_bytes; b++) {
    _rowScratchBuf[3 + b] = 0;
  }

  // Pass 1: Validate NOT NULL constraints, populate null bitmap, and compute fixed/var sizes
  let fixed_slice_size = 0;
  let var_col_count = 0;
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const val = values[col.name];
    const is_null = val === null || val === undefined;
    const c_type = col.type;

    if (is_null) {
      if ((col.flags & ColumnFlag.NOT_NULL) !== 0) {
        throw new NotNullConstraintError(col.name);
      }
      _rowScratchBuf[3 + (i >> 3)] |= 1 << (i & 7);
      if (c_type === DataType.TEXT || c_type === DataType.BLOB) {
        var_col_count++;
      }
    } else {
      switch (c_type) {
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
        case DataType.TEXT:
        case DataType.BLOB:
          var_col_count++;
          break;
      }
    }
  }

  const var_offset_table_size = var_col_count << 2;
  const header_and_tables_size =
    3 + null_bitmap_bytes + fixed_slice_size + var_offset_table_size;
  if (header_and_tables_size > MAX_ROW_SIZE) {
    throw new RowSizeLimitExceededError(header_and_tables_size, MAX_ROW_SIZE);
  }

  let current_fixed_offset = 3 + null_bitmap_bytes;
  let current_var_table_offset = current_fixed_offset + fixed_slice_size;
  let current_payload_offset = header_and_tables_size;

  // Pass 2: Serialize fixed columns and variable-length columns directly into _rowScratchBuf
  for (let i = 0; i < col_count; i++) {
    const col = columns[i];
    const c_type = col.type;
    const is_null = (_rowScratchBuf[3 + (i >> 3)] & (1 << (i & 7))) !== 0;

    if (is_null) {
      if (c_type === DataType.TEXT || c_type === DataType.BLOB) {
        _rowScratchView.setUint16(current_var_table_offset, 0, true);
        _rowScratchView.setUint16(current_var_table_offset + 2, 0, true);
        current_var_table_offset += 4;
      }
      continue;
    }

    const val = values[col.name];
    switch (c_type) {
      case DataType.INT32:
        _rowScratchView.setInt32(current_fixed_offset, Number(val), true);
        current_fixed_offset += 4;
        break;
      case DataType.INT64:
        _rowScratchView.setBigInt64(
          current_fixed_offset,
          BigInt(val as any),
          true,
        );
        current_fixed_offset += 8;
        break;
      case DataType.FLOAT64:
        _rowScratchView.setFloat64(current_fixed_offset, Number(val), true);
        current_fixed_offset += 8;
        break;
      case DataType.UUID:
        UuidCodec.encode(String(val), _rowScratchBuf, current_fixed_offset);
        current_fixed_offset += 16;
        break;
      case DataType.ULID:
        UlidCodec.encode(String(val), _rowScratchBuf, current_fixed_offset);
        current_fixed_offset += 16;
        break;
      case DataType.TEXT: {
        const str = String(val ?? "");
        let byte_len = 0;
        if (str.length > 0) {
          if (current_payload_offset + str.length * 3 <= _rowScratchBuf.byteLength) {
            const res = text_encoder.encodeInto(
              str,
              _rowScratchBuf.subarray(current_payload_offset),
            );
            byte_len = res.written;
          } else {
            const encoded = text_encoder.encode(str);
            byte_len = encoded.byteLength;
            if (current_payload_offset + byte_len <= MAX_ROW_SIZE) {
              _rowScratchBuf.set(encoded, current_payload_offset);
            }
          }
        }
        if (current_payload_offset <= MAX_ROW_SIZE) {
          _rowScratchView.setUint16(
            current_var_table_offset,
            current_payload_offset,
            true,
          );
          _rowScratchView.setUint16(
            current_var_table_offset + 2,
            byte_len,
            true,
          );
        }
        current_payload_offset += byte_len;
        current_var_table_offset += 4;
        break;
      }
      case DataType.BLOB: {
        const bytes =
          val instanceof Uint8Array ? val : new Uint8Array(val as any);
        const byte_len = bytes.byteLength;
        if (current_payload_offset + byte_len <= MAX_ROW_SIZE) {
          _rowScratchView.setUint16(
            current_var_table_offset,
            current_payload_offset,
            true,
          );
          _rowScratchView.setUint16(
            current_var_table_offset + 2,
            byte_len,
            true,
          );
          _rowScratchBuf.set(bytes, current_payload_offset);
        }
        current_payload_offset += byte_len;
        current_var_table_offset += 4;
        break;
      }
    }
  }

  const total_row_size = current_payload_offset;
  if (total_row_size > MAX_ROW_SIZE) {
    throw new RowSizeLimitExceededError(total_row_size, MAX_ROW_SIZE);
  }

  // [0]: Flags (0x01 = Active)
  _rowScratchBuf[0] = 0x01;
  // [1..2]: Stored Row length
  _rowScratchView.setUint16(1, total_row_size, true);

  return _rowScratchBuf.slice(0, total_row_size);
}

/**
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
  const null_bitmap_bytes = (col_count + 7) >> 3;
  const bitmap_start = record_offset + 3;
  const fixed_start = bitmap_start + null_bitmap_bytes;

  if (record_offset < 0 || fixed_start > view.byteLength) {
    return null as any;
  }

  const record_flags = view.getUint8(record_offset);
  if ((record_flags & 0x01) === 0) {
    return null as any;
  }

  const record_length = view.getUint16(record_offset + 1, true);
  const record_end = record_offset + record_length;
  if (
    record_length < 3 + null_bitmap_bytes ||
    record_length > MAX_ROW_SIZE ||
    record_end > view.byteLength
  ) {
    return null as any;
  }

  // Calculate where the var-offset table starts without allocating a Uint8Array for null_bitmap
  let current_fixed_offset = fixed_start;
  let total_var_cols = 0;
  let cur_bitmap_byte = col_count > 0 ? view.getUint8(bitmap_start) : 0;
  for (let i = 0; i < col_count; i++) {
    if ((i & 7) === 0 && i > 0) {
      cur_bitmap_byte = view.getUint8(bitmap_start + (i >> 3));
    }
    const c_type = columns[i].type;
    if (c_type === DataType.TEXT || c_type === DataType.BLOB) {
      total_var_cols++;
    }
    if ((cur_bitmap_byte & (1 << (i & 7))) === 0) {
      if (c_type === DataType.INT32) current_fixed_offset += 4;
      else if (c_type === DataType.INT64 || c_type === DataType.FLOAT64)
        current_fixed_offset += 8;
      else if (c_type === DataType.UUID || c_type === DataType.ULID)
        current_fixed_offset += 16;
    }
  }

  const var_offset_table_start = current_fixed_offset;
  const var_offset_table_end = var_offset_table_start + (total_var_cols << 2);
  if (var_offset_table_end > record_end) {
    return null as any;
  }
  const min_payload_rel_offset = var_offset_table_end - record_offset;
  current_fixed_offset = fixed_start;

  let var_col_idx = 0;
  cur_bitmap_byte = col_count > 0 ? view.getUint8(bitmap_start) : 0;
  for (let i = 0; i < col_count; i++) {
    if ((i & 7) === 0 && i > 0) {
      cur_bitmap_byte = view.getUint8(bitmap_start + (i >> 3));
    }
    const col = columns[i];
    const c_type = col.type;
    const is_null = (cur_bitmap_byte & (1 << (i & 7))) !== 0;

    if (is_null) {
      row[col.name] = null;
      if (c_type === DataType.TEXT || c_type === DataType.BLOB) {
        var_col_idx++;
      }
      continue;
    }

    switch (c_type) {
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
        const table_entry_offset = var_offset_table_start + (var_col_idx << 2);
        const rel_offset = view.getUint16(table_entry_offset, true);
        const len = view.getUint16(table_entry_offset + 2, true);
        if (len === 0) {
          row[col.name] = "";
        } else {
          if (
            rel_offset < min_payload_rel_offset ||
            rel_offset + len > record_length ||
            record_offset + rel_offset + len > view.byteLength
          ) {
            return null as any;
          }
          const payload_offset = view.byteOffset + record_offset + rel_offset;
          const text_bytes = new Uint8Array(view.buffer, payload_offset, len);
          row[col.name] = text_decoder.decode(text_bytes);
        }
        var_col_idx++;
        break;
      }
      case DataType.BLOB: {
        const table_entry_offset = var_offset_table_start + (var_col_idx << 2);
        const rel_offset = view.getUint16(table_entry_offset, true);
        const len = view.getUint16(table_entry_offset + 2, true);
        if (
          len > 0 &&
          (rel_offset < min_payload_rel_offset ||
            rel_offset + len > record_length ||
            record_offset + rel_offset + len > view.byteLength)
        ) {
          return null as any;
        }
        const payload_offset = view.byteOffset + record_offset + rel_offset;
        const blob_bytes = new Uint8Array(len);
        if (len > 0) {
          blob_bytes.set(new Uint8Array(view.buffer, payload_offset, len));
        }
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
  page_offset: u32,
  right_child_page_id: u32 = 0,
): void {
  page_init(view, page_offset, PAGE_TYPE_TABLE_INTERIOR, right_child_page_id);
}

/**
 * @export_c
 * Returns right child page ID of a Table Interior Page.
 */
export function page_get_right_child_page_id(
  view: DataView,
  page_offset: u32,
): u32 {
  return view.getUint32(page_offset + 6, true);
}

/**
 * @export_c
 * Sets right child page ID of a Table Interior Page.
 */
export function page_set_right_child_page_id(
  view: DataView,
  page_offset: u32,
  right_child_page_id: u32,
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
  page_offset: u32,
  child_page_id: u32,
  rowid: i64,
): i32 {
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
  page_offset: u32,
  target_row_id: i64,
): u32 {
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
  page_offset: u32,
  next_page_id: u32 = 0,
): void {
  page_init(view, page_offset, PAGE_TYPE_INDEX_LEAF, next_page_id);
}

/**
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

/**
 * @export_c
 * Zero-allocation 3VL comparison between a target index key and a cell at cell_data_offset.
 * Returns <0 if target < cell, 0 if equal, >0 if target > cell.
 */
export function page_compare_index_cell_raw(
  view: DataView,
  cell_data_offset: u32,
  k_len: u16,
  cell_rowid: i64,
  context_type: u8,
  target_type: u8,
  target_f64: f64,
  target_bytes_off: u32,
  target_bytes_len: u16,
  target_rowid: i64,
): i32 {
  let mid_type: u8 = DataType.TEXT;
  let mid_f64: f64 = 0.0;

  if (k_len === 0) {
    mid_type = DataType.NULL;
  } else if (context_type === DataType.TEXT) {
    if (k_len === 4) {
      const b2: u8 = read_u8(view, cell_data_offset + 2);
      const b3: u8 = read_u8(view, cell_data_offset + 3);
      if ((b2 === 0 && b3 === 0) || (b2 === 0xff && b3 === 0xff)) {
        mid_type = DataType.INT32;
        mid_f64 = read_i32(view, cell_data_offset) as f64;
      } else {
        mid_type = DataType.TEXT;
      }
    } else if (
      k_len === 2 &&
      read_u8(view, cell_data_offset) < 32 &&
      read_u8(view, cell_data_offset + 1) < 32
    ) {
      mid_type = DataType.BLOB;
    } else {
      mid_type = DataType.TEXT;
    }
  } else if (k_len === 2) {
    mid_type = DataType.BLOB;
  } else if (k_len === 4) {
    mid_type = DataType.INT32;
    mid_f64 = read_i32(view, cell_data_offset) as f64;
  } else if (context_type === DataType.UUID && k_len === 16) {
    mid_type = DataType.UUID;
  } else if (context_type === DataType.ULID && k_len === 16) {
    mid_type = DataType.ULID;
  } else if (context_type === DataType.FLOAT64 && k_len === 8) {
    mid_type = DataType.FLOAT64;
    mid_f64 = read_f64(view, cell_data_offset);
  } else if (context_type === DataType.INT64 && k_len === 8) {
    mid_type = DataType.INT64;
    mid_f64 = i64_to_f64(read_i64(view, cell_data_offset));
  } else if (context_type === DataType.BLOB) {
    if (k_len === 5 || k_len === 6) {
      mid_type = DataType.TEXT;
    } else {
      mid_type = DataType.BLOB;
    }
  } else {
    mid_type = DataType.TEXT;
  }

  if (target_type !== mid_type) {
    return (target_type as i32) - (mid_type as i32);
  }

  if (target_type === DataType.NULL) {
    return target_rowid < cell_rowid ? -1 : target_rowid > cell_rowid ? 1 : 0;
  }

  let diff: i32 = 0;
  if (
    target_type === DataType.INT32 ||
    target_type === DataType.INT64 ||
    target_type === DataType.FLOAT64
  ) {
    diff = target_f64 < mid_f64 ? -1 : target_f64 > mid_f64 ? 1 : 0;
  } else {
    const min_len: u32 = target_bytes_len < k_len ? target_bytes_len : k_len;
    for (let i: u32 = 0; i < min_len; i++) {
      const ba: i32 = read_u8(view, target_bytes_off + i);
      const bb: i32 = read_u8(view, cell_data_offset + i);
      if (ba !== bb) {
        diff = ba < bb ? -1 : 1;
        break;
      }
    }
    if (diff === 0) {
      diff = (target_bytes_len as i32) - (k_len as i32);
    }
  }

  if (diff !== 0) return diff;
  return target_rowid < cell_rowid ? -1 : target_rowid > cell_rowid ? 1 : 0;
}

/**
 * @export_c
 * Inserts an index key and rowid into a Secondary Index Leaf Page in linear memory,
 * maintaining the sorted slot directory.
 */
export function page_insert_index_cell_raw(
  view: DataView,
  page_offset: u32,
  key_type: u8,
  key_i64: i64,
  key_f64: f64,
  key_src_offset: u32,
  key_len: u16,
  rowid: i64,
  scratchpad_offset: u32,
): i32 {
  const cell_length: u16 = (2 + key_len + 8) as u16;
  const needed_bytes: u32 = cell_length + 2;

  const cell_count: u16 = page_get_cell_count(view, page_offset);
  const contiguous_free: u32 = page_get_contiguous_free_space(view, page_offset);
  const total_free: u32 = contiguous_free + page_get_free_bytes(view, page_offset);

  if (needed_bytes > total_free) {
    return -1;
  }

  if (needed_bytes > contiguous_free) {
    page_compact_raw(view, page_offset, scratchpad_offset);
  }

  const content_offset: u16 = page_get_cell_content_offset(view, page_offset);
  const new_content_offset: u16 = (content_offset - cell_length) as u16;
  const target_offset: u32 = page_offset + new_content_offset;

  write_u16(view, target_offset, key_len);
  if (key_len > 0) {
    if (key_type === DataType.INT32) {
      write_i32(view, target_offset + 2, f64_to_i32(key_f64));
    } else if (key_type === DataType.INT64) {
      write_i64(view, target_offset + 2, key_i64);
    } else if (key_type === DataType.FLOAT64) {
      write_f64(view, target_offset + 2, key_f64);
    } else if (key_src_offset !== target_offset + 2) {
      memcpy(view, target_offset + 2, view, key_src_offset, key_len);
    }
  }
  write_i64(view, target_offset + 2 + key_len, rowid);

  // Binary search to find sorted insertion slot index
  let lo: i32 = 0;
  let hi: i32 = (cell_count as i32) - 1;
  let insert_slot: i32 = cell_count as i32;

  while (lo <= hi) {
    const mid: i32 = (lo + hi) >> 1;
    const offset: u16 = page_get_cell_offset(view, page_offset, mid as u16);
    const existing_k_len: u16 = read_u16(view, page_offset + offset);
    const r_id: i64 = read_i64(
      view,
      page_offset + offset + 2 + existing_k_len,
    );

    const cmp: i32 = page_compare_index_cell_raw(
      view,
      page_offset + offset + 2,
      existing_k_len,
      r_id,
      key_type,
      key_type,
      key_f64,
      target_offset + 2,
      key_len,
      rowid,
    );
    if (cmp < 0) {
      insert_slot = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  for (let s: i32 = (cell_count as i32) - 1; s >= insert_slot; s--) {
    const prev_off: u16 = page_get_cell_offset(view, page_offset, s as u16);
    page_set_cell_offset(view, page_offset, (s + 1) as u16, prev_off);
  }

  page_set_cell_offset(
    view,
    page_offset,
    insert_slot as u16,
    new_content_offset,
  );
  page_set_cell_count(view, page_offset, (cell_count + 1) as u16);
  page_set_cell_content_offset(view, page_offset, new_content_offset);

  return insert_slot;
}

/**
 * @export_c
 * Binary searches an Index Leaf Page for target key and optional rowid.
 * Returns >= 0 (found slot_idx) if found, or < 0 (-(insertion_slot + 1)) if not found.
 */
export function page_binary_search_index_raw(
  view: DataView,
  page_offset: u32,
  target_type: u8,
  target_f64: f64,
  target_bytes_off: u32,
  target_bytes_len: u16,
  has_target_rowid: u8,
  target_row_id: i64,
): i32 {
  const cell_count: u16 = page_get_cell_count(view, page_offset);
  let lo: i32 = 0;
  let hi: i32 = (cell_count as i32) - 1;

  while (lo <= hi) {
    const mid: i32 = (lo + hi) >> 1;
    const offset: u16 = page_get_cell_offset(view, page_offset, mid as u16);
    const k_len: u16 = read_u16(view, page_offset + offset);
    const r_id: i64 = read_i64(view, page_offset + offset + 2 + k_len);

    const rowid_to_compare: i64 =
      has_target_rowid !== 0 ? target_row_id : r_id;
    const cmp: i32 = page_compare_index_cell_raw(
      view,
      page_offset + offset + 2,
      k_len,
      r_id,
      target_type,
      target_type,
      target_f64,
      target_bytes_off,
      target_bytes_len,
      rowid_to_compare,
    );

    if (cmp === 0) {
      if (has_target_rowid === 0) {
        let first_slot: i32 = mid;
        while (first_slot > 0) {
          const prev_slot: i32 = first_slot - 1;
          const prev_offset: u16 = page_get_cell_offset(
            view,
            page_offset,
            prev_slot as u16,
          );
          const prev_k_len: u16 = read_u16(view, page_offset + prev_offset);
          const prev_cmp: i32 = page_compare_index_cell_raw(
            view,
            page_offset + prev_offset + 2,
            prev_k_len,
            0n,
            target_type,
            target_type,
            target_f64,
            target_bytes_off,
            target_bytes_len,
            0n,
          );
          if (prev_cmp === 0) {
            first_slot = prev_slot;
          } else {
            break;
          }
        }
        return first_slot;
      }
      return mid;
    } else if (cmp < 0) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return -(lo + 1);
}

/**
 * Inserts a key and rowid into a Secondary Index Leaf Page, maintaining sorted slot directory.
 */
export function page_insert_index_leaf_cell(
  view: DataView,
  page_offset: number,
  key_type: DataType,
  key_value: any,
  rowid: bigint,
  scratchpad_offset: number = 0,
): number {
  let effective_type = key_type;
  if (
    key_type === DataType.NULL ||
    key_value === null ||
    key_value === undefined
  ) {
    effective_type = DataType.NULL;
  }

  // Fast zero-allocation path for NULL and numeric keys
  if (effective_type === DataType.NULL) {
    if (
      scratchpad_offset > 0 &&
      scratchpad_offset !== page_offset &&
      scratchpad_offset + PAGE_SIZE <= view.byteLength
    ) {
      return page_insert_index_cell_raw(
        view,
        page_offset,
        DataType.NULL,
        0n,
        0.0,
        0,
        0,
        rowid,
        scratchpad_offset,
      );
    }
  } else if (effective_type === DataType.INT32) {
    const num = Number(key_value) | 0;
    if (
      scratchpad_offset > 0 &&
      scratchpad_offset !== page_offset &&
      scratchpad_offset + PAGE_SIZE <= view.byteLength
    ) {
      return page_insert_index_cell_raw(
        view,
        page_offset,
        DataType.INT32,
        0n,
        num,
        0,
        4,
        rowid,
        scratchpad_offset,
      );
    }
  } else if (effective_type === DataType.INT64) {
    const bi = BigInt(key_value);
    if (
      scratchpad_offset > 0 &&
      scratchpad_offset !== page_offset &&
      scratchpad_offset + PAGE_SIZE <= view.byteLength
    ) {
      return page_insert_index_cell_raw(
        view,
        page_offset,
        DataType.INT64,
        bi,
        Number(bi),
        0,
        8,
        rowid,
        scratchpad_offset,
      );
    }
  } else if (effective_type === DataType.FLOAT64) {
    const num = Number(key_value);
    if (
      scratchpad_offset > 0 &&
      scratchpad_offset !== page_offset &&
      scratchpad_offset + PAGE_SIZE <= view.byteLength
    ) {
      return page_insert_index_cell_raw(
        view,
        page_offset,
        DataType.FLOAT64,
        0n,
        num,
        0,
        8,
        rowid,
        scratchpad_offset,
      );
    }
  }

  // Encode key into _keyScratchBuf (or use Uint8Array directly) with zero heap allocation
  let key_len = 0;
  let key_f64 = 0.0;
  let ext_bytes: Uint8Array | null = null;

  if (effective_type === DataType.NULL) {
    key_len = 0;
  } else if (effective_type === DataType.INT32) {
    key_f64 = Number(key_value) | 0;
    _keyScratchView.setInt32(0, key_f64, true);
    key_len = 4;
  } else if (effective_type === DataType.INT64) {
    const bi = BigInt(key_value);
    key_f64 = Number(bi);
    _keyScratchView.setBigInt64(0, bi, true);
    key_len = 8;
  } else if (effective_type === DataType.FLOAT64) {
    key_f64 = Number(key_value);
    _keyScratchView.setFloat64(0, key_f64, true);
    key_len = 8;
  } else if (effective_type === DataType.UUID) {
    UuidCodec.encode(String(key_value), _keyScratchBuf, 0);
    key_len = 16;
  } else if (effective_type === DataType.ULID) {
    UlidCodec.encode(String(key_value), _keyScratchBuf, 0);
    key_len = 16;
  } else if (effective_type === DataType.TEXT) {
    const str = String(key_value);
    if (str.length * 3 <= _keyScratchBuf.byteLength) {
      key_len = text_encoder.encodeInto(str, _keyScratchBuf).written;
    } else {
      ext_bytes = text_encoder.encode(str);
      key_len = ext_bytes.byteLength;
    }
  } else {
    ext_bytes =
      key_value instanceof Uint8Array ? key_value : new Uint8Array(key_value);
    key_len = ext_bytes.byteLength;
  }

  // Cell format: [key_len uint16][key_data][rowid int64]
  const cell_length = 2 + key_len + 8;
  const needed_bytes = cell_length + 2;

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

  // Write cell directly into target_offset
  view.setUint16(target_offset, key_len, true);
  if (key_len > 0) {
    if (ext_bytes !== null) {
      memcpy(view, target_offset + 2, ext_bytes, 0, key_len);
    } else {
      memcpy(view, target_offset + 2, _keyScratchBuf, 0, key_len);
    }
  }
  view.setBigInt64(target_offset + 2 + key_len, rowid, true);

  // Binary search using zero-allocation page_compare_index_cell_raw
  // (the new key's bytes are now in `view` at `target_offset + 2`!)
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

    const cmp = page_compare_index_cell_raw(
      view,
      page_offset + offset + 2,
      existing_k_len,
      r_id,
      effective_type,
      effective_type,
      key_f64,
      target_offset + 2,
      key_len,
      rowid,
    );
    if (cmp < 0) {
      insert_slot = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  for (let s = cell_count - 1; s >= insert_slot; s--) {
    const prev_off = page_get_cell_offset(view, page_offset, s);
    page_set_cell_offset(view, page_offset, s + 1, prev_off);
  }

  page_set_cell_offset(view, page_offset, insert_slot, new_content_offset);
  page_set_cell_count(view, page_offset, cell_count + 1);
  page_set_cell_content_offset(view, page_offset, new_content_offset);

  return insert_slot;
}

/**
 * @export_c
 * Deletes an entry at slot_idx from a Secondary Index Leaf Page.
 */
export function page_delete_index_leaf_cell(
  view: DataView,
  page_offset: u32,
  slot_idx: u16,
): void {
  const cell_count = page_get_cell_count(view, page_offset);
  if (slot_idx < 0 || slot_idx >= cell_count) return;

  const cell_offset = page_get_cell_offset(view, page_offset, slot_idx);
  const k_len = view.getUint16(page_offset + cell_offset, true);
  const cell_length = 2 + k_len + 8;

  const slot_dir_start = page_offset + PAGE_HEADER_SIZE;
  const src = slot_dir_start + (slot_idx + 1) * 2;
  const dst = slot_dir_start + slot_idx * 2;
  const shift_len = (cell_count - 1 - slot_idx) * 2;

  if (shift_len > 0) {
    memcpy(view, dst, view, src, shift_len);
  }

  page_set_cell_count(view, page_offset, cell_count - 1);
  page_set_free_bytes(
    view,
    page_offset,
    page_get_free_bytes(view, page_offset) + cell_length,
  );
}

/**
 * Binary searches an Index Leaf Page for target key and optional rowid.
 */
export function page_binary_search_index_leaf(
  view: DataView,
  page_offset: number,
  target_type: DataType,
  target_value: any,
  target_row_id?: bigint,
): { found: boolean; slot_idx: number } {
  let effective_type = target_type;
  if (
    target_type === DataType.NULL ||
    target_value === null ||
    target_value === undefined
  ) {
    effective_type = DataType.NULL;
  }

  const has_rowid: u8 = target_row_id !== undefined ? 1 : 0;
  const rowid_val: i64 = target_row_id !== undefined ? target_row_id : 0n;

  if (
    effective_type === DataType.NULL ||
    effective_type === DataType.INT32 ||
    effective_type === DataType.INT64 ||
    effective_type === DataType.FLOAT64
  ) {
    const num_f64 =
      effective_type === DataType.NULL
        ? 0.0
        : typeof target_value === "bigint"
          ? Number(target_value)
          : Number(target_value);
    const res = page_binary_search_index_raw(
      view,
      page_offset,
      effective_type,
      num_f64,
      0,
      0,
      has_rowid,
      rowid_val,
    );
    return res >= 0
      ? { found: true, slot_idx: res }
      : { found: false, slot_idx: -res - 1 };
  }

  // For byte/string keys (TEXT, BLOB, UUID, ULID), encode into _keyScratchBuf
  let key_len = 0;
  let key_buf: Uint8Array = _keyScratchBuf;
  if (effective_type === DataType.UUID) {
    UuidCodec.encode(String(target_value), _keyScratchBuf, 0);
    key_len = 16;
  } else if (effective_type === DataType.ULID) {
    UlidCodec.encode(String(target_value), _keyScratchBuf, 0);
    key_len = 16;
  } else if (effective_type === DataType.TEXT) {
    const str = String(target_value);
    if (str.length * 3 <= _keyScratchBuf.byteLength) {
      key_len = text_encoder.encodeInto(str, _keyScratchBuf).written;
    } else {
      key_buf = text_encoder.encode(str);
      key_len = key_buf.byteLength;
    }
  } else {
    key_buf =
      target_value instanceof Uint8Array
        ? target_value
        : new Uint8Array(target_value);
    key_len = key_buf.byteLength;
  }

  const cell_count = page_get_cell_count(view, page_offset);
  let lo = 0;
  let hi = cell_count - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const offset = page_get_cell_offset(view, page_offset, mid);
    const k_len = view.getUint16(page_offset + offset, true);
    const r_id = view.getBigInt64(page_offset + offset + 2 + k_len, true);
    const cell_data_offset = page_offset + offset + 2;

    // Determine cell type
    let mid_type: DataType = DataType.TEXT;
    if (k_len === 0) {
      mid_type = DataType.NULL;
    } else if (effective_type === DataType.TEXT) {
      if (k_len === 4) {
        const b2 = view.getUint8(cell_data_offset + 2);
        const b3 = view.getUint8(cell_data_offset + 3);
        if ((b2 === 0 && b3 === 0) || (b2 === 0xff && b3 === 0xff)) {
          mid_type = DataType.INT32;
        }
      } else if (
        k_len === 2 &&
        view.getUint8(cell_data_offset) < 32 &&
        view.getUint8(cell_data_offset + 1) < 32
      ) {
        mid_type = DataType.BLOB;
      }
    } else if (k_len === 2) {
      mid_type = DataType.BLOB;
    } else if (k_len === 4) {
      mid_type = DataType.INT32;
    } else if (effective_type === DataType.UUID && k_len === 16) {
      mid_type = DataType.UUID;
    } else if (effective_type === DataType.ULID && k_len === 16) {
      mid_type = DataType.ULID;
    } else if (effective_type === DataType.BLOB) {
      mid_type = k_len === 5 || k_len === 6 ? DataType.TEXT : DataType.BLOB;
    }

    let cmp = 0;
    if (effective_type !== mid_type) {
      cmp = effective_type - mid_type;
    } else {
      const min_len = key_len < k_len ? key_len : k_len;
      for (let i = 0; i < min_len; i++) {
        const ba = key_buf[i];
        const bb = view.getUint8(cell_data_offset + i);
        if (ba !== bb) {
          cmp = ba < bb ? -1 : 1;
          break;
        }
      }
      if (cmp === 0) {
        cmp = key_len - k_len;
      }
      if (cmp === 0 && has_rowid !== 0) {
        cmp = rowid_val < r_id ? -1 : rowid_val > r_id ? 1 : 0;
      }
    }

    if (cmp === 0) {
      if (has_rowid === 0) {
        let first_slot = mid;
        while (first_slot > 0) {
          const prev_slot = first_slot - 1;
          const prev_offset = page_get_cell_offset(view, page_offset, prev_slot);
          const prev_k_len = view.getUint16(page_offset + prev_offset, true);
          if (prev_k_len !== key_len) break;
          const prev_data_off = page_offset + prev_offset + 2;
          let same = true;
          for (let i = 0; i < key_len; i++) {
            if (key_buf[i] !== view.getUint8(prev_data_off + i)) {
              same = false;
              break;
            }
          }
          if (same) {
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
 * Serializes a composite key tuple into a deterministic, comparable binary buffer.
 */
export function serialize_composite_key(
  columns: ColumnMeta[],
  col_indices: number[],
  col_count: number,
  row: DbRow,
): Uint8Array {
  let offset = 0;
  for (let i = 0; i < col_count; i++) {
    const col = columns[col_indices[i]];
    const val = row[col.name];
    const c_type = col.type;
    _keyScratchBuf[offset] = c_type;

    if (val === null || val === undefined) {
      _keyScratchBuf[offset + 1] = 0;
      _keyScratchBuf[offset + 2] = 0;
      offset += 3;
      continue;
    }

    switch (c_type) {
      case DataType.INT32:
        _keyScratchBuf[offset + 1] = 4;
        _keyScratchBuf[offset + 2] = 0;
        _keyScratchView.setInt32(offset + 3, Number(val), true);
        offset += 7;
        break;
      case DataType.INT64:
        _keyScratchBuf[offset + 1] = 8;
        _keyScratchBuf[offset + 2] = 0;
        _keyScratchView.setBigInt64(offset + 3, BigInt(val as any), true);
        offset += 11;
        break;
      case DataType.FLOAT64:
        _keyScratchBuf[offset + 1] = 8;
        _keyScratchBuf[offset + 2] = 0;
        _keyScratchView.setFloat64(offset + 3, Number(val), true);
        offset += 11;
        break;
      case DataType.UUID:
        _keyScratchBuf[offset + 1] = 16;
        _keyScratchBuf[offset + 2] = 0;
        UuidCodec.encode(String(val), _keyScratchBuf, offset + 3);
        offset += 19;
        break;
      case DataType.ULID:
        _keyScratchBuf[offset + 1] = 16;
        _keyScratchBuf[offset + 2] = 0;
        UlidCodec.encode(String(val), _keyScratchBuf, offset + 3);
        offset += 19;
        break;
      case DataType.TEXT: {
        const str = String(val);
        let len = 0;
        if (str.length > 0) {
          len = text_encoder.encodeInto(
            str,
            _keyScratchBuf.subarray(offset + 3),
          ).written;
        }
        _keyScratchBuf[offset + 1] = len & 0xff;
        _keyScratchBuf[offset + 2] = (len >> 8) & 0xff;
        offset += 3 + len;
        break;
      }
      default: {
        const bytes =
          val instanceof Uint8Array ? val : new Uint8Array(val as any);
        const len = bytes.byteLength;
        _keyScratchBuf[offset + 1] = len & 0xff;
        _keyScratchBuf[offset + 2] = (len >> 8) & 0xff;
        _keyScratchBuf.set(bytes, offset + 3);
        offset += 3 + len;
        break;
      }
    }
  }
  return _keyScratchBuf.slice(0, offset);
}

