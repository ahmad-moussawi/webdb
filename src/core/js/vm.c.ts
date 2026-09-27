import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  PAGE_TO_SLOT_OFFSET,
  PAGE_TO_SLOT_SIZE,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  SLOT_TO_PAGE_OFFSET,
} from "../../constants.ts";
import {
  OpCode,
  VmStatus,
  DataType,
  ColumnMeta,
  ColumnFlag,
} from "../../types/index.ts";
import {
  page_get_cell_count,
  page_get_cell_offset,
  page_get_next_page_id,
  page_serialize_row,
} from "./page.c.ts";
import { buf_pool_get_resident_slot } from "./buffer_pool.c.ts";
import { UuidCodec, UlidCodec } from "./codecs.c.ts";

import {
  type VmCursor,
  type VmContext,
  type VmKeyInfo,
  type VmSorter,
  type VmSorterEntry,
  type VmAggBucket,
  createVmContext,
  resetVmContext,
} from "../../shared/index.ts";

export { createVmContext, resetVmContext };
export type {
  VmCursor,
  VmContext,
  VmKeyInfo,
  VmSorter,
  VmSorterEntry,
  VmAggBucket,
};

const text_decoder = new TextDecoder();

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
function create_agg_buckets(capacity: number): VmAggBucket[] {
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
 * Sorts sorter entries using collation keys.
 */
function sort_sorter_entries(sorter: VmSorter): void {
  const key_info = sorter.keyInfo;
  sorter.entries.sort((a: VmSorterEntry, b: VmSorterEntry) =>
    compare_sorter_keys(a.keys, b.keys, key_info),
  );
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

/**
 * @export_c
 * Synchronous Bytecode VM execution step loop.
 * Runs instructions until STATUS_DONE, STATUS_BUFFER_FULL, or an error.
 */
export function vm_step(
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array,
): VmStatus {
  const code_view = new DataView(
    bytecode.buffer,
    bytecode.byteOffset,
    bytecode.byteLength,
  );
  const code_len = bytecode.byteLength;

  const MAX_CYCLES = 10_000_000;
  let cycles = 0;

  const has_buffer_pool =
    view.byteLength >= SLOT_TO_PAGE_OFFSET + 4 &&
    view.getUint32(SLOT_TO_PAGE_OFFSET, true) > 0;

  while (ctx.pc < code_len) {
    if (++cycles > MAX_CYCLES) {
      ctx.status = VmStatus.TIMEOUT;
      return VmStatus.TIMEOUT;
    }

    const instr_pc = ctx.pc;
    const op = bytecode[ctx.pc];
    ctx.pc += 1;

    switch (op) {
      /**
       * OP_HALT (0x00)
       * Operands: none (0 bytes)
       * Halts VM execution successfully; sets status to STATUS_DONE.
       */
      case OpCode.OP_HALT: {
        ctx.arenaOffset = 0;
        ctx.status = VmStatus.DONE;
        return VmStatus.DONE;
      }

      /**
       * OP_OPEN_CURSOR (0x01)
       * Operands: [cursor_idx: uint8] [root_page_id: uint32] (5 bytes)
       * Binds cursor[cursor_idx] to a table or index root page ID.
       * Resets the cursor's cellIdx and rowOffset to 0.
       */
      case OpCode.OP_OPEN_CURSOR: {
        const cursor_idx = bytecode[ctx.pc];
        const root_page_id = code_view.getUint32(ctx.pc + 1, true);
        ctx.pc += 5;

        const cursor = get_cursor(ctx, cursor_idx);
        cursor.pageId = root_page_id;
        cursor.cellIdx = 0;
        cursor.rowOffset = 0;

        if (has_buffer_pool && root_page_id > 0) {
          const slot = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            root_page_id,
          );
          if (slot < 0) {
            ctx.fault_page_id = root_page_id;
            ctx.status = VmStatus.PAGE_FAULT;
            ctx.pc = instr_pc;
            return VmStatus.PAGE_FAULT;
          }
          cursor.slotIdx = slot;
        }
        break;
      }

      /**
       * OP_REWIND (0x02)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Positions cursor[cursor_idx] at the first cell (index 0) of root page.
       * If the table has 0 rows (cell_count == 0), branches to jump_target (EOF).
       */
      case OpCode.OP_REWIND: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);

        if (has_buffer_pool && cursor.pageId > 0) {
          const slot = buf_pool_get_resident_slot(
            view,
            PAGE_TO_SLOT_OFFSET,
            DEFAULT_PAGE_TO_SLOT_BUCKETS,
            cursor.pageId,
          );
          if (slot < 0) {
            ctx.fault_page_id = cursor.pageId;
            ctx.status = VmStatus.PAGE_FAULT;
            ctx.pc = instr_pc;
            return VmStatus.PAGE_FAULT;
          }
          cursor.slotIdx = slot;
        }

        const page_offset = resolve_page_offset(view, cursor.pageId);
        const cell_count = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          ctx.pc = jump_target;
        } else {
          cursor.cellIdx = 0;
          const rel_cell_offset = page_get_cell_offset(view, page_offset, 0);
          cursor.rowOffset = page_offset + rel_cell_offset;
        }
        break;
      }

      /**
       * OP_NEXT_ROW (0x03)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Advances cursor[cursor_idx] to the next cell. If all cells on the
       * current page are exhausted, traverses next_page_id to the linked sibling
       * leaf page. Jumps to jump_target when EOF (no more pages) is reached.
       */
      case OpCode.OP_NEXT_ROW: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const page_offset = resolve_page_offset(view, cursor.pageId);
        const cell_count = page_get_cell_count(view, page_offset);

        const next_cell_idx = cursor.cellIdx + 1;
        if (next_cell_idx < cell_count) {
          cursor.cellIdx = next_cell_idx;
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            cursor.cellIdx,
          );
          cursor.rowOffset = page_offset + rel_cell_offset;
        } else {
          // Check if there is a next page linked for this table
          const next_page_id = page_get_next_page_id(view, page_offset);
          if (next_page_id !== 0) {
            if (has_buffer_pool) {
              const slot = buf_pool_get_resident_slot(
                view,
                PAGE_TO_SLOT_OFFSET,
                DEFAULT_PAGE_TO_SLOT_BUCKETS,
                next_page_id,
              );
              if (slot < 0) {
                // Page miss: leave cursor on current page and cell, rewind PC to re-evaluate after load
                ctx.fault_page_id = next_page_id;
                ctx.status = VmStatus.PAGE_FAULT;
                ctx.pc = instr_pc;
                return VmStatus.PAGE_FAULT;
              }
              cursor.slotIdx = slot;
            }

            cursor.pageId = next_page_id;
            cursor.cellIdx = 0;
            const next_offset = resolve_page_offset(view, next_page_id);
            const next_count = page_get_cell_count(view, next_offset);
            if (next_count > 0) {
              const rel_cell_offset = page_get_cell_offset(
                view,
                next_offset,
                0,
              );
              cursor.rowOffset = next_offset + rel_cell_offset;
            } else {
              ctx.pc = jump_target;
            }
          } else {
            // EOF reached
            ctx.pc = jump_target;
          }
        }
        break;
      }

      /**
       * OP_LAST (0x08)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Positions cursor at rightmost leaf cell for reverse scan.
       */
      case OpCode.OP_LAST: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const page_offset = resolve_page_offset(view, cursor.pageId);
        const cell_count = page_get_cell_count(view, page_offset);

        if (cell_count === 0) {
          ctx.pc = jump_target;
        } else {
          cursor.cellIdx = cell_count - 1;
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            cursor.cellIdx,
          );
          cursor.rowOffset = page_offset + rel_cell_offset;
        }
        break;
      }

      /**
       * OP_PREV_ROW (0x09)
       * Operands: [cursor_idx: uint8] [jump_target: uint16] (3 bytes)
       * Decrements cell index; jumps on beginning of table (BOF).
       */
      case OpCode.OP_PREV_ROW: {
        const cursor_idx = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const page_offset = resolve_page_offset(view, cursor.pageId);

        if (cursor.cellIdx > 0) {
          cursor.cellIdx--;
          const rel_cell_offset = page_get_cell_offset(
            view,
            page_offset,
            cursor.cellIdx,
          );
          cursor.rowOffset = page_offset + rel_cell_offset;
        } else {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_COLUMN_INT (0x04)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts an INT32 or INT64 column value from the current row under cursor.
       */
      case OpCode.OP_COLUMN_INT: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const col = table.columns[col_idx];
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        const col_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          col_idx,
        );

        if (col.type === DataType.INT32) {
          ctx.registers[reg_idx] = view.getInt32(col_offset, true);
        } else if (col.type === DataType.INT64) {
          ctx.registers[reg_idx] = Number(view.getBigInt64(col_offset, true));
        }
        break;
      }

      /**
       * OP_COLUMN_FLOAT (0x05)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts a 64-bit IEEE 754 float column from the row under cursor.
       */
      case OpCode.OP_COLUMN_FLOAT: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        const col_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          col_idx,
        );

        ctx.registers[reg_idx] = view.getFloat64(col_offset, true);
        break;
      }

      /**
       * OP_COLUMN_TEXT (0x06)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts a variable-length UTF-8 string (or formatted UUID/ULID string)
       * from the row under cursor into register r[reg_idx].
       */
      case OpCode.OP_COLUMN_UUID:
      case OpCode.OP_COLUMN_ULID:
      case OpCode.OP_COLUMN_TEXT: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        if (
          table.columns[col_idx].type === DataType.UUID ||
          table.columns[col_idx].type === DataType.ULID
        ) {
          const col_offset = compute_fixed_column_offset(
            view,
            null_bitmap_offset,
            null_bitmap_bytes,
            table.columns,
            col_idx,
          );

          const slice = new Uint8Array(
            view.buffer,
            view.byteOffset + col_offset,
            16,
          );

          ctx.registers[reg_idx] =
            table.columns[col_idx].type === DataType.UUID
              ? UuidCodec.decode(slice, 0)
              : UlidCodec.decode(slice, 0);
          break;
        }

        // Find start of var-offset table
        const var_table_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          table.columns.length,
        );

        let var_idx = 0;
        for (let i = 0; i < col_idx; i++) {
          const c = table.columns[i];
          if (c.type === DataType.TEXT || c.type === DataType.BLOB) {
            var_idx++;
          }
        }

        const entry_offset = var_table_offset + var_idx * 4;
        const rel_offset = view.getUint16(entry_offset, true);
        const len = view.getUint16(entry_offset + 2, true);

        if (len === 0) {
          ctx.registers[reg_idx] = "";
        } else {
          const text_bytes = new Uint8Array(
            view.buffer,
            cursor.rowOffset + rel_offset,
            len,
          );
          ctx.registers[reg_idx] = text_decoder.decode(text_bytes);
        }
        break;
      }

      /**
       * OP_COLUMN_BLOB (0x07)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [reg_idx: uint8] (3 bytes)
       * Extracts a variable-length binary BLOB column from the row under cursor.
       */
      case OpCode.OP_COLUMN_BLOB: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const reg_idx = bytecode[ctx.pc + 2];
        ctx.pc += 3;

        const cursor = get_cursor(ctx, cursor_idx);
        const table = ctx.table!;
        const null_bitmap_bytes = Math.ceil(table.columns.length / 8);
        const null_bitmap_offset = cursor.rowOffset + 3;

        if (row_is_null(view, null_bitmap_offset, col_idx)) {
          ctx.registers[reg_idx] = null;
          break;
        }

        const var_table_offset = compute_fixed_column_offset(
          view,
          null_bitmap_offset,
          null_bitmap_bytes,
          table.columns,
          table.columns.length,
        );

        let var_idx = 0;
        for (let i = 0; i < col_idx; i++) {
          const c = table.columns[i];
          if (c.type === DataType.TEXT || c.type === DataType.BLOB) {
            var_idx++;
          }
        }

        const entry_offset = var_table_offset + var_idx * 4;
        const rel_offset = view.getUint16(entry_offset, true);
        const len = view.getUint16(entry_offset + 2, true);

        const blob_copy = new Uint8Array(len);
        blob_copy.set(
          new Uint8Array(view.buffer, cursor.rowOffset + rel_offset, len),
        );
        ctx.registers[reg_idx] = blob_copy;
        break;
      }

      /**
       * OP_IS_NULL (0x10)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [jump_target: uint16] (4 bytes)
       * Evaluates SQL "col IS NULL". Tests the row's Null-Bitmap at col_idx.
       */
      case OpCode.OP_IS_NULL: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const null_bitmap_offset = cursor.rowOffset + 3;
        const is_null = row_is_null(view, null_bitmap_offset, col_idx);

        if (is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_IS_NOT_NULL (0x11)
       * Operands: [cursor_idx: uint8] [col_idx: uint8] [jump_target: uint16] (4 bytes)
       * Evaluates SQL "col IS NOT NULL". Tests the row's Null-Bitmap at col_idx.
       */
      case OpCode.OP_IS_NOT_NULL: {
        const cursor_idx = bytecode[ctx.pc];
        const col_idx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const null_bitmap_offset = cursor.rowOffset + 3;
        const is_null = row_is_null(view, null_bitmap_offset, col_idx);

        if (!is_null) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_EQ (0x12)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) equality check: r[reg_a] == r[reg_b].
       */
      case OpCode.OP_EQ: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result === 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_NE (0x13)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) inequality check: r[reg_a] !== r[reg_b].
       */
      case OpCode.OP_NE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result !== 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_GT (0x14)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) greater-than comparison: r[reg_a] > r[reg_b].
       */
      case OpCode.OP_GT: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result > 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_GE (0x15)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) greater-than-or-equal comparison: r[reg_a] >= r[reg_b].
       */
      case OpCode.OP_GE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result >= 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LT (0x16)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) less-than comparison: r[reg_a] < r[reg_b].
       */
      case OpCode.OP_LT: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result < 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LE (0x17)
       * Operands: [reg_a: uint8] [reg_b: uint8] [jump_target: uint16] (4 bytes)
       * Three-Valued Logic (3VL) less-than-or-equal comparison: r[reg_a] <= r[reg_b].
       */
      case OpCode.OP_LE: {
        const reg_a = bytecode[ctx.pc];
        const reg_b = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cmp = compare_3vl(ctx.registers[reg_a], ctx.registers[reg_b]);
        if (!cmp.is_unknown && cmp.result <= 0) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_JUMP (0x18)
       * Operands: [jump_target: uint16] (2 bytes)
       * Unconditional jump. Sets the program counter ctx.pc directly to jump_target.
       */
      case OpCode.OP_JUMP: {
        const jump_target = code_view.getUint16(ctx.pc, true);
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_STR_LIKE (0x19)
       * Operands: [reg_str: uint8] [reg_pat: uint8] [jump_target: uint16] (4 bytes)
       * 3VL SQL LIKE: jumps to jump_target if r[reg_str] matches r[reg_pat].
       */
      case OpCode.OP_STR_LIKE: {
        const reg_str = bytecode[ctx.pc];
        const reg_pat = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_pat = ctx.registers[reg_pat];
        if (val_str === null || val_pat === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (sql_like_match(String(val_str), String(val_pat))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_NOT_LIKE (0x1A)
       * Operands: [reg_str: uint8] [reg_pat: uint8] [jump_target: uint16] (4 bytes)
       * 3VL SQL NOT LIKE: jumps to jump_target if r[reg_str] does NOT match r[reg_pat].
       */
      case OpCode.OP_STR_NOT_LIKE: {
        const reg_str = bytecode[ctx.pc];
        const reg_pat = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_pat = ctx.registers[reg_pat];
        if (val_str === null || val_pat === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (!sql_like_match(String(val_str), String(val_pat))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_CONTAINS (0x1B)
       * Operands: [reg_str: uint8] [reg_sub: uint8] [jump_target: uint16] (4 bytes)
       * 3VL Substring search: jumps to jump_target if r[reg_str] contains r[reg_sub].
       */
      case OpCode.OP_STR_CONTAINS: {
        const reg_str = bytecode[ctx.pc];
        const reg_sub = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_sub = ctx.registers[reg_sub];
        if (val_str === null || val_sub === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (String(val_str).includes(String(val_sub))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_STARTS_WITH (0x1C)
       * Operands: [reg_str: uint8] [reg_pfx: uint8] [jump_target: uint16] (4 bytes)
       * 3VL Prefix check: jumps to jump_target if r[reg_str] starts with r[reg_pfx].
       */
      case OpCode.OP_STR_STARTS_WITH: {
        const reg_str = bytecode[ctx.pc];
        const reg_pfx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_pfx = ctx.registers[reg_pfx];
        if (val_str === null || val_pfx === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (String(val_str).startsWith(String(val_pfx))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_STR_ENDS_WITH (0x1D)
       * Operands: [reg_str: uint8] [reg_sfx: uint8] [jump_target: uint16] (4 bytes)
       * 3VL Suffix check: jumps to jump_target if r[reg_str] ends with r[reg_sfx].
       */
      case OpCode.OP_STR_ENDS_WITH: {
        const reg_str = bytecode[ctx.pc];
        const reg_sfx = bytecode[ctx.pc + 1];
        const jump_target = code_view.getUint16(ctx.pc + 2, true);
        ctx.pc += 4;
        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }
        const val_str = ctx.registers[reg_str];
        const val_sfx = ctx.registers[reg_sfx];
        if (val_str === null || val_sfx === null) {
          break; // 3VL UNKNOWN: do not jump
        }
        if (String(val_str).endsWith(String(val_sfx))) {
          ctx.pc = jump_target;
        }
        break;
      }

      /**
       * OP_LOAD_INT (0x20)
       * Operands: [reg_idx: uint8] [val: int32] (5 bytes)
       * Loads a literal signed 32-bit integer constant into register r[reg_idx].
       */
      case OpCode.OP_LOAD_INT: {
        const reg_idx = bytecode[ctx.pc];
        const val = code_view.getInt32(ctx.pc + 1, true);
        ctx.pc += 5;
        ctx.registers[reg_idx] = val;
        break;
      }

      /**
       * OP_LOAD_FLOAT (0x21)
       * Operands: [reg_idx: uint8] [val: float64] (9 bytes)
       * Loads a literal 64-bit IEEE 754 float constant into register r[reg_idx].
       */
      case OpCode.OP_LOAD_FLOAT: {
        const reg_idx = bytecode[ctx.pc];
        const val = code_view.getFloat64(ctx.pc + 1, true);
        ctx.pc += 9;
        ctx.registers[reg_idx] = val;
        break;
      }

      /**
       * OP_LOAD_TEXT (0x22)
       * Operands: [reg_idx: uint8] [len: uint16] [utf8_bytes: len bytes]
       * Loads a literal UTF-8 string of length len into register r[reg_idx].
       */
      case OpCode.OP_LOAD_TEXT: {
        const reg_idx = bytecode[ctx.pc];
        const len = code_view.getUint16(ctx.pc + 1, true);
        const text_bytes = new Uint8Array(
          bytecode.buffer,
          bytecode.byteOffset + ctx.pc + 3,
          len,
        );
        ctx.registers[reg_idx] = text_decoder.decode(text_bytes);
        ctx.pc += 3 + len;
        break;
      }

      /**
       * OP_LOAD_NULL (0x23)
       * Operands: [reg_idx: uint8] (1 byte)
       * Sets register r[reg_idx] to null (type = 0).
       */
      case OpCode.OP_LOAD_NULL: {
        const reg_idx = bytecode[ctx.pc];
        ctx.pc += 1;
        ctx.registers[reg_idx] = null;
        break;
      }

      /**
       * OP_EMIT_ROW (0x24)
       * Operands: [cursor_idx: uint8] (1 byte)
       * Streams the current serialized row focused under cursor[cursor_idx]
       * into the 64KB Output Result Buffer at RESULT_BUFFER_OFFSET + resultOffset.
       * Prepends a 2-byte record length: [uint16 len] [row_bytes].
       * If remaining buffer space is insufficient, yields STATUS_BUFFER_FULL.
       */
      case OpCode.OP_EMIT_ROW: {
        const cursor_idx = bytecode[ctx.pc];
        ctx.pc += 1;

        const cursor = get_cursor(ctx, cursor_idx);
        const total_row_length = view.getUint16(cursor.rowOffset + 1, true);
        const needed = 2 + total_row_length;

        if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
          ctx.status = VmStatus.BUFFER_FULL;
          ctx.pc = instr_pc; // Rewind PC so this row emits upon resumption
          return VmStatus.BUFFER_FULL;
        }

        const out_target = RESULT_BUFFER_OFFSET + ctx.resultOffset;
        view.setUint16(out_target, total_row_length, true);

        // Copy row bytes into output result buffer
        const src_uint8 = new Uint8Array(
          view.buffer,
          view.byteOffset + cursor.rowOffset,
          total_row_length,
        );
        const dest_uint8 = new Uint8Array(
          view.buffer,
          view.byteOffset + out_target + 2,
          total_row_length,
        );
        dest_uint8.set(src_uint8);

        ctx.resultOffset += needed;
        ctx.resultCount++;
        break;
      }

      /**
       * OP_STR_LOWER (0x29)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Converts string in r[src_reg] to lowercase and stores into r[dest_reg].
       */
      case OpCode.OP_STR_LOWER: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null ? String(val).toLowerCase() : null;
        break;
      }

      /**
       * OP_STR_UPPER (0x2A)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Converts string in r[src_reg] to uppercase and stores into r[dest_reg].
       */
      case OpCode.OP_STR_UPPER: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] =
          val !== null ? String(val).toUpperCase() : null;
        break;
      }

      /**
       * OP_STR_LENGTH (0x2B)
       * Operands: [src_reg: uint8] [dest_reg: uint8] (2 bytes)
       * Computes UTF-8 / character length of string in r[src_reg] and stores into r[dest_reg] (int32).
       */
      case OpCode.OP_STR_LENGTH: {
        const src_reg = bytecode[ctx.pc];
        const dest_reg = bytecode[ctx.pc + 1];
        ctx.pc += 2;
        const val = ctx.registers[src_reg];
        ctx.registers[dest_reg] = val !== null ? String(val).length : null;
        break;
      }

      /**
       * OP_STR_SUBSTR (0x2C)
       * Operands: [src_reg: uint8] [start_reg: uint8] [len_reg: uint8] [dest_reg: uint8] (4 bytes)
       * 1-indexed SQL SUBSTR. Extracts substring from r[src_reg] starting at r[start_reg] for r[len_reg] characters.
       */
      case OpCode.OP_STR_SUBSTR: {
        const src_reg = bytecode[ctx.pc];
        const start_reg = bytecode[ctx.pc + 1];
        const len_reg = bytecode[ctx.pc + 2];
        const dest_reg = bytecode[ctx.pc + 3];
        ctx.pc += 4;
        const val = ctx.registers[src_reg];
        const start = ctx.registers[start_reg];
        const len = ctx.registers[len_reg];
        if (val === null || start === null) {
          ctx.registers[dest_reg] = null;
          break;
        }
        const str = String(val);
        const s_idx = Math.max(0, Number(start) - 1);
        if (len === null) {
          ctx.registers[dest_reg] = str.slice(s_idx);
        } else {
          const l = Math.max(0, Number(len));
          ctx.registers[dest_reg] = str.slice(s_idx, s_idx + l);
        }
        break;
      }

      /**
       * OP_RESULT_ROW (0x25)
       * Operands: [start_reg: uint8] [num_cols: uint8] (2 bytes)
       * Serializes num_cols registers (start_reg .. start_reg + num_cols - 1)
       * into a binary row in the 64KB Result Buffer.
       * If remaining space is insufficient, yields STATUS_BUFFER_FULL.
       */
      case OpCode.OP_RESULT_ROW: {
        const start_reg = bytecode[ctx.pc];
        const num_cols = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        let cols: ColumnMeta[] = [];
        const record: Record<string, any> = {};

        if (ctx.outputColumns && num_cols === ctx.outputColumns.length) {
          cols = ctx.outputColumns;
          for (let c = 0; c < num_cols; c++) {
            record[cols[c].name] = ctx.registers[start_reg + c];
          }
        } else if (ctx.table && num_cols === ctx.table.columns.length) {
          cols = ctx.table.columns;
          for (let c = 0; c < num_cols; c++) {
            record[cols[c].name] = ctx.registers[start_reg + c];
          }
        } else {
          for (let c = 0; c < num_cols; c++) {
            const val = ctx.registers[start_reg + c];
            const col_name = ctx.table?.columns[c]?.name ?? `col_${c}`;
            let col_type = DataType.TEXT;
            if (typeof val === "number") {
              col_type = Number.isInteger(val)
                ? DataType.INT32
                : DataType.FLOAT64;
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

        const serialized = page_serialize_row(cols, record);
        const needed = 2 + serialized.byteLength;
        if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
          ctx.status = VmStatus.BUFFER_FULL;
          ctx.pc = instr_pc;
          return VmStatus.BUFFER_FULL;
        }

        const out_target = RESULT_BUFFER_OFFSET + ctx.resultOffset;
        view.setUint16(out_target, serialized.byteLength, true);
        const dest = new Uint8Array(
          view.buffer,
          view.byteOffset + out_target + 2,
          serialized.byteLength,
        );
        dest.set(serialized);

        ctx.resultOffset += needed;
        ctx.resultCount++;
        break;
      }

      /**
       * OP_SORTER_OPEN (0x30)
       * Operands: [sorter_id: uint8] [key_info_idx: uint8] (2 bytes)
       * Initializes sorter in Transient Query Arena with KeyInfo descriptor.
       */
      case OpCode.OP_SORTER_OPEN: {
        const sorter_id = bytecode[ctx.pc];
        const key_info_idx = bytecode[ctx.pc + 1];
        ctx.pc += 2;

        const key_info = ctx.keyInfos[key_info_idx] ?? {
          numKeys: 1,
          directions: [0],
          nullOrders: [0],
        };

        ctx.sorters[sorter_id] = {
          keyInfo: key_info,
          entries: [],
          readIdx: 0,
          isSorted: false,
        };
        break;
      }

      /**
       * OP_SORTER_INSERT (0x31)
       * Operands: [sorter_id: uint8] [start_reg: uint8] [num_keys: uint8] [cursor_idx: uint8] (4 bytes)
       * Packs extracted key registers and row reference into SorterEntry inside the Transient Query Arena.
       * If arena allocation exceeds maxQueryMemory, yields STATUS_ERR_ARENA_EXHAUSTED.
       */
      case OpCode.OP_SORTER_INSERT: {
        const sorter_id = bytecode[ctx.pc];
        const start_reg = bytecode[ctx.pc + 1];
        const num_keys = bytecode[ctx.pc + 2];
        const cursor_idx = bytecode[ctx.pc + 3];
        ctx.pc += 4;

        const sorter = ctx.sorters[sorter_id];
        if (!sorter) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const cursor = get_cursor(ctx, cursor_idx);
        const row_len = view.getUint16(cursor.rowOffset + 1, true);

        // Account for arena memory: SorterEntry (16B) + Register keys (16B * num_keys) + row_len
        const entry_size = 16 + 16 * num_keys + row_len;
        if (ctx.arenaOffset + entry_size > ctx.maxQueryMemory) {
          ctx.status = VmStatus.ARENA_EXHAUSTED;
          return VmStatus.ARENA_EXHAUSTED;
        }
        ctx.arenaOffset += entry_size;

        const keys: any[] = [];
        for (let k = 0; k < num_keys; k++) {
          keys.push(ctx.registers[start_reg + k]);
        }

        const row_uint8 = new Uint8Array(
          view.buffer,
          view.byteOffset + cursor.rowOffset,
          row_len,
        );
        const row_data = new Uint8Array(row_len);
        row_data.set(row_uint8);

        sorter.entries.push({
          keys,
          rowOffset: cursor.rowOffset,
          rowLen: row_len,
          rowData: row_data,
        });
        break;
      }

      /**
       * OP_SORTER_SORT (0x32)
       * Operands: [sorter_id: uint8] (1 byte)
       * Executes in-place Introsort on SorterEntry[] using multi-column collation.
       */
      case OpCode.OP_SORTER_SORT: {
        const sorter_id = bytecode[ctx.pc];
        ctx.pc += 1;

        const sorter = ctx.sorters[sorter_id];
        if (!sorter) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        sort_sorter_entries(sorter);
        sorter.isSorted = true;
        sorter.readIdx = 0;
        break;
      }

      /**
       * OP_SORTER_NEXT (0x33)
       * Operands: [sorter_id: uint8] [jump_target: uint16] (3 bytes)
       * Yields next sorted row into 64KB Result Buffer; jumps to jump_target until all entries emitted.
       * If Result Buffer is full, yields STATUS_BUFFER_FULL. Falls through on EOF.
       */
      case OpCode.OP_SORTER_NEXT: {
        const sorter_id = bytecode[ctx.pc];
        const jump_target = code_view.getUint16(ctx.pc + 1, true);
        ctx.pc += 3;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const sorter = ctx.sorters[sorter_id];
        if (!sorter) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        if (sorter.readIdx >= sorter.entries.length) {
          // EOF: all sorted entries emitted, fall through
          break;
        }

        const entry = sorter.entries[sorter.readIdx];
        const needed = 2 + entry.rowLen;
        if (ctx.resultOffset + needed > RESULT_BUFFER_SIZE) {
          ctx.status = VmStatus.BUFFER_FULL;
          ctx.pc = instr_pc;
          return VmStatus.BUFFER_FULL;
        }

        const out_target = RESULT_BUFFER_OFFSET + ctx.resultOffset;
        view.setUint16(out_target, entry.rowLen, true);
        const dest = new Uint8Array(
          view.buffer,
          view.byteOffset + out_target + 2,
          entry.rowLen,
        );
        if (entry.rowData) {
          dest.set(entry.rowData);
        } else {
          const src = new Uint8Array(
            view.buffer,
            view.byteOffset + entry.rowOffset,
            entry.rowLen,
          );
          dest.set(src);
        }

        ctx.resultOffset += needed;
        ctx.resultCount++;
        sorter.readIdx++;

        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_AGG_INIT (0x40)
       * Operands: [agg_id: uint8] [start_key_reg: uint8] [num_keys: uint8] [mode: uint8] (4 bytes)
       * Initializes Hash Table in arena (0x00) or Stream Aggregation (0x01).
       */
      case OpCode.OP_AGG_INIT: {
        const agg_id = bytecode[ctx.pc];
        const start_key_reg = bytecode[ctx.pc + 1];
        const num_keys = bytecode[ctx.pc + 2];
        const mode = bytecode[ctx.pc + 3];
        ctx.pc += 4;

        if (mode === 0) {
          const initial_capacity = 1024;
          const alloc_size = initial_capacity * 40; // 40.96 KB
          if (ctx.arenaOffset + alloc_size > ctx.maxQueryMemory) {
            ctx.status = VmStatus.ARENA_EXHAUSTED;
            return VmStatus.ARENA_EXHAUSTED;
          }
          ctx.arenaOffset += alloc_size;

          const buckets: VmAggBucket[] = create_agg_buckets(initial_capacity);

          if (num_keys === 0) {
            const h = fnv1a_32([]);
            const slot = h % initial_capacity;
            buckets[slot].hash = h;
            buckets[slot].keys = [];
            buckets[slot].count = 0;
            buckets[slot].sum = 0;
            buckets[slot].min_val = Infinity;
            buckets[slot].max_val = -Infinity;
            buckets[slot].has_val = false;
          }

          ctx.aggregators[agg_id] = {
            mode: 0,
            startKeyReg: start_key_reg,
            numKeys: num_keys,
            capacity: initial_capacity,
            occupiedCount: num_keys === 0 ? 1 : 0,
            readIdx: 0,
            buckets,
          };
        } else {
          ctx.aggregators[agg_id] = {
            mode: 1,
            startKeyReg: start_key_reg,
            numKeys: num_keys,
            capacity: 1,
            occupiedCount: 0,
            readIdx: 0,
            buckets: [],
          };
        }
        break;
      }

      /**
       * OP_AGG_STEP (0x41)
       * Operands: [agg_id: uint8] [start_key_reg: uint8] [num_keys: uint8] [val_reg: uint8] [func_id: uint8] (5 bytes)
       * Updates AggBucket accumulators (0: COUNT, 1: SUM, 2: AVG, 3: MIN, 4: MAX).
       */
      case OpCode.OP_AGG_STEP: {
        const agg_id = bytecode[ctx.pc];
        const start_key_reg = bytecode[ctx.pc + 1];
        const num_keys = bytecode[ctx.pc + 2];
        const val_reg = bytecode[ctx.pc + 3];
        const func_id = bytecode[ctx.pc + 4];
        ctx.pc += 5;

        const agg = ctx.aggregators[agg_id];
        if (!agg) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const keys: any[] = [];
        for (let k = 0; k < num_keys; k++) {
          keys.push(ctx.registers[start_key_reg + k]);
        }
        const val = val_reg === 255 ? null : ctx.registers[val_reg];

        if (agg.mode === 0) {
          const hash = fnv1a_32(keys);
          const slot = hash % agg.capacity;
          let target_bucket: VmAggBucket | null = null;

          for (let probe = 0; probe < agg.capacity; probe++) {
            const idx = (slot + probe) % agg.capacity;
            const b = agg.buckets[idx];
            if (b.hash === 0) {
              b.hash = hash;
              b.keys = keys.slice();
              b.count = 0;
              b.sum = 0;
              b.min_val = Infinity;
              b.max_val = -Infinity;
              b.has_val = false;
              agg.occupiedCount++;
              target_bucket = b;
              break;
            } else if (b.hash === hash && group_keys_match(b.keys, keys)) {
              target_bucket = b;
              break;
            }
          }

          if (!target_bucket) {
            ctx.status = VmStatus.ARENA_EXHAUSTED;
            return VmStatus.ARENA_EXHAUSTED;
          }

          // Accumulator updates
          if (func_id === 0) {
            if (val_reg === 255 || (val !== null && val !== undefined)) {
              target_bucket.count++;
            }
          } else if (func_id === 1 || func_id === 2) {
            if (val !== null && val !== undefined) {
              target_bucket.sum += Number(val);
              target_bucket.has_val = true;
            }
          } else if (func_id === 3) {
            if (val !== null && val !== undefined) {
              const num = Number(val);
              if (!target_bucket.has_val || num < target_bucket.min_val) {
                target_bucket.min_val = num;
              }
              target_bucket.has_val = true;
            }
          } else if (func_id === 4) {
            if (val !== null && val !== undefined) {
              const num = Number(val);
              if (!target_bucket.has_val || num > target_bucket.max_val) {
                target_bucket.max_val = num;
              }
              target_bucket.has_val = true;
            }
          }

          // Dynamic Doubling at 70% Load Factor
          if (agg.occupiedCount > 0.7 * agg.capacity) {
            const old_capacity = agg.capacity;
            const new_capacity = old_capacity * 2;
            const add_size = new_capacity * 40;
            if (ctx.arenaOffset + add_size > ctx.maxQueryMemory) {
              ctx.status = VmStatus.ARENA_EXHAUSTED;
              return VmStatus.ARENA_EXHAUSTED;
            }
            ctx.arenaOffset += add_size;

            const old_buckets = agg.buckets;
            const new_buckets: VmAggBucket[] = create_agg_buckets(new_capacity);

            for (let b_idx = 0; b_idx < old_buckets.length; b_idx++) {
              const old_b = old_buckets[b_idx];
              if (old_b.hash !== 0) {
                const s = old_b.hash % new_capacity;
                for (let p = 0; p < new_capacity; p++) {
                  const pos = (s + p) % new_capacity;
                  if (new_buckets[pos].hash === 0) {
                    new_buckets[pos] = old_b;
                    break;
                  }
                }
              }
            }

            agg.capacity = new_capacity;
            agg.buckets = new_buckets;
          }
        }
        break;
      }

      /**
       * OP_AGG_NEXT (0x42)
       * Operands: [agg_id: uint8] [out_key_reg: uint8] [out_acc_reg: uint8] [jump_target: uint16] (5 bytes)
       * Iterates next group bucket into registers; jumps to jump_target. Falls through on EOF.
       */
      case OpCode.OP_AGG_NEXT: {
        const agg_id = bytecode[ctx.pc];
        const out_key_reg = bytecode[ctx.pc + 1];
        const out_acc_reg = bytecode[ctx.pc + 2];
        const jump_target = code_view.getUint16(ctx.pc + 3, true);
        ctx.pc += 5;

        if (jump_target > code_len) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        const agg = ctx.aggregators[agg_id];
        if (!agg) {
          ctx.status = VmStatus.INVALID_BYTECODE;
          return VmStatus.INVALID_BYTECODE;
        }

        while (
          agg.readIdx < agg.buckets.length &&
          agg.buckets[agg.readIdx].hash === 0
        ) {
          agg.readIdx++;
        }

        if (agg.readIdx >= agg.buckets.length) {
          // All buckets processed, fall through
          break;
        }

        const bucket = agg.buckets[agg.readIdx++];

        for (let k = 0; k < bucket.keys.length; k++) {
          ctx.registers[out_key_reg + k] = bucket.keys[k];
        }

        ctx.registers[out_acc_reg] = bucket.sum;
        ctx.registers[out_acc_reg + 1] = bucket.count;
        ctx.registers[out_acc_reg + 2] = bucket.has_val ? bucket.min_val : null;
        ctx.registers[out_acc_reg + 3] = bucket.has_val ? bucket.max_val : null;

        ctx.pc = jump_target;
        break;
      }

      /**
       * OP_AGG_FINAL (0x43)
       * Operands: [sum_reg: uint8] [count_reg: uint8] [out_reg: uint8] [func_id: uint8] (4 bytes)
       * Finalizes aggregate expression: (0: COUNT, 1: SUM, 2: AVG, 3: MIN, 4: MAX).
       */
      case OpCode.OP_AGG_FINAL: {
        const sum_reg = bytecode[ctx.pc];
        const count_reg = bytecode[ctx.pc + 1];
        const out_reg = bytecode[ctx.pc + 2];
        const func_id = bytecode[ctx.pc + 3];
        ctx.pc += 4;

        const sum = ctx.registers[sum_reg];
        const count = Number(ctx.registers[count_reg] ?? 0);

        if (func_id === 0) {
          ctx.registers[out_reg] = count;
        } else if (func_id === 1) {
          ctx.registers[out_reg] = count > 0 ? Number(sum) : null;
        } else if (func_id === 2) {
          ctx.registers[out_reg] = count > 0 ? Number(sum) / count : null;
        } else if (func_id === 3 || func_id === 4) {
          ctx.registers[out_reg] = ctx.registers[sum_reg];
        }
        break;
      }

      default:
        ctx.status = VmStatus.INVALID_BYTECODE;
        return VmStatus.INVALID_BYTECODE;
    }
  }

  ctx.status = VmStatus.DONE;
  return VmStatus.DONE;
}
