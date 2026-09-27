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
} from "../../constants.js";

import {
  DataType,
  ColumnFlag,
  TableFlag,
  ColumnDefinition,
  ColumnMeta,
  TableDescriptor,
  IndexDescriptor,
  CatalogPageHeader,
  TableMeta,
  TableAlreadyExistsError,
  TableNotFoundError,
  TooManyColumnsError,
  TooManyTablesError,
  UnsupportedFormatVersionError,
  InvalidDatabaseError,
  CorruptPageError,
} from "../../types/index.js";
import { IPageProvider } from "../../shared/index.js";

import {
  computePage1Checksum,
  computePageChecksum,
} from "../../host/storage/crc32.js";

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

export const MAGIC_BYTES = new Uint8Array([0x57, 0x45, 0x42, 0x44, 0x42, 0x00]); // "WEBDB\0"

// ============================================================================
// 1. Page 1 File Header Operations
// ============================================================================

/**
 * @export_c
 * Initializes the Page 1 database file header and clears the catalog area.
 */
export function catalog_init_page1(view: DataView): void {
  // 1. Magic bytes (one-shot copy via Uint8Array.set / memcpy)
  new Uint8Array(
    view.buffer,
    view.byteOffset + HEADER_OFFSET_MAGIC,
    MAGIC_BYTES.byteLength,
  ).set(MAGIC_BYTES);

  // 2. Page size (4096)
  view.setUint16(HEADER_OFFSET_PAGE_SIZE, PAGE_SIZE, true);

  // 3. File format version
  view.setUint16(
    HEADER_OFFSET_FILE_FORMAT_VERSION,
    CURRENT_ENGINE_VERSION,
    true,
  );

  // 4. Min read version
  view.setUint16(
    HEADER_OFFSET_MIN_READ_VERSION,
    CURRENT_MIN_READ_VERSION,
    true,
  );

  // 5. Total pages (Page 1 is allocated)
  view.setUint32(HEADER_OFFSET_TOTAL_PAGES, 1, true);

  // 6. Free page head pointer (0 = empty list)
  view.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, 0, true);

  // 7. Schema version (1)
  view.setUint32(HEADER_OFFSET_SCHEMA_VERSION, 1, true);

  // 8. Change counter (0)
  view.setUint32(HEADER_OFFSET_CHANGE_COUNTER, 0, true);

  // 9. Page checksum (calculated on flush)
  view.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, 0, true);

  // 10. Chained catalog pointers (always 0 in v1; reserved for overflow catalog pages in future versions)
  view.setUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, 0, true);
  view.setUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, 0, true);

  // Clear reserved header bytes (40..99)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, HEADER_OFFSET_RESERVED, FILE_HEADER_SIZE);

  // Clear Catalog area (bytes 100..4095)
  uint8.fill(0, MASTER_TABLE_OFFSET, PAGE_SIZE);

  // Set initial valid checksum for Page 1
  const chk = computePage1Checksum(
    new Uint8Array(view.buffer, view.byteOffset, PAGE_SIZE),
  );

  view.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, chk, true);
}

/**
 * @export_c
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
    const page_bytes = new Uint8Array(view.buffer, view.byteOffset, PAGE_SIZE);
    const computed = computePage1Checksum(page_bytes);
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
export function catalog_get_total_pages(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
}

/**
 * @export_c
 */
export function catalog_set_total_pages(view: DataView, count: number): void {
  view.setUint32(HEADER_OFFSET_TOTAL_PAGES, count, true);
}

/**
 * @export_c
 */
export function catalog_get_free_page_head(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_FREE_PAGE_HEAD, true);
}

/**
 * @export_c
 */
export function catalog_set_free_page_head(
  view: DataView,
  page_id: number,
): void {
  view.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, page_id, true);
}

/**
 * @export_c
 */
export function catalog_get_schema_version(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
}

/**
 * @export_c
 */
export function catalog_increment_schema_version(view: DataView): number {
  const v = catalog_get_schema_version(view) + 1;
  view.setUint32(HEADER_OFFSET_SCHEMA_VERSION, v, true);
  return v;
}

/**
 * @export_c
 */
export function catalog_get_change_counter(view: DataView): number {
  return view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
}

/**
 * @export_c
 */
export function catalog_increment_change_counter(view: DataView): number {
  const c = catalog_get_change_counter(view) + 1;
  view.setUint32(HEADER_OFFSET_CHANGE_COUNTER, c, true);
  return c;
}

/**
 * @export_c
 */
export function catalog_update_page1_checksum(view: DataView): number {
  const chk = computePage1Checksum(
    new Uint8Array(view.buffer, view.byteOffset, PAGE_SIZE),
  );
  view.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, chk, true);
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
  offset: number,
  str: string,
  max_len: number,
): void {
  const bytes = text_encoder.encode(str);
  for (let i = 0; i < max_len; i++) {
    view.setUint8(offset + i, i < bytes.length ? bytes[i] : 0);
  }
}

