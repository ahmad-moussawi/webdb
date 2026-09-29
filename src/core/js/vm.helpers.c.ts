import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  PAGE_TO_SLOT_OFFSET,
  PAGE_TO_SLOT_SIZE,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
} from "../../constants.ts";
import {
  VmStatus,
  DataType,
  ColumnMeta,
  ColumnFlag,
} from "../../types/index.ts";
import { page_serialize_row } from "./page.c.ts";
import { buf_pool_get_resident_slot } from "./buffer_pool.c.ts";
import {
  type VmCursor,
  type VmContext,
  type VmKeyInfo,
  type VmSorter,
  type VmSorterEntry,
  type VmAggBucket,
} from "../../shared/index.ts";

/**
 * Returns the active cursor for cursor_idx (0..15), falling back to ctx.cursor.
 */
export function get_cursor(ctx: VmContext, cursor_idx: number): VmCursor {
  if (ctx.cursors && ctx.cursors[cursor_idx]) {
    return ctx.cursors[cursor_idx];
  }
  return ctx.cursor;
}

/**
 * Resolves the byte offset in linear memory for a given page_id.
 * If the buffer pool page-to-slot table is populated, maps via the resident slot.
 * Otherwise falls back to standalone direct calculation: (page_id - 1) * PAGE_SIZE.
 */
export function resolve_page_offset(view: DataView, page_id: number): number {
  if (page_id <= 0) return 0;
  if (view.byteLength >= PAGE_TO_SLOT_OFFSET + PAGE_TO_SLOT_SIZE) {
    const slot = buf_pool_get_resident_slot(
      view,
      PAGE_TO_SLOT_OFFSET,
      DEFAULT_PAGE_TO_SLOT_BUCKETS,
      page_id,
    );
    if (slot >= 0) {
      return slot * PAGE_SIZE;
    }
  }
  return (page_id - 1) * PAGE_SIZE;
}

/**
 * Three-Valued Logic (3VL) comparator for evaluation registers.
 * If either value is null or undefined, returns is_unknown = true.
 */
export function compare_3vl(
  val_a: any,
  val_b: any,
): { result: number; is_unknown: boolean } {
  if (
    val_a === null ||
    val_a === undefined ||
    val_b === null ||
    val_b === undefined
  ) {
    return { result: 0, is_unknown: true };
  }

  if (typeof val_a === "boolean" || typeof val_b === "boolean") {
    const num_a = val_a ? 1 : 0;
    const num_b = val_b ? 1 : 0;
    if (num_a === num_b) return { result: 0, is_unknown: false };
    return { result: num_a > num_b ? 1 : -1, is_unknown: false };
  }

  if (typeof val_a === "number" && typeof val_b === "number") {
    if (val_a === val_b) return { result: 0, is_unknown: false };
    return { result: val_a > val_b ? 1 : -1, is_unknown: false };
  }

  if (typeof val_a === "bigint" || typeof val_b === "bigint") {
    const a = BigInt(val_a);
    const b = BigInt(val_b);
    if (a === b) return { result: 0, is_unknown: false };
    return { result: a > b ? 1 : -1, is_unknown: false };
  }

  if (typeof val_a === "string" && typeof val_b === "string") {
    if (val_a === val_b) return { result: 0, is_unknown: false };
    return { result: val_a > val_b ? 1 : -1, is_unknown: false };
  }

  if (val_a instanceof Uint8Array && val_b instanceof Uint8Array) {
    const min_len = Math.min(val_a.byteLength, val_b.byteLength);
    for (let i = 0; i < min_len; i++) {
      if (val_a[i] !== val_b[i]) {
        return { result: val_a[i] > val_b[i] ? 1 : -1, is_unknown: false };
      }
    }
    if (val_a.byteLength === val_b.byteLength) {
      return { result: 0, is_unknown: false };
    }
    return {
      result: val_a.byteLength > val_b.byteLength ? 1 : -1,
      is_unknown: false,
    };
  }

  if (val_a === val_b) return { result: 0, is_unknown: false };
  return { result: val_a > val_b ? 1 : -1, is_unknown: false };
}

