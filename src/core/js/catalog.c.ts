import {
  PAGE_SIZE,
  FILE_HEADER_SIZE,
  MASTER_TABLE_OFFSET,
  MAX_TABLES_PAGE1,
  TABLE_DESCRIPTOR_SIZE,
  INDEX_CATALOG_OFFSET,
  INDEX_DESCRIPTOR_SIZE,
  CATALOG_PAGE_HEADER_SIZE,
  COLUMN_META_SIZE,
  MAX_COLUMNS_PER_CATALOG_PAGE,
  MAX_COLUMNS_PER_TABLE,
  MAX_NAME_LENGTH,
  HEADER_OFFSET_MAGIC,
  HEADER_OFFSET_PAGE_SIZE,
  HEADER_OFFSET_FILE_FORMAT_VERSION,
  HEADER_OFFSET_MIN_READ_VERSION,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_SCHEMA_VERSION,
  HEADER_OFFSET_CHANGE_COUNTER,
  HEADER_OFFSET_PAGE_CHECKSUM,
  HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  HEADER_OFFSET_RESERVED,
  CURRENT_ENGINE_VERSION,
  CURRENT_MIN_READ_VERSION,
  PAGE_TYPE_CATALOG_PAGE,
} from "../../constants.ts";

import {
  DataType,
  ColumnFlag,
  TableFlag,
  IndexFlag,
  ColumnDefinition,
  ColumnMeta,
  TableDescriptor,
  IndexDescriptor,
  CatalogPageHeader,
  TableMeta,
  attachTableMetaHelpers,
  TableAlreadyExistsError,
  TableNotFoundError,
  TooManyColumnsError,
  TooManyTablesError,
  UnsupportedFormatVersionError,
  InvalidDatabaseError,
  CorruptPageError,
} from "../../types/index.ts";
import { IPageProvider } from "../../shared/index.ts";
import { page_init_index_leaf } from "./page.c.ts";
import type { u16, u32, i32, const_u8_ptr } from "../types.ts";
import { memset, strlen } from "../../shared/c_runtime.ts";

import {
  computePageChecksum,
} from "../../host/storage/crc32.ts";

const text_decoder = new TextDecoder();

export const MAGIC_BYTES = new Uint8Array([0x57, 0x45, 0x42, 0x44, 0x42, 0x00]); // "WEBDB\0"

// ============================================================================
// 0. CRC32 IEEE 802.3 Checksum Primitives
// ============================================================================

const CRC_TABLE = new Uint32Array(256);
let crc_table_initialized = 0;

/**
 * @internal_c
 */
function init_crc_table(): void {
  if (crc_table_initialized) return;
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c >>> 0;
  }
  crc_table_initialized = 1;
}

/**
 * @export_c
 */