/**
 * @export_c
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
 * @export_c
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
// 3. Table Descriptor & Master Table Accessors (Page 1)
// ============================================================================

/**
 * @export_c
 * Reads a TableDescriptor from Page 1 by slot index (0..15).
 */
export function catalog_read_table_descriptor(
  view: DataView,
  slot_idx: number,
): TableDescriptor | null {
  const offset = MASTER_TABLE_OFFSET + slot_idx * TABLE_DESCRIPTOR_SIZE;
  const table_id = view.getUint16(offset + 0, true);
  if (table_id === 0) return null;

  const column_count = view.getUint16(offset + 2, true);
  const root_page_id = view.getUint32(offset + 4, true);
  const col_catalog_page_id = view.getUint32(offset + 8, true);
  const name = catalog_read_fixed_string(view, offset + 12, MAX_NAME_LENGTH);
  const flags = view.getUint32(offset + 76, true);
  const row_count_estimate = view.getUint32(offset + 80, true);
  const auto_inc_next = view.getBigUint64(offset + 84, true);

  return {
    tableId: table_id,
    columnCount: column_count,
    rootPageId: root_page_id,
    colCatalogPageId: col_catalog_page_id,
    name,
    flags,
    rowCountEstimate: row_count_estimate,
    autoIncNext: auto_inc_next,
  };
}

/**
 * @export_c
 * Writes a TableDescriptor into Page 1 at the specified slot index (0..15).
 */
export function catalog_write_table_descriptor(
  view: DataView,
  slot_idx: number,
  desc: TableDescriptor,
): void {
  const offset = MASTER_TABLE_OFFSET + slot_idx * TABLE_DESCRIPTOR_SIZE;
  view.setUint16(offset + 0, desc.tableId, true);
  view.setUint16(offset + 2, desc.columnCount, true);
  view.setUint32(offset + 4, desc.rootPageId, true);
  view.setUint32(offset + 8, desc.colCatalogPageId, true);
  catalog_write_fixed_string(view, offset + 12, desc.name, MAX_NAME_LENGTH);
  view.setUint32(offset + 76, desc.flags, true);
  view.setUint32(offset + 80, desc.rowCountEstimate, true);
  view.setBigUint64(offset + 84, desc.autoIncNext, true);
  // Clear reserved 36 bytes (92..127)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, offset + 92, offset + TABLE_DESCRIPTOR_SIZE);
}

/**
 * @export_c
 */
export function catalog_find_table_by_name(
  view: DataView,
  table_name: string,
): TableDescriptor | null {
  const slot = catalog_find_table_slot(view, table_name);
  return slot !== -1 ? catalog_read_table_descriptor(view, slot) : null;
}

/**
 * @export_c
 * Finds the slot index of an existing table by name, or -1 if not found.
 */