/**
 * Standard SQL LIKE pattern matcher supporting '%' (any sequence) and '_' (any single character).
 * Case-insensitive for ASCII matching according to SQLite semantics.
 */
export function sql_like_match(str: string, pattern: string): boolean {
  let s = 0;
  let p = 0;
  let star_p = -1;
  let star_s = -1;

  const s_len = str.length;
  const p_len = pattern.length;

  while (s < s_len) {
    if (
      p < p_len &&
      (pattern[p] === "_" || pattern[p].toLowerCase() === str[s].toLowerCase())
    ) {
      s++;
      p++;
    } else if (p < p_len && pattern[p] === "%") {
      star_p = p++;
      star_s = s;
    } else if (star_p !== -1) {
      p = star_p + 1;
      s = ++star_s;
    } else {
      return false;
    }
  }

  while (p < p_len && pattern[p] === "%") {
    p++;
  }

  return p === p_len;
}

/**
 * Compares two sets of sort keys according to KeyInfo descriptor.
 * Strictly adheres to SQLite NULL collation (NULL is smaller than any non-NULL value)
 * and honors independent per-column ASC/DESC and NULLS_FIRST/NULLS_LAST.
 */
export function compare_sorter_keys(
  keys_a: any[],
  keys_b: any[],
  key_info: VmKeyInfo,
): number {
  const num_keys = key_info.numKeys;
  for (let k = 0; k < num_keys; k++) {
    const a = keys_a[k];
    const b = keys_b[k];
    const direction = key_info.directions[k] ?? 0; // 0 = ASC, 1 = DESC
    const null_order = key_info.nullOrders[k] ?? (direction === 1 ? 1 : 0); // 0 = NULLS_FIRST, 1 = NULLS_LAST

    const a_is_null = a === null || a === undefined;
    const b_is_null = b === null || b === undefined;

    if (a_is_null && b_is_null) {
      continue;
    }

    if (a_is_null || b_is_null) {
      const cmp = null_order === 0 ? (a_is_null ? -1 : 1) : a_is_null ? 1 : -1;
      return cmp;
    }

    // Both non-null
    let cmp = 0;
    if (typeof a === "number" && typeof b === "number") {
      cmp = a < b ? -1 : a > b ? 1 : 0;
    } else if (typeof a === "bigint" || typeof b === "bigint") {
      const ba = BigInt(a);
      const bb = BigInt(b);
      cmp = ba < bb ? -1 : ba > bb ? 1 : 0;
    } else if (typeof a === "string" && typeof b === "string") {
      cmp = a < b ? -1 : a > b ? 1 : 0;
    } else if (a instanceof Uint8Array && b instanceof Uint8Array) {
      const min_len = Math.min(a.byteLength, b.byteLength);
      for (let i = 0; i < min_len; i++) {
        if (a[i] !== b[i]) {
          cmp = a[i] < b[i] ? -1 : 1;
          break;
        }
      }
      if (cmp === 0) {
        cmp =
          a.byteLength < b.byteLength
            ? -1
            : a.byteLength > b.byteLength
              ? 1
              : 0;
      }
    } else {
      cmp = (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;
    }

    if (cmp !== 0) {
      return direction === 1 ? -cmp : cmp;
    }
  }
  return 0;
}

/**
 * Compares sort keys stored in contiguous registers against a target entry's keys.
 * Avoids allocating an intermediate array for rejected Top-K candidates.
 */
export function compare_registers_to_sorter_keys(
  registers: any[],
  start_reg: number,
  keys_b: any[],
  key_info: VmKeyInfo,
): number {
  const num_keys = key_info.numKeys;
  for (let k = 0; k < num_keys; k++) {
    const a = registers[start_reg + k];
    const b = keys_b[k];
    const direction = key_info.directions[k] ?? 0;
    const null_order = key_info.nullOrders[k] ?? (direction === 1 ? 1 : 0);

    const a_is_null = a === null || a === undefined;
    const b_is_null = b === null || b === undefined;

    if (a_is_null && b_is_null) continue;
    if (a_is_null || b_is_null) {
      return null_order === 0 ? (a_is_null ? -1 : 1) : a_is_null ? 1 : -1;
    }

    let cmp = 0;
    if (typeof a === "number" && typeof b === "number") {
      cmp = a < b ? -1 : a > b ? 1 : 0;
    } else if (typeof a === "string" && typeof b === "string") {
      cmp = a < b ? -1 : a > b ? 1 : 0;
    } else if (typeof a === "bigint" || typeof b === "bigint") {
      const ba = BigInt(a);
      const bb = BigInt(b);
      cmp = ba < bb ? -1 : ba > bb ? 1 : 0;
    } else if (a instanceof Uint8Array && b instanceof Uint8Array) {
      const min_len = Math.min(a.byteLength, b.byteLength);
      for (let i = 0; i < min_len; i++) {
        if (a[i] !== b[i]) {
          cmp = a[i] < b[i] ? -1 : 1;
          break;
        }
      }
      if (cmp === 0) {
        cmp = a.byteLength < b.byteLength ? -1 : a.byteLength > b.byteLength ? 1 : 0;
      }
    } else {
      cmp = (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;
    }

    if (cmp !== 0) {
      return direction === 1 ? -cmp : cmp;
    }
  }
  return 0;
}

/**
 * 32-bit FNV-1a hash over grouping key values.
 * Returns non-zero uint32 (reserving 0 as empty bucket marker).
 */
export function fnv1a_32(values: any[]): number {
  let hash = 0x811c9dc5; // 2166136261
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (v === null || v === undefined) {
      hash ^= 0xff;
      hash = Math.imul(hash, 0x01000193);
    } else if (typeof v === "number") {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, v, true);
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < 8; i++) {
        hash ^= u8[i];
        hash = Math.imul(hash, 0x01000193);
      }
    } else if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) {
        hash ^= v.charCodeAt(i) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    } else if (typeof v === "bigint") {
      const n = Number(v);
      hash ^= n & 0xff;
      hash = Math.imul(hash, 0x01000193);
    } else if (v instanceof Uint8Array) {
      for (let i = 0; i < v.byteLength; i++) {
        hash ^= v[i];
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  hash = hash >>> 0;
  return hash === 0 ? 1 : hash;
}

/**
 * Checks equality between two sets of grouping keys.
 * In SQL GROUP BY: two NULLs in grouping columns are considered identical!
 */
export function group_keys_match(keys_a: any[], keys_b: any[]): boolean {
  if (keys_a.length !== keys_b.length) {
    return false;
  }

  for (let i = 0; i < keys_a.length; i++) {
    const a = keys_a[i];
    const b = keys_b[i];

    if (a === null || a === undefined) {
      if (b !== null && b !== undefined) return false;
    } else if (b === null || b === undefined) {
      return false;
    } else if (a !== b) {
      if (a instanceof Uint8Array && b instanceof Uint8Array) {
        if (a.byteLength !== b.byteLength) return false;
        for (let j = 0; j < a.byteLength; j++) {
          if (a[j] !== b[j]) return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}

/**
 * Allocates and initializes an array of empty aggregate buckets.
 */
export function create_agg_buckets(capacity: number): VmAggBucket[] {
  const buckets: VmAggBucket[] = new Array(capacity);
  for (let i = 0; i < capacity; i++) {
    buckets[i] = {
      hash: 0,
      keys: [],
      count: 0,
      sum: 0,
      min_val: Infinity,
      max_val: -Infinity,
      has_val: false,
    };
  }
  return buckets;
}

/**
 * Sifts down an entry at index in a max-heap of top-K entries.
 * The root (index 0) contains the worst entry (largest/latest in sorted order).
 */
export function heap_sift_down(
  entries: VmSorterEntry[],
  index: number,
  length: number,
  key_info: VmKeyInfo,
): void {
  let curr = index;
  while (true) {
    let largest = curr;
    const left = 2 * curr + 1;
    const right = 2 * curr + 2;

    if (
      left < length &&
      compare_sorter_keys(entries[left].keys, entries[largest].keys, key_info) > 0
    ) {
      largest = left;
    }
    if (
      right < length &&
      compare_sorter_keys(entries[right].keys, entries[largest].keys, key_info) > 0
    ) {
      largest = right;
    }

    if (largest !== curr) {
      const temp = entries[curr];
      entries[curr] = entries[largest];
      entries[largest] = temp;
      curr = largest;
    } else {
      break;
    }
  }
}

/**
 * Sorts sorter entries using collation keys and initializes readIdx at offset.
 */
export function sort_sorter_entries(sorter: VmSorter): void {
  const key_info = sorter.keyInfo;
  sorter.entries.sort((a: VmSorterEntry, b: VmSorterEntry) =>
    compare_sorter_keys(a.keys, b.keys, key_info),
  );
  sorter.readIdx = key_info.offset ?? 0;
}

/**
 * Copies a contiguous slice of row bytes from linear memory.
 */
export function copy_row_bytes(
  view: DataView,
  offset: number,
  length: number,
): Uint8Array {
  const src = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  const dest = new Uint8Array(length);
  dest.set(src);
  return dest;
}

/**
 * Inserts or replaces a row entry into the in-arena sorter.
 * Employs a Top-K bounded max-heap optimization when max_k > 0.
 */
export function sorter_insert_row(
  ctx: VmContext,
  sorter: VmSorter,
  keys: any[],
  cursor_row_offset: number,
  row_len: number,
  view: DataView,
  max_k: number,
): VmStatus {
  // If Top-K heap capacity reached:
  if (max_k > 0 && sorter.entries.length >= max_k) {
    const cmp = compare_sorter_keys(
      keys,
      sorter.entries[0].keys,
      sorter.keyInfo,
    );
    if (cmp >= 0) {
      // Candidate is worse than or equal to the worst element in top-K: discard immediately
      return VmStatus.RUNNING;
    }

    // Candidate is better than worst element: replace root and sift down
    const old_entry = sorter.entries[0];
    const diff = row_len - old_entry.rowLen;
    if (diff > 0 && ctx.arenaOffset + diff > ctx.maxQueryMemory) {
      ctx.status = VmStatus.ARENA_EXHAUSTED;
      return VmStatus.ARENA_EXHAUSTED;
    }
    ctx.arenaOffset += diff;

    const row_data = copy_row_bytes(view, cursor_row_offset, row_len);
    old_entry.keys = keys;
    old_entry.rowOffset = cursor_row_offset;
    old_entry.rowLen = row_len;
    old_entry.rowData = row_data;
    heap_sift_down(sorter.entries, 0, max_k, sorter.keyInfo);
    return VmStatus.RUNNING;
  }

  // Regular insertion (or accumulating elements before reaching max_k)
  const entry_size = 16 + 16 * keys.length + row_len;
  if (ctx.arenaOffset + entry_size > ctx.maxQueryMemory) {
    ctx.status = VmStatus.ARENA_EXHAUSTED;
    return VmStatus.ARENA_EXHAUSTED;
  }
  ctx.arenaOffset += entry_size;

  const row_data = copy_row_bytes(view, cursor_row_offset, row_len);
  sorter.entries.push({
    keys,
    rowOffset: cursor_row_offset,
    rowLen: row_len,
    rowData: row_data,
  });

  // If top-K threshold just reached, heapify
  if (max_k > 0 && sorter.entries.length === max_k) {
    for (let h = Math.floor(max_k / 2) - 1; h >= 0; h--) {
      heap_sift_down(sorter.entries, h, max_k, sorter.keyInfo);
    }
  }

  return VmStatus.RUNNING;
}

/**
 * Serializes register values into a binary row based on the current query schema context.
 *
 * Responsibilities across the 3 branches:
 * 1. Explicit Output Projection (`ctx.outputColumns`):
 *    Handles queries with transformed output schemas (e.g. GROUP BY aggregations,
 *    computed expressions, or column aliases) defined in `ctx.outputColumns`.
 * 2. Physical Table Schema (`ctx.table.columns`):
 *    Handles standard row scans where the number of emitted registers
 *    matches the physical table schema in `ctx.table`.
 * 3. Dynamic Runtime Type Inference (Fallback):
 *    Handles ad-hoc expressions, partial projections, or subqueries lacking
 *    pre-compiled schema metadata, inferring data types (INT32, FLOAT64, INT64, BLOB, TEXT)
 *    directly from register values.
 */
export function serialize_result_registers(
  ctx: VmContext,
  start_reg: number,
  num_cols: number,
): Uint8Array {
  let cols: ColumnMeta[];
  const record: Record<string, any> = {};

  // Branch 1: Explicit Output Projection
  // Responsibility: GROUP BY aggregations, aliases, and custom projection schemas
  if (ctx.outputColumns && num_cols === ctx.outputColumns.length) {
    cols = ctx.outputColumns;
    for (let c = 0; c < num_cols; c++) {
      record[cols[c].name] = ctx.registers[start_reg + c];
    }
  }
  // Branch 2: Physical Table Schema
  // Responsibility: Standard full-table column emission matching physical table columns
  else if (ctx.table && num_cols === ctx.table.columns.length) {
    cols = ctx.table.columns;
    for (let c = 0; c < num_cols; c++) {
      record[cols[c].name] = ctx.registers[start_reg + c];
    }
  }
  // Branch 3: Dynamic Runtime Type Inference (Fallback)
  // Responsibility: Ad-hoc expressions, partial projections, or subqueries without pre-set metadata
  else {
    cols = [];
    for (let c = 0; c < num_cols; c++) {
      const val = ctx.registers[start_reg + c];
      const col_name = ctx.table?.columns[c]?.name ?? `col_${c}`;
      let col_type = DataType.TEXT;
      if (typeof val === "number") {
        col_type = Number.isInteger(val) ? DataType.INT32 : DataType.FLOAT64;
      } else if (typeof val === "bigint") {
        col_type = DataType.INT64;
      } else if (val instanceof Uint8Array) {
        col_type = DataType.BLOB;
      }
      cols.push({
        name: col_name,
        type: col_type,
        flags: ColumnFlag.NONE,
        colOffset: 0,
      });
      record[col_name] = val;
    }
  }

  return page_serialize_row(cols, record);
}

/**
 * Writes serialized row bytes into the 64KB Output Result Buffer.
 * Prepends a 2-byte uint16 length prefix. Yields BUFFER_FULL on overflow.
 */
export function emit_to_result_buffer(
  ctx: VmContext,
  view: DataView,
  row_bytes: Uint8Array,
  instr_pc: number,
): VmStatus {
  const needed = 2 + row_bytes.byteLength;
  if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
    ctx.status = VmStatus.BUFFER_FULL;
    ctx.pc = instr_pc;
    return VmStatus.BUFFER_FULL;
  }

  const out_target = RESULT_BUFFER_OFFSET + ctx.resultOffset;
  view.setUint16(out_target, row_bytes.byteLength, true);
  const dest = new Uint8Array(
    view.buffer,
    view.byteOffset + out_target + 2,
    row_bytes.byteLength,
  );
  dest.set(row_bytes);

  ctx.resultOffset += needed;
  ctx.resultCount++;
  return VmStatus.RUNNING;
}

/**
 * Tests whether a column in the row is marked NULL in the null-bitmap.
 */
export function row_is_null(
  view: DataView,
  null_bitmap_offset: number,
  col_idx: number,
): boolean {
  return (
    (view.getUint8(null_bitmap_offset + (col_idx >> 3)) &
      (1 << (col_idx & 7))) !==
    0
  );
}

/**
 * Computes the byte offset of a fixed-width column within a row record,
 * or the start of the variable-length offset table if target_col_idx == column_count.
 */
export function compute_fixed_column_offset(
  view: DataView,
  null_bitmap_offset: number,
  null_bitmap_bytes: number,
  columns: ColumnMeta[],
  target_col_idx: number,
): number {
  let col_offset = null_bitmap_offset + null_bitmap_bytes;
  for (let i = 0; i < target_col_idx; i++) {
    if (!row_is_null(view, null_bitmap_offset, i)) {
      const prev_col = columns[i];
      switch (prev_col.type) {
        case DataType.INT32:
          col_offset += 4;
          break;
        case DataType.INT64:
        case DataType.FLOAT64:
          col_offset += 8;
          break;
        case DataType.UUID:
        case DataType.ULID:
          col_offset += 16;
          break;
      }
    }
  }
  return col_offset;
}