export function compute_crc32(data: const_u8_ptr, length: u32): u32 {
  init_crc_table();
  let crc = 0xffffffff;
  const bytes: const_u8_ptr = data;
  for (let i = 0; i < length; i++) {
    crc = CRC_TABLE[(crc ^ (bytes as Uint8Array)[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @export_c
 */
export function compute_page_checksum(view: DataView, page_offset: u32 = 0): u32 {
  init_crc_table();
  let crc = 0xffffffff;
  for (let i = 0; i < PAGE_SIZE; i++) {
    const byte = (i >= 12 && i <= 15) ? 0 : view.getUint8(page_offset + i);
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @export_c
 */
export function compute_page1_checksum(view: DataView, page1_offset: u32 = 0): u32 {
  init_crc_table();
  let crc = 0xffffffff;
  for (let i = 0; i < PAGE_SIZE; i++) {
    const byte = (i >= 28 && i <= 31) ? 0 : view.getUint8(page1_offset + i);
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ============================================================================
// 1. Page 1 File Header Operations
// ============================================================================

/**
 * @export_c
 * Initializes the Page 1 database file header and clears the catalog area.
 */
export function catalog_init_page1(
  view: DataView,
  page1_offset: u32 = 0,
): void {
  // Clear Page 1
  memset(view, page1_offset, 0, PAGE_SIZE);

  // Magic bytes: "WEBDB\0"
  view.setUint8(page1_offset + HEADER_OFFSET_MAGIC + 0, 0x57);
  view.setUint8(page1_offset + HEADER_OFFSET_MAGIC + 1, 0x45);
  view.setUint8(page1_offset + HEADER_OFFSET_MAGIC + 2, 0x42);
  view.setUint8(page1_offset + HEADER_OFFSET_MAGIC + 3, 0x44);
  view.setUint8(page1_offset + HEADER_OFFSET_MAGIC + 4, 0x42);
  view.setUint8(page1_offset + HEADER_OFFSET_MAGIC + 5, 0x00);

  // 2. Page size (4096)
  view.setUint16(page1_offset + HEADER_OFFSET_PAGE_SIZE, PAGE_SIZE, true);

  // 3. File format version
  view.setUint16(
    page1_offset + HEADER_OFFSET_FILE_FORMAT_VERSION,
    CURRENT_ENGINE_VERSION,
    true,
  );

  // 4. Min read version
  view.setUint16(
    page1_offset + HEADER_OFFSET_MIN_READ_VERSION,
    CURRENT_MIN_READ_VERSION,
    true,
  );

  // 5. Total pages (Page 1 is allocated)
  view.setUint32(page1_offset + HEADER_OFFSET_TOTAL_PAGES, 1, true);

  // 6. Free page head pointer (0 = empty list)
  view.setUint32(page1_offset + HEADER_OFFSET_FREE_PAGE_HEAD, 0, true);

  // 7. Schema version (1)
  view.setUint32(page1_offset + HEADER_OFFSET_SCHEMA_VERSION, 1, true);

  // 8. Change counter (0)
  view.setUint32(page1_offset + HEADER_OFFSET_CHANGE_COUNTER, 0, true);

  // 9. Page checksum (calculated on flush)
  view.setUint32(page1_offset + HEADER_OFFSET_PAGE_CHECKSUM, 0, true);

  // 10. Chained catalog pointers
  view.setUint32(page1_offset + HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, 0, true);
  view.setUint32(page1_offset + HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, 0, true);

  // Set initial valid checksum for Page 1
  const chk = compute_page1_checksum(view, page1_offset);
  view.setUint32(page1_offset + HEADER_OFFSET_PAGE_CHECKSUM, chk, true);
}

/**
 * Reads and validates the Page 1 database file header.
 */
export function catalog_read_page1_header(
  view: DataView,
  verify_checksum: boolean = false,
) {
  // 1. Validate magic bytes
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (view.getUint8(HEADER_OFFSET_MAGIC + i) !== MAGIC_BYTES[i]) {
      throw new InvalidDatabaseError(
        "Invalid database file: magic bytes mismatch",
      );
    }
  }

  const page_size = view.getUint16(HEADER_OFFSET_PAGE_SIZE, true);
  const file_format_version = view.getUint16(
    HEADER_OFFSET_FILE_FORMAT_VERSION,
    true,
  );
  const min_read_version = view.getUint16(HEADER_OFFSET_MIN_READ_VERSION, true);
  const total_pages = view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
  const free_page_head = view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
  const schema_version = view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
  const change_counter = view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
  const stored_checksum = view.getUint32(HEADER_OFFSET_PAGE_CHECKSUM, true);

  // 2. Fail-fast version handshake
  if (min_read_version > CURRENT_ENGINE_VERSION) {
    throw new UnsupportedFormatVersionError(
      `Database file format requires engine version >= ${min_read_version}, but running engine is version ${CURRENT_ENGINE_VERSION}`,
    );
  }

  // 3. Optional checksum verification on load
  if (verify_checksum && stored_checksum !== 0) {
    const computed = compute_page1_checksum(view, 0);
    if (computed !== stored_checksum) {
      throw new CorruptPageError(1, stored_checksum, computed);
    }
  }

  return {
    pageSize: page_size,
    fileFormatVersion: file_format_version,
    minReadVersion: min_read_version,
    totalPages: total_pages,
    freePageHead: free_page_head,
    schemaVersion: schema_version,
    changeCounter: change_counter,
    storedChecksum: stored_checksum,
  };
}

/**
 * @export_c
 */
export function catalog_get_total_pages(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  return view.getUint32(page1_offset + HEADER_OFFSET_TOTAL_PAGES, true);
}

/**
 * @export_c
 */
export function catalog_set_total_pages(
  view: DataView,
  page1_offset: u32,
  count?: u32,
): void {
  if (count === undefined) {
    count = page1_offset;
    page1_offset = 0;
  }
  view.setUint32(page1_offset + HEADER_OFFSET_TOTAL_PAGES, count, true);
}

/**
 * @export_c
 */
export function catalog_get_free_page_head(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  return view.getUint32(page1_offset + HEADER_OFFSET_FREE_PAGE_HEAD, true);
}

/**
 * @export_c
 */
export function catalog_set_free_page_head(
  view: DataView,
  page1_offset: u32,
  page_id?: u32,
): void {
  if (page_id === undefined) {
    page_id = page1_offset;
    page1_offset = 0;
  }
  view.setUint32(page1_offset + HEADER_OFFSET_FREE_PAGE_HEAD, page_id, true);
}

/**
 * @export_c
 */
export function catalog_get_schema_version(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  return view.getUint32(page1_offset + HEADER_OFFSET_SCHEMA_VERSION, true);
}

/**
 * @export_c
 */
export function catalog_increment_schema_version(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  const v = catalog_get_schema_version(view, page1_offset) + 1;
  view.setUint32(page1_offset + HEADER_OFFSET_SCHEMA_VERSION, v, true);
  return v;
}

/**
 * @export_c
 */
export function catalog_get_change_counter(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  return view.getUint32(page1_offset + HEADER_OFFSET_CHANGE_COUNTER, true);
}

/**
 * @export_c
 */
export function catalog_increment_change_counter(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  const c = catalog_get_change_counter(view, page1_offset) + 1;
  view.setUint32(page1_offset + HEADER_OFFSET_CHANGE_COUNTER, c, true);
  return c;
}

/**
 * @export_c
 */
export function catalog_update_page1_checksum(
  view: DataView,
  page1_offset: u32 = 0,
): u32 {
  view.setUint32(page1_offset + HEADER_OFFSET_PAGE_CHECKSUM, 0, true);
  const chk = compute_page1_checksum(view, page1_offset);
  view.setUint32(page1_offset + HEADER_OFFSET_PAGE_CHECKSUM, chk, true);
  return chk;
}

// ============================================================================
// 2. Fixed String Helper Functions
// ============================================================================

/**
 * @export_c
 */
export function catalog_write_fixed_string(
  view: DataView,
  offset: u32,
  str: string,
  max_len: u32,
): void {
  let i = 0;
  for (; i < max_len && i < strlen(str); i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
  for (; i < max_len; i++) {
    view.setUint8(offset + i, 0);
  }
}

/**
 * Reads a fixed-length string from the catalog.
 */
export function catalog_read_fixed_string(
  view: DataView,
  offset: number,
  max_len: number,
): string {
  const bytes: number[] = [];
  for (let i = 0; i < max_len; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return text_decoder.decode(new Uint8Array(bytes));
}

/**
 * Parses SQL type string to DataType enum.
 */
export function catalog_parse_data_type(type_str: string): DataType {
  switch (type_str.toUpperCase()) {
    case "INT32":
      return DataType.INT32;
    case "INT64":
      return DataType.INT64;
    case "FLOAT64":
      return DataType.FLOAT64;
    case "TEXT":
      return DataType.TEXT;
    case "BLOB":
      return DataType.BLOB;
    case "UUID":
      return DataType.UUID;
    case "ULID":
      return DataType.ULID;
    default:
      throw new Error(`Unsupported column data type: "${type_str}"`);
  }
}

// ============================================================================
// 3. Table Descriptor & Master Table Accessors (Page 1 & Overflow Pages)
// ============================================================================

export const MAX_DESCRIPTORS_PER_OVERFLOW_PAGE = 31; // floor((4096 - 16) / 128) = 31
export const CATALOG_PAGE_FLAG_TABLE_OVERFLOW = 1;
export const CATALOG_PAGE_FLAG_INDEX_OVERFLOW = 2;

export function catalog_resolve_page_view(
  page1_view: DataView,
  page_id: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): DataView | null {
  if (page_id <= 1) return page1_view;
  if (pager) {
    const bytes = pager.getPageBytes(page_id);
    if (bytes && bytes.byteLength >= PAGE_SIZE) {
      return new DataView(bytes.buffer, bytes.byteOffset, PAGE_SIZE);
    }
  }
  const pool = (page1_view.buffer as any)?.__webdbPool;
  if (pool && typeof pool.getResidentSlot === "function") {
    const slot = pool.getResidentSlot(page_id);
    if (slot !== -1) {
      return pool.getSlotDataView(slot);
    }
  }
  if (page1_view.buffer.byteLength >= page_id * PAGE_SIZE) {
    return new DataView(
      page1_view.buffer,
      (page_id - 1) * PAGE_SIZE,
      PAGE_SIZE,
    );
  }
  return null;
}

export function catalog_mark_overflow_page_dirty(
  page1_view: DataView,
  page_id: number,
  page_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { markPageDirty?(pageId: number): void },
): void {
  const bytes = new Uint8Array(
    page_view.buffer,
    page_view.byteOffset,
    PAGE_SIZE,
  );
  const chk = computePageChecksum(bytes);
  page_view.setUint32(12, chk, true);
  if (pager?.markPageDirty) {
    pager.markPageDirty(page_id);
  }
  const pool = (page1_view.buffer as any)?.__webdbPool;
  if (pool && typeof pool.getResidentSlot === "function") {
    const slot = pool.getResidentSlot(page_id);
    if (slot !== -1) {
      pool.markDirty(slot);
    }
  }
}

export function catalog_get_table_slot_capacity(
  page1_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): number {
  let total = MAX_TABLES_PAGE1;
  let page_id = page1_view.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true);
  while (page_id !== 0) {
    const pv = catalog_resolve_page_view(page1_view, page_id, pager);
    if (!pv) break;
    total += MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
    page_id = pv.getUint32(8, true);
  }
  return total;
}

export function catalog_locate_table_slot(
  page1_view: DataView,
  slot_idx: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): { view: DataView; offset: number; pageId: number } | null {
  if (slot_idx < 0) return null;
  if (slot_idx < MAX_TABLES_PAGE1) {
    return {
      view: page1_view,
      offset: MASTER_TABLE_OFFSET + slot_idx * TABLE_DESCRIPTOR_SIZE,
      pageId: 1,
    };
  }
  const overflow_idx = slot_idx - MAX_TABLES_PAGE1;
  const chain_hop = Math.floor(overflow_idx / MAX_DESCRIPTORS_PER_OVERFLOW_PAGE);
  const in_page_slot = overflow_idx % MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
  let page_id = page1_view.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true);
  for (let h = 0; h < chain_hop; h++) {
    if (page_id === 0) return null;
    const pv = catalog_resolve_page_view(page1_view, page_id, pager);
    if (!pv) return null;
    page_id = pv.getUint32(8, true);
  }
  if (page_id === 0) return null;
  const target_view = catalog_resolve_page_view(page1_view, page_id, pager);
  if (!target_view) return null;
  return {
    view: target_view,
    offset: CATALOG_PAGE_HEADER_SIZE + in_page_slot * TABLE_DESCRIPTOR_SIZE,
    pageId: page_id,
  };
}

export function catalog_append_table_overflow_page(
  page1_view: DataView,
  new_page_id: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: {
    getPageBytes(pageId: number): Uint8Array;
    markPageDirty?(pageId: number): void;
  },
): number {
  const start_slot_idx = catalog_get_table_slot_capacity(page1_view, pager);
  const new_view = catalog_resolve_page_view(page1_view, new_page_id, pager);
  if (!new_view) return -1;

  catalog_init_page(new_view, 0, 0, start_slot_idx, 0);
  new_view.setUint8(1, CATALOG_PAGE_FLAG_TABLE_OVERFLOW);
  catalog_mark_overflow_page_dirty(page1_view, new_page_id, new_view, pager);

  const first_overflow_id = page1_view.getUint32(
    HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
    true,
  );
  if (first_overflow_id === 0) {
    page1_view.setUint32(
      HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
      new_page_id,
      true,
    );
  } else {
    let cur_id = first_overflow_id;
    while (cur_id !== 0) {
      const cur_view = catalog_resolve_page_view(page1_view, cur_id, pager);
      if (!cur_view) break;
      const next_id = cur_view.getUint32(8, true);
      if (next_id === 0) {
        cur_view.setUint32(8, new_page_id, true);
        catalog_mark_overflow_page_dirty(page1_view, cur_id, cur_view, pager);
        break;
      }
      cur_id = next_id;
    }
  }

  return start_slot_idx;
}

/**
 * Reads a TableDescriptor from Page 1 (or chained overflow catalog page) by slot index.
 */
export function catalog_read_table_descriptor(
  view: DataView,
  slot_idx: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): TableDescriptor | null {
  const loc = catalog_locate_table_slot(view, slot_idx, pager);
  if (!loc) return null;
  const { view: target_view, offset } = loc;

  const table_id = target_view.getUint16(offset + 0, true);
  if (table_id === 0) return null;

  const column_count = target_view.getUint16(offset + 2, true);
  const root_page_id = target_view.getUint32(offset + 4, true);
  const col_catalog_page_id = target_view.getUint32(offset + 8, true);
  const name = catalog_read_fixed_string(target_view, offset + 12, MAX_NAME_LENGTH);
  const flags = target_view.getUint32(offset + 76, true);
  const row_count_estimate = target_view.getUint32(offset + 80, true);
  const auto_inc_next = target_view.getBigUint64(offset + 84, true);

  const pk_root_page_id = target_view.getUint32(offset + 92, true);
  const pk_column_count = target_view.getUint8(offset + 96);
  const pk_flags = target_view.getUint8(offset + 97);
  const pk_column_indices: number[] = [];
  for (let i = 0; i < 8; i++) {
    pk_column_indices.push(target_view.getUint16(offset + 98 + i * 2, true));
  }

  return {
    tableId: table_id,
    columnCount: column_count,
    rootPageId: root_page_id,
    colCatalogPageId: col_catalog_page_id,
    name,
    flags,
    rowCountEstimate: row_count_estimate,
    autoIncNext: auto_inc_next,
    pkRootPageId: pk_root_page_id > 0 ? pk_root_page_id : undefined,
    pkColumnCount: pk_root_page_id > 0 ? pk_column_count : undefined,
    pkFlags: pk_root_page_id > 0 ? pk_flags : undefined,
    pkColumnIndices: pk_root_page_id > 0 ? pk_column_indices : undefined,
  };
}

/**
 * Writes a TableDescriptor into Page 1 (or chained overflow catalog page) at the specified slot index.
 */
export function catalog_write_table_descriptor(
  view: DataView,
  slot_idx: number,
  desc: TableDescriptor,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: {
    getPageBytes(pageId: number): Uint8Array;
    markPageDirty?(pageId: number): void;
  },
): void {
  const loc = catalog_locate_table_slot(view, slot_idx, pager);
  if (!loc) {
    throw new Error(`Invalid table descriptor slot ${slot_idx}`);
  }
  const { view: target_view, offset, pageId } = loc;

  target_view.setUint16(offset + 0, desc.tableId, true);
  target_view.setUint16(offset + 2, desc.columnCount, true);
  target_view.setUint32(offset + 4, desc.rootPageId, true);
  target_view.setUint32(offset + 8, desc.colCatalogPageId, true);
  catalog_write_fixed_string(target_view, offset + 12, desc.name, MAX_NAME_LENGTH);
  target_view.setUint32(offset + 76, desc.flags, true);
  target_view.setUint32(offset + 80, desc.rowCountEstimate, true);
  target_view.setBigUint64(offset + 84, desc.autoIncNext, true);
  // Clear reserved 36 bytes (92..127), then populate embedded PK index metadata if present
  const uint8 = new Uint8Array(target_view.buffer, target_view.byteOffset);
  uint8.fill(0, offset + 92, offset + TABLE_DESCRIPTOR_SIZE);
  if (desc.pkRootPageId && desc.pkRootPageId > 0) {
    target_view.setUint32(offset + 92, desc.pkRootPageId, true);
    target_view.setUint8(offset + 96, desc.pkColumnCount ?? 1);
    target_view.setUint8(
      offset + 97,
      desc.pkFlags ?? (IndexFlag.PRIMARY | IndexFlag.UNIQUE),
    );
    for (let i = 0; i < 8; i++) {
      target_view.setUint16(
        offset + 98 + i * 2,
        desc.pkColumnIndices?.[i] ?? 0,
        true,
      );
    }
  }
  if (pageId > 1) {
    catalog_mark_overflow_page_dirty(view, pageId, target_view, pager);
  }
}

export function catalog_get_table_pk_index(
  desc: TableDescriptor,
): IndexDescriptor | null {
  if (
    desc.pkRootPageId &&
    desc.pkRootPageId > 0 &&
    desc.pkColumnCount &&
    desc.pkColumnCount > 0 &&
    ((desc.pkFlags ?? (IndexFlag.PRIMARY | IndexFlag.UNIQUE)) &
      IndexFlag.PRIMARY) !==
      0
  ) {
    return {
      indexId: 0x8000 + desc.tableId,
      tableId: desc.tableId,
      rootPageId: desc.pkRootPageId,
      columnCount: desc.pkColumnCount,
      flags: desc.pkFlags ?? (IndexFlag.PRIMARY | IndexFlag.UNIQUE),
      columnIndices: desc.pkColumnIndices
        ? [...desc.pkColumnIndices]
        : [0, 0, 0, 0, 0, 0, 0, 0],
      colDirections: [0, 0, 0, 0, 0, 0, 0, 0],
      name: `pk_${desc.name}`,
    };
  }
  return null;
}

/**
 * Finds a TableDescriptor by name in Page 1 (or overflow pages), or null if not found.
 */
export function catalog_find_table_by_name(
  view: DataView,
  table_name: string,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): TableDescriptor | null {
  const slot = catalog_find_table_slot(view, table_name, pager);
  return slot !== -1 ? catalog_read_table_descriptor(view, slot, pager) : null;
}

/**
 * Finds the slot index of an existing table by name, or -1 if not found.
 */
export function catalog_find_table_slot(
  view: DataView,
  table_name: string,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): number {
  const total_slots = catalog_get_table_slot_capacity(view, pager);
  for (let i = 0; i < total_slots; i++) {
    const desc = catalog_read_table_descriptor(view, i, pager);
    if (
      desc &&
      (desc.flags & TableFlag.ACTIVE) !== 0 &&
      desc.name === table_name
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Finds the first free slot index in Page 1's TableDescriptor array (or existing overflow pages).
 */
export function catalog_find_free_table_slot(
  view: DataView,
  page1_offset: u32 = 0,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): i32 {
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const offset =
      page1_offset + MASTER_TABLE_OFFSET + i * TABLE_DESCRIPTOR_SIZE;
    const table_id = view.getUint16(offset, true);
    if (table_id === 0) {
      return i;
    }
  }
  if (page1_offset === 0) {
    const total_slots = catalog_get_table_slot_capacity(view, pager);
    for (let i = MAX_TABLES_PAGE1; i < total_slots; i++) {
      const loc = catalog_locate_table_slot(view, i, pager);
      if (loc && loc.view.getUint16(loc.offset, true) === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Lists all active tables defined on Page 1 and chained overflow pages.
 */
export function catalog_list_table_descriptors(
  view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): TableDescriptor[] {
  const tables: TableDescriptor[] = [];
  const total_slots = catalog_get_table_slot_capacity(view, pager);
  for (let i = 0; i < total_slots; i++) {
    const desc = catalog_read_table_descriptor(view, i, pager);
    if (desc && (desc.flags & TableFlag.ACTIVE) !== 0) {
      tables.push(desc);
    }
  }
  return tables;
}

// ============================================================================
// 4. Index Descriptor Accessors (Page 1: bytes 2148..3171 & Overflow Pages)
// ============================================================================

export function catalog_get_index_slot_capacity(
  page1_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): number {
  let total = MAX_INDEXES_PAGE1;
  let page_id = page1_view.getUint32(
    HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
    true,
  );
  while (page_id !== 0) {
    const pv = catalog_resolve_page_view(page1_view, page_id, pager);
    if (!pv) break;
    total += MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
    page_id = pv.getUint32(8, true);
  }
  return total;
}

export function catalog_locate_index_slot(
  page1_view: DataView,
  slot_idx: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): { view: DataView; offset: number; pageId: number } | null {
  if (slot_idx < 0) return null;
  if (slot_idx < MAX_INDEXES_PAGE1) {
    return {
      view: page1_view,
      offset: INDEX_CATALOG_OFFSET + slot_idx * INDEX_DESCRIPTOR_SIZE,
      pageId: 1,
    };
  }
  const overflow_idx = slot_idx - MAX_INDEXES_PAGE1;
  const chain_hop = Math.floor(overflow_idx / MAX_DESCRIPTORS_PER_OVERFLOW_PAGE);
  const in_page_slot = overflow_idx % MAX_DESCRIPTORS_PER_OVERFLOW_PAGE;
  let page_id = page1_view.getUint32(
    HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
    true,
  );
  for (let h = 0; h < chain_hop; h++) {
    if (page_id === 0) return null;
    const pv = catalog_resolve_page_view(page1_view, page_id, pager);
    if (!pv) return null;
    page_id = pv.getUint32(8, true);
  }
  if (page_id === 0) return null;
  const target_view = catalog_resolve_page_view(page1_view, page_id, pager);
  if (!target_view) return null;
  return {
    view: target_view,
    offset: CATALOG_PAGE_HEADER_SIZE + in_page_slot * INDEX_DESCRIPTOR_SIZE,
    pageId: page_id,
  };
}

export function catalog_append_index_overflow_page(
  page1_view: DataView,
  new_page_id: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: {
    getPageBytes(pageId: number): Uint8Array;
    markPageDirty?(pageId: number): void;
  },
): number {
  const start_slot_idx = catalog_get_index_slot_capacity(page1_view, pager);
  const new_view = catalog_resolve_page_view(page1_view, new_page_id, pager);
  if (!new_view) return -1;

  catalog_init_page(new_view, 0, 0, start_slot_idx, 0);
  new_view.setUint8(1, CATALOG_PAGE_FLAG_INDEX_OVERFLOW);
  catalog_mark_overflow_page_dirty(page1_view, new_page_id, new_view, pager);

  const first_overflow_id = page1_view.getUint32(
    HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
    true,
  );
  if (first_overflow_id === 0) {
    page1_view.setUint32(
      HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
      new_page_id,
      true,
    );
  } else {
    let cur_id = first_overflow_id;
    while (cur_id !== 0) {
      const cur_view = catalog_resolve_page_view(page1_view, cur_id, pager);
      if (!cur_view) break;
      const next_id = cur_view.getUint32(8, true);
      if (next_id === 0) {
        cur_view.setUint32(8, new_page_id, true);
        catalog_mark_overflow_page_dirty(page1_view, cur_id, cur_view, pager);
        break;
      }
      cur_id = next_id;
    }
  }

  return start_slot_idx;
}

/**
 * Reads an IndexDescriptor from Page 1 (or chained overflow page) by slot index.
 */
export function catalog_read_index_descriptor(
  view: DataView,
  slot_idx: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): IndexDescriptor | null {
  const loc = catalog_locate_index_slot(view, slot_idx, pager);
  if (!loc) return null;
  const { view: target_view, offset } = loc;

  const index_id = target_view.getUint16(offset + 0, true);

  if (index_id === 0) return null;

  const table_id = target_view.getUint16(offset + 2, true);
  const root_page_id = target_view.getUint32(offset + 4, true);
  const column_count = target_view.getUint8(offset + 8);
  const flags = target_view.getUint8(offset + 9);

  const column_indices: number[] = [];

  for (let i = 0; i < 8; i++) {
    column_indices.push(target_view.getUint16(offset + 10 + i * 2, true));
  }

  const col_directions: number[] = [];

  for (let i = 0; i < 8; i++) {
    col_directions.push(target_view.getUint8(offset + 26 + i));
  }

  const name = catalog_read_fixed_string(target_view, offset + 34, MAX_NAME_LENGTH);

  return {
    indexId: index_id,
    tableId: table_id,
    rootPageId: root_page_id,
    columnCount: column_count,
    flags,
    columnIndices: column_indices,
    colDirections: col_directions,
    name,
  };
}

/**
 * Writes an IndexDescriptor into Page 1 (or chained overflow page) at the specified slot index.
 */
export function catalog_write_index_descriptor(
  view: DataView,
  slot_idx: number,
  desc: IndexDescriptor,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: {
    getPageBytes(pageId: number): Uint8Array;
    markPageDirty?(pageId: number): void;
  },
): void {
  const loc = catalog_locate_index_slot(view, slot_idx, pager);
  if (!loc) {
    throw new Error(`Invalid index descriptor slot ${slot_idx}`);
  }
  const { view: target_view, offset, pageId } = loc;

  target_view.setUint16(offset + 0, desc.indexId, true);
  target_view.setUint16(offset + 2, desc.tableId, true);
  target_view.setUint32(offset + 4, desc.rootPageId, true);
  target_view.setUint8(offset + 8, desc.columnCount);
  target_view.setUint8(offset + 9, desc.flags);

  for (let i = 0; i < 8; i++) {
    target_view.setUint16(offset + 10 + i * 2, desc.columnIndices[i] ?? 0, true);
  }

  for (let i = 0; i < 8; i++) {
    target_view.setUint8(offset + 26 + i, desc.colDirections[i] ?? 0);
  }

  catalog_write_fixed_string(target_view, offset + 34, desc.name, MAX_NAME_LENGTH);

  const uint8 = new Uint8Array(target_view.buffer, target_view.byteOffset);
  uint8.fill(0, offset + 98, offset + INDEX_DESCRIPTOR_SIZE);

  if (pageId > 1) {
    catalog_mark_overflow_page_dirty(view, pageId, target_view, pager);
  }
}

export const MAX_INDEXES_PAGE1 = 8;

/**
 * Finds the first free slot index in Page 1's IndexDescriptor array (or existing overflow pages).
 */
export function catalog_find_free_index_slot(
  view: DataView,
  page1_offset: u32 = 0,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): i32 {
  for (let i = 0; i < MAX_INDEXES_PAGE1; i++) {
    const offset = page1_offset + INDEX_CATALOG_OFFSET + i * INDEX_DESCRIPTOR_SIZE;
    const index_id = view.getUint16(offset + 0, true);
    if (index_id === 0) return i;
  }
  if (page1_offset === 0) {
    const total_slots = catalog_get_index_slot_capacity(view, pager);
    for (let i = MAX_INDEXES_PAGE1; i < total_slots; i++) {
      const loc = catalog_locate_index_slot(view, i, pager);
      if (loc && loc.view.getUint16(loc.offset, true) === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Finds an IndexDescriptor by name in Page 1, overflow pages, or embedded table PK indexes.
 */
export function catalog_find_index_by_name(
  view: DataView,
  name: string,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): { slotIdx: number; desc: IndexDescriptor } | null {
  const target = name.toLowerCase();
  const total_idx_slots = catalog_get_index_slot_capacity(view, pager);
  for (let i = 0; i < total_idx_slots; i++) {
    const desc = catalog_read_index_descriptor(view, i, pager);
    if (desc && desc.name.toLowerCase() === target) {
      return { slotIdx: i, desc };
    }
  }
  const total_table_slots = catalog_get_table_slot_capacity(view, pager);
  for (let t = 0; t < total_table_slots; t++) {
    const t_desc = catalog_read_table_descriptor(view, t, pager);
    if (t_desc && (t_desc.flags & TableFlag.ACTIVE) !== 0) {
      const pk_idx = catalog_get_table_pk_index(t_desc);
      if (pk_idx && pk_idx.name.toLowerCase() === target) {
        return { slotIdx: -(t + 1), desc: pk_idx };
      }
    }
  }
  return null;
}

/**
 * Lists all index descriptors for a table (including embedded primary key index and secondary indexes).
 */
export function catalog_list_table_indexes(
  view: DataView,
  table_id: number,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): IndexDescriptor[] {
  const indexes: IndexDescriptor[] = [];
  let has_embedded_pk = false;

  // Check table descriptor for embedded PK index
  const candidate_slot = table_id - 1;
  let table_desc =
    candidate_slot >= 0
      ? catalog_read_table_descriptor(view, candidate_slot, pager)
      : null;
  if (!table_desc || table_desc.tableId !== table_id) {
    const all_tables = catalog_list_table_descriptors(view, pager);
    table_desc = all_tables.find((t) => t.tableId === table_id) ?? null;
  }
  if (table_desc && (table_desc.flags & TableFlag.ACTIVE) !== 0) {
    const pk_idx = catalog_get_table_pk_index(table_desc);
    if (pk_idx) {
      indexes.push(pk_idx);
      has_embedded_pk = true;
    }
  }

  const total_idx_slots = catalog_get_index_slot_capacity(view, pager);
  for (let i = 0; i < total_idx_slots; i++) {
    const desc = catalog_read_index_descriptor(view, i, pager);
    if (desc && desc.tableId === table_id) {
      if (has_embedded_pk && (desc.flags & IndexFlag.PRIMARY) !== 0) {
        continue;
      }
      indexes.push(desc);
    }
  }
  return indexes;
}

/**
 * Lists all active index descriptors across all tables in the database.
 */
export function catalog_list_all_indexes(
  view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager?: { getPageBytes(pageId: number): Uint8Array },
): IndexDescriptor[] {
  const all_indexes: IndexDescriptor[] = [];
  const active_tables = catalog_list_table_descriptors(view, pager);
  const seen_table_ids = new Set<number>();

  for (const t of active_tables) {
    seen_table_ids.add(t.tableId);
    const t_indexes = catalog_list_table_indexes(view, t.tableId, pager);
    for (const idx of t_indexes) {
      all_indexes.push(idx);
    }
  }

  const total_idx_slots = catalog_get_index_slot_capacity(view, pager);
  for (let i = 0; i < total_idx_slots; i++) {
    const desc = catalog_read_index_descriptor(view, i, pager);
    if (desc && !seen_table_ids.has(desc.tableId)) {
      all_indexes.push(desc);
    }
  }

  return all_indexes;
}

export function catalog_delete_index_descriptor(
  view: DataView,
  page1_offset: u32,
  slot_idx?: u32,
): i32 {
  if (slot_idx === undefined) {
    slot_idx = page1_offset;
    page1_offset = 0;
  }
  if (slot_idx < MAX_INDEXES_PAGE1) {
    const offset =
      page1_offset + INDEX_CATALOG_OFFSET + slot_idx * INDEX_DESCRIPTOR_SIZE;
    memset(view, offset, 0, INDEX_DESCRIPTOR_SIZE);
    return 0;
  }
  if (page1_offset === 0) {
    const loc = catalog_locate_index_slot(view, slot_idx);
    if (!loc) return -1;
    memset(loc.view, loc.offset, 0, INDEX_DESCRIPTOR_SIZE);
    if (loc.pageId > 1) {
      catalog_mark_overflow_page_dirty(view, loc.pageId, loc.view);
    }
    return 0;
  }
  return -1;
}

export function catalog_delete_table_descriptor(
  view: DataView,
  page1_offset: u32,
  slot_idx?: u32,
): i32 {
  if (slot_idx === undefined) {
    slot_idx = page1_offset;
    page1_offset = 0;
  }
  if (slot_idx < MAX_TABLES_PAGE1) {
    const offset =
      page1_offset + MASTER_TABLE_OFFSET + slot_idx * TABLE_DESCRIPTOR_SIZE;
    memset(view, offset, 0, TABLE_DESCRIPTOR_SIZE);
    return 0;
  }
  if (page1_offset === 0) {
    const loc = catalog_locate_table_slot(view, slot_idx);
    if (!loc) return -1;
    memset(loc.view, loc.offset, 0, TABLE_DESCRIPTOR_SIZE);
    if (loc.pageId > 1) {
      catalog_mark_overflow_page_dirty(view, loc.pageId, loc.view);
    }
    return 0;
  }
  return -1;
}

// ============================================================================
// 5. Dedicated Column Catalog Pages (page_type = 0x0C)
// ============================================================================

/**
 * @export_c
 * Initializes a 4KB dedicated column catalog page.
 */
export function catalog_init_page(
  view: DataView,
  page_offset: u32,
  table_id: u16,
  start_col_index: u16,
  next_col_catalog_page_id: u32 = 0,
): void {
  memset(view, page_offset, 0, PAGE_SIZE);
  view.setUint8(page_offset + 0, PAGE_TYPE_CATALOG_PAGE);
  view.setUint8(page_offset + 1, 0); // flags
  view.setUint16(page_offset + 2, 0, true); // col_count_in_page = 0
  view.setUint16(page_offset + 4, table_id, true);
  view.setUint16(page_offset + 6, start_col_index, true);
  view.setUint32(page_offset + 8, next_col_catalog_page_id, true);
  view.setUint32(page_offset + 12, 0, true); // checksum
}

/**
 * Reads the catalog page header.
 */
export function catalog_read_page_header(
  view: DataView,
  page_offset: number,
): CatalogPageHeader {
  return {
    pageType: view.getUint8(page_offset + 0),
    flags: view.getUint8(page_offset + 1),
    colCountInPage: view.getUint16(page_offset + 2, true),
    tableId: view.getUint16(page_offset + 4, true),
    startColIndex: view.getUint16(page_offset + 6, true),
    nextColCatalogPageId: view.getUint32(page_offset + 8, true),
    pageChecksum: view.getUint32(page_offset + 12, true),
  };
}

/**
 * @export_c
 */
export function catalog_write_page_header(
  view: DataView,
  page_offset: u32,
  col_count_in_page: u16,
  table_id: u16,
  start_col_index: u16,
  next_col_catalog_page_id: u32,
): void {
  view.setUint8(page_offset + 0, PAGE_TYPE_CATALOG_PAGE);
  view.setUint8(page_offset + 1, 0);
  view.setUint16(page_offset + 2, col_count_in_page, true);
  view.setUint16(page_offset + 4, table_id, true);
  view.setUint16(page_offset + 6, start_col_index, true);
  view.setUint32(page_offset + 8, next_col_catalog_page_id, true);
}

/**
 * Writes a ColumnMeta entry (72 bytes) into a catalog page at inPageSlot (0..55).
 */
export function catalog_write_column_meta(
  view: DataView,
  page_offset: number,
  in_page_slot: number,
  meta: ColumnMeta,
): void {
  if (in_page_slot < 0 || in_page_slot >= MAX_COLUMNS_PER_CATALOG_PAGE) {
    throw new Error(`Invalid catalog in-page slot ${in_page_slot}`);
  }

  const offset =
    page_offset + CATALOG_PAGE_HEADER_SIZE + in_page_slot * COLUMN_META_SIZE;
  view.setUint8(offset + 0, meta.type);
  view.setUint8(offset + 1, meta.flags);
  view.setUint16(offset + 2, meta.colOffset, true);
  catalog_write_fixed_string(view, offset + 4, meta.name, MAX_NAME_LENGTH);
  // Clear _reserved[4] at 68..71
  view.setUint32(offset + 68, 0, true);
}

/**
 * Reads a ColumnMeta entry (72 bytes) from a catalog page at inPageSlot (0..55).
 */
export function catalog_read_column_meta(
  view: DataView,
  page_offset: number,
  in_page_slot: number,
): ColumnMeta {
  const offset =
    page_offset + CATALOG_PAGE_HEADER_SIZE + in_page_slot * COLUMN_META_SIZE;
  const type = view.getUint8(offset + 0) as DataType;
  const flags = view.getUint8(offset + 1);
  const col_offset = view.getUint16(offset + 2, true);
  const name = catalog_read_fixed_string(view, offset + 4, MAX_NAME_LENGTH);

  return { type, flags, colOffset: col_offset, name };
}

/**
 * Calculates cross-page column mapping:
 * page_chain_idx = floor(col_idx / 56)
 * col_idx_in_page = col_idx % 56
 */
export function catalog_map_column_location(col_idx: number): {
  pageChainIdx: number;
  colIdxInPage: number;
} {
  return {
    pageChainIdx: Math.floor(col_idx / MAX_COLUMNS_PER_CATALOG_PAGE),
    colIdxInPage: col_idx % MAX_COLUMNS_PER_CATALOG_PAGE,
  };
}

// ============================================================================
// 6. Schema DDL & Metadata Assembler
// ============================================================================

/**
 * Creates a new table, allocating a root data page and dedicated column catalog page(s).
 */
export function catalog_create_table(
  page1_view: DataView,
  pager: IPageProvider,
  name: string,
  column_def: ColumnDefinition[],
): TableMeta {
  if (column_def.length === 0) {
    throw new Error("Table must have at least one column");
  }

  if (column_def.length > MAX_COLUMNS_PER_TABLE) {
    throw new TooManyColumnsError(column_def.length, MAX_COLUMNS_PER_TABLE);
  }

  // Check if table already exists
  if (catalog_find_table_slot(page1_view, name, pager) !== -1) {
    throw new TableAlreadyExistsError(name);
  }

  // Find free slot in Page 1 (or existing overflow pages); allocate overflow page if needed
  let slot_idx = catalog_find_free_table_slot(page1_view, 0, pager);

  if (slot_idx === -1) {
    const overflow_page_id = pager.allocateNewPage();
    if (!overflow_page_id || overflow_page_id <= 1) {
      throw new TooManyTablesError(MAX_TABLES_PAGE1 + 1, MAX_TABLES_PAGE1);
    }
    slot_idx = catalog_append_table_overflow_page(
      page1_view,
      overflow_page_id,
      pager,
    );
    if (slot_idx === -1) {
      throw new TooManyTablesError(MAX_TABLES_PAGE1 + 1, MAX_TABLES_PAGE1);
    }
  }

  const table_id = slot_idx + 1;
  const root_page_id = pager.allocateNewPage();

  // Initialize the table's root leaf data page (0x0D)
  const root_bytes = pager.getPageBytes(root_page_id);
  const root_view = new DataView(root_bytes.buffer, root_bytes.byteOffset);
  root_view.setUint8(0, 0x0d); // PAGE_TYPE_LEAF_DATA
  root_view.setUint8(1, 0);
  root_view.setUint16(2, 0, true); // cell_count = 0
  root_view.setUint16(4, PAGE_SIZE, true); // cell_content_offset = 4096
  root_view.setUint32(6, 0, true); // next_page_id = 0
  root_view.setUint16(10, 0, true); // free_bytes = 0
  root_view.setUint32(12, 0, true); // checksum
  pager.markPageDirty(root_page_id);

  // Compute column metadata & fixed slice offsets
  const columns: ColumnMeta[] = [];
  let current_fixed_offset = 0;

  for (let i = 0; i < column_def.length; i++) {
    const def = column_def[i];
    const type =
      typeof def.type === "string"
        ? catalog_parse_data_type(def.type)
        : (def.type as DataType);

    let flags = 0;
    if (typeof (def as any).flags === "number") {
      flags = (def as any).flags;
    } else {
      if (def.primaryKey || def.flags?.primaryKey)
        flags |= ColumnFlag.PRIMARY_KEY;
      if (def.notNull || def.flags?.notNull) flags |= ColumnFlag.NOT_NULL;
      if (def.indexed || def.flags?.indexed) flags |= ColumnFlag.INDEXED;
      if (
        def.autoInc ||
        def.autoIncrement ||
        def.flags?.autoInc ||
        def.flags?.autoIncrement
      )
        flags |= ColumnFlag.AUTO_INC;
    }

    const col_offset = current_fixed_offset;

    switch (type) {
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

    columns.push({
      type,
      flags,
      colOffset: col_offset,
      name: def.name,
    });
  }

  // Allocate and write dedicated column catalog pages
  const total_cols = columns.length;
  const num_catalog_pages = Math.ceil(
    total_cols / MAX_COLUMNS_PER_CATALOG_PAGE,
  );
  const catalog_page_ids: number[] = [];

  for (let i = 0; i < num_catalog_pages; i++) {
    catalog_page_ids.push(pager.allocateNewPage());
  }

  for (let p = 0; p < num_catalog_pages; p++) {
    const page_id = catalog_page_ids[p];
    const next_page_id =
      p < num_catalog_pages - 1 ? catalog_page_ids[p + 1] : 0;
    const start_col_index = p * MAX_COLUMNS_PER_CATALOG_PAGE;
    const col_count_in_this_page = Math.min(
      total_cols - start_col_index,
      MAX_COLUMNS_PER_CATALOG_PAGE,
    );

    const page_bytes = pager.getPageBytes(page_id);
    const view = new DataView(page_bytes.buffer, page_bytes.byteOffset);

    catalog_init_page(view, 0, table_id, start_col_index, next_page_id);
    view.setUint16(2, col_count_in_this_page, true); // col_count_in_page

    for (let c = 0; c < col_count_in_this_page; c++) {
      const col = columns[start_col_index + c];
      catalog_write_column_meta(view, 0, c, col);
    }

    // Set CRC32 checksum
    const chk = computePageChecksum(page_bytes);
    view.setUint32(12, chk, true);
    pager.markPageDirty(page_id);
  }

  const first_catalog_page_id = catalog_page_ids[0];

  // Auto-create primary key index if PRIMARY_KEY columns are defined
  const pk_cols: ColumnMeta[] = [];
  for (let i = 0; i < columns.length; i++) {
    if ((columns[i].flags & ColumnFlag.PRIMARY_KEY) !== 0) {
      pk_cols.push(columns[i]);
    }
  }

  let pk_root_page_id = 0;
  let pk_col_count = 0;
  let pk_flags = 0;
  const pk_col_indices = [0, 0, 0, 0, 0, 0, 0, 0];

  if (pk_cols.length > 0) {
    pk_root_page_id = pager.allocateNewPage();
    const index_root_bytes = pager.getPageBytes(pk_root_page_id);
    const index_root_view = new DataView(
      index_root_bytes.buffer,
      index_root_bytes.byteOffset,
    );
    page_init_index_leaf(index_root_view, 0, 0);
    pager.markPageDirty(pk_root_page_id);

    pk_col_count = Math.min(pk_cols.length, 8);
    pk_flags = IndexFlag.PRIMARY | IndexFlag.UNIQUE;
    for (let k = 0; k < pk_col_count; k++) {
      const pk_col_name = pk_cols[k].name;
      let matched_idx = 0;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c].name === pk_col_name) {
          matched_idx = c;
          break;
        }
      }
      pk_col_indices[k] = matched_idx;
    }
  }

  // Write TableDescriptor into Page 1 (or overflow table catalog page)
  const desc: TableDescriptor = {
    tableId: table_id,
    columnCount: total_cols,
    rootPageId: root_page_id,
    colCatalogPageId: first_catalog_page_id,
    name,
    flags: TableFlag.ACTIVE,
    rowCountEstimate: 0,
    autoIncNext: 1n,
    pkRootPageId: pk_root_page_id > 0 ? pk_root_page_id : undefined,
    pkColumnCount: pk_root_page_id > 0 ? pk_col_count : undefined,
    pkFlags: pk_root_page_id > 0 ? pk_flags : undefined,
    pkColumnIndices: pk_root_page_id > 0 ? pk_col_indices : undefined,
  };

  catalog_write_table_descriptor(page1_view, slot_idx, desc, pager);

  catalog_increment_schema_version(page1_view);
  catalog_increment_change_counter(page1_view);
  catalog_update_page1_checksum(page1_view);

  const indexes = catalog_list_table_indexes(page1_view, table_id, pager);
  const primary_key: string[] = [];
  for (let i = 0; i < pk_cols.length; i++) {
    primary_key.push(pk_cols[i].name);
  }

  return attachTableMetaHelpers({
    ...desc,
    columns,
    primaryKey: primary_key.length > 0 ? primary_key : undefined,
    indexes: indexes.length > 0 ? indexes : undefined,
  });
}

/**
 * Loads the complete TableMeta (including all columns from chained catalog pages) for a table.
 */
export function catalog_load_table_meta(
  page1_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager: { getPageBytes(pageId: number): Uint8Array },
  table_name: string,
): TableMeta {
  const slot_idx = catalog_find_table_slot(page1_view, table_name, pager);

  if (slot_idx === -1) {
    throw new TableNotFoundError(table_name);
  }

  const desc = catalog_read_table_descriptor(page1_view, slot_idx, pager)!;
  const columns: ColumnMeta[] = [];

  let current_cat_page_id = desc.colCatalogPageId;
  let loaded_count = 0;

  while (current_cat_page_id !== 0 && loaded_count < desc.columnCount) {
    const page_bytes = pager.getPageBytes(current_cat_page_id);
    const view = new DataView(page_bytes.buffer, page_bytes.byteOffset);
    const header = catalog_read_page_header(view, 0);

    for (let i = 0; i < header.colCountInPage; i++) {
      const col = catalog_read_column_meta(view, 0, i);
      columns.push(col);
      loaded_count++;
    }

    current_cat_page_id = header.nextColCatalogPageId;
  }

  const indexes = catalog_list_table_indexes(page1_view, desc.tableId, pager);
  const primary_key: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    if ((columns[i].flags & ColumnFlag.PRIMARY_KEY) !== 0) {
      primary_key.push(columns[i].name);
    }
  }

  return attachTableMetaHelpers({
    ...desc,
    columns,
    primaryKey: primary_key.length > 0 ? primary_key : undefined,
    indexes: indexes.length > 0 ? indexes : undefined,
  });
}

/**
 * Loads all active tables and their full schemas from Page 1 and chained overflow pages.
 */
export function catalog_load_all_tables(
  page1_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager: { getPageBytes(pageId: number): Uint8Array },
): TableMeta[] {
  const descriptors = catalog_list_table_descriptors(page1_view, pager);
  const tables: TableMeta[] = [];
  for (let i = 0; i < descriptors.length; i++) {
    tables.push(
      catalog_load_table_meta(page1_view, pager, descriptors[i].name),
    );
  }
  return tables;
}