export function catalog_find_table_slot(
  view: DataView,
  table_name: string,
): number {
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const desc = catalog_read_table_descriptor(view, i);
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
 * @export_c
 * Finds the first free slot index in Page 1's TableDescriptor array.
 */
export function catalog_find_free_table_slot(view: DataView): number {
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const desc = catalog_read_table_descriptor(view, i);
    if (!desc || (desc.flags & TableFlag.ACTIVE) === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * @export_c
 * Lists all active tables defined on Page 1.
 */
export function catalog_list_table_descriptors(
  view: DataView,
): TableDescriptor[] {
  const tables: TableDescriptor[] = [];
  for (let i = 0; i < MAX_TABLES_PAGE1; i++) {
    const desc = catalog_read_table_descriptor(view, i);
    if (desc && (desc.flags & TableFlag.ACTIVE) !== 0) {
      tables.push(desc);
    }
  }
  return tables;
}

// ============================================================================
// 4. Index Descriptor Accessors (Page 1: bytes 2148..3171)
// ============================================================================

/**
 * @export_c
 */
export function catalog_read_index_descriptor(
  view: DataView,
  slot_idx: number,
): IndexDescriptor | null {
  const offset = INDEX_CATALOG_OFFSET + slot_idx * INDEX_DESCRIPTOR_SIZE;
  const index_id = view.getUint16(offset + 0, true);

  if (index_id === 0) return null;

  const table_id = view.getUint16(offset + 2, true);
  const root_page_id = view.getUint32(offset + 4, true);
  const column_count = view.getUint8(offset + 8);
  const flags = view.getUint8(offset + 9);

  const column_indices: number[] = [];

  for (let i = 0; i < 8; i++) {
    column_indices.push(view.getUint16(offset + 10 + i * 2, true));
  }

  const col_directions: number[] = [];

  for (let i = 0; i < 8; i++) {
    col_directions.push(view.getUint8(offset + 26 + i));
  }

  const name = catalog_read_fixed_string(view, offset + 34, MAX_NAME_LENGTH);

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
 * @export_c
 */
export function catalog_write_index_descriptor(
  view: DataView,
  slot_idx: number,
  desc: IndexDescriptor,
): void {
  const offset = INDEX_CATALOG_OFFSET + slot_idx * INDEX_DESCRIPTOR_SIZE;

  view.setUint16(offset + 0, desc.indexId, true);
  view.setUint16(offset + 2, desc.tableId, true);
  view.setUint32(offset + 4, desc.rootPageId, true);
  view.setUint8(offset + 8, desc.columnCount);
  view.setUint8(offset + 9, desc.flags);

  for (let i = 0; i < 8; i++) {
    view.setUint16(offset + 10 + i * 2, desc.columnIndices[i] ?? 0, true);
  }

  for (let i = 0; i < 8; i++) {
    view.setUint8(offset + 26 + i, desc.colDirections[i] ?? 0);
  }

  catalog_write_fixed_string(view, offset + 34, desc.name, MAX_NAME_LENGTH);

  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(0, offset + 98, offset + INDEX_DESCRIPTOR_SIZE);
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
  page_offset: number,
  table_id: number,
  start_col_index: number,
  next_col_catalog_page_id: number = 0,
): void {
  view.setUint8(page_offset + 0, PAGE_TYPE_CATALOG_PAGE);
  view.setUint8(page_offset + 1, 0); // flags
  view.setUint16(page_offset + 2, 0, true); // col_count_in_page = 0
  view.setUint16(page_offset + 4, table_id, true);
  view.setUint16(page_offset + 6, start_col_index, true);
  view.setUint32(page_offset + 8, next_col_catalog_page_id, true);
  view.setUint32(page_offset + 12, 0, true); // checksum

  // Zero payload area (16..4095)
  const uint8 = new Uint8Array(view.buffer, view.byteOffset);
  uint8.fill(
    0,
    page_offset + CATALOG_PAGE_HEADER_SIZE,
    page_offset + PAGE_SIZE,
  );
}

/**
 * @export_c
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
  page_offset: number,
  header: CatalogPageHeader,
): void {
  view.setUint8(page_offset + 0, header.pageType);
  view.setUint8(page_offset + 1, header.flags);
  view.setUint16(page_offset + 2, header.colCountInPage, true);
  view.setUint16(page_offset + 4, header.tableId, true);
  view.setUint16(page_offset + 6, header.startColIndex, true);
  view.setUint32(page_offset + 8, header.nextColCatalogPageId, true);
  view.setUint32(page_offset + 12, header.pageChecksum, true);
}

/**
 * @export_c
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
 * @export_c
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
 * @export_c
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
 * @export_c
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
  if (catalog_find_table_slot(page1_view, name) !== -1) {
    throw new TableAlreadyExistsError(name);
  }

  // Find free slot in Page 1 TableDescriptor slots
  const slot_idx = catalog_find_free_table_slot(page1_view);

  if (slot_idx === -1) {
    throw new TooManyTablesError(MAX_TABLES_PAGE1, MAX_TABLES_PAGE1);
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
    if (def.primaryKey || def.flags?.primaryKey)
      flags |= ColumnFlag.PRIMARY_KEY;
    if (def.notNull || def.flags?.notNull) flags |= ColumnFlag.NOT_NULL;
    if (def.indexed || def.flags?.indexed) flags |= ColumnFlag.INDEXED;
    if (def.autoInc || def.flags?.autoInc) flags |= ColumnFlag.AUTO_INC;

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

  // Write TableDescriptor into Page 1
  const desc: TableDescriptor = {
    tableId: table_id,
    columnCount: total_cols,
    rootPageId: root_page_id,
    colCatalogPageId: first_catalog_page_id,
    name,
    flags: TableFlag.ACTIVE,
    rowCountEstimate: 0,
    autoIncNext: 1n,
  };

  catalog_write_table_descriptor(page1_view, slot_idx, desc);
  catalog_increment_schema_version(page1_view);
  catalog_increment_change_counter(page1_view);
  catalog_update_page1_checksum(page1_view);

  return {
    ...desc,
    columns,
  };
}

/**
 * @export_c
 * Loads the complete TableMeta (including all columns from chained catalog pages) for a table.
 */
export function catalog_load_table_meta(
  page1_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager: { getPageBytes(pageId: number): Uint8Array },
  table_name: string,
): TableMeta {
  const slot_idx = catalog_find_table_slot(page1_view, table_name);

  if (slot_idx === -1) {
    throw new TableNotFoundError(table_name);
  }

  const desc = catalog_read_table_descriptor(page1_view, slot_idx)!;
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

  return {
    ...desc,
    columns,
  };
}

/**
 * @export_c
 * Loads all active tables and their full schemas from Page 1.
 */
export function catalog_load_all_tables(
  page1_view: DataView,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pager: { getPageBytes(pageId: number): Uint8Array },
): TableMeta[] {
  const descriptors = catalog_list_table_descriptors(page1_view);
  const tables: TableMeta[] = [];
  for (let i = 0; i < descriptors.length; i++) {
    tables.push(
      catalog_load_table_meta(page1_view, pager, descriptors[i].name),
    );
  }
  return tables;
}
