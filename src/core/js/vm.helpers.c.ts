/**
 * @c_include "page.h"
 * @c_include "buffer_pool.h"
 * @c_include "codecs.h"
 */

import {
  PAGE_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  PAGE_TO_SLOT_OFFSET,
  PAGE_TO_SLOT_SIZE,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  DEFAULT_MAX_QUERY_MEMORY,
  MAX_TOPK_HEAP_LIMIT,
} from "../../constants.ts";
import {
  VmStatus,
  DataType,
  ColumnMeta,
  ColumnFlag,
} from "../../types/index.ts";
import { u8, u16, u32, i32, i64, f64 } from "../types.ts";
import {
  page_get_cell_count,
  page_get_cell_offset,
  page_serialize_row,
} from "./page.c.ts";
import { buf_pool_get_resident_slot } from "./buffer_pool.c.ts";
import { hex_val, crockford_decode } from "./codecs.c.ts";
import {
  memcpy,
  memset,
  read_u8,
  write_u8,
  read_u16,
  write_u16,
  read_u32,
  write_u32,
  read_i32,
  write_i32,
  read_i64,
  write_i64,
  read_f64,
  write_f64,
  i64_to_f64,
  i64_to_i32,
  f64_to_i64,
  f64_to_i32,
} from "../../shared/c_runtime.ts";
import {
  type VmCursor,
  type VmContext,
  type VmKeyInfo,
  type VmSorter,
  type VmSorterEntry,
  type VmAggBucket,
} from "../../shared/index.ts";

// ============================================================================
// Flat Linear-Memory VmContext Layout Constants (at VM_CONTEXT_OFFSET)
// ============================================================================
// Instead of allocating JS objects on the heap (e.g., `ctx.pc`, `ctx.registers[i]`,
// `ctx.cursors[c]`), the VM stores all state in a contiguous 12 KB region at
// `ctx_off` (`VM_CONTEXT_OFFSET = 0x405080`) and reads/writes fields via
// `read_u32` / `write_u32` / `read_f64` / `write_f64` (which lower to single
// WASM load/store instructions in C).
//
// Quick Mapping (Flat Linear Memory <-> Pure JS Equivalent):
//   read_u32(view, ctx_off + VM_CTX_PC)                 <-> ctx.pc
//   write_u32(view, ctx_off + VM_CTX_PC, pc)            <-> ctx.pc = pc
//   write_i32(view, ctx_off + VM_CTX_STATUS, s)         <-> ctx.status = s
//   write_u32(view, ctx_off + VM_CTX_FAULT_PAGE_ID, p)  <-> ctx.fault_page_id = p
//   write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, a)   <-> ctx.arenaOffset = a
//   vm_reg_off(ctx_off, r)                              <-> &ctx.registers[r] (32-byte slot)
//   vm_cursor_off(ctx_off, c)                           <-> &ctx.cursors[c]   (24-byte struct)
// ============================================================================

export const VM_CTX_PC = 0;                  // u32: JS `ctx.pc` (Program Counter)
export const VM_CTX_STATUS = 4;              // i32: JS `ctx.status` (VmStatus enum)
export const VM_CTX_FAULT_PAGE_ID = 8;       // u32: JS `ctx.fault_page_id` (missing page ID on PAGE_FAULT)
export const VM_CTX_RESULT_COUNT = 12;       // u32: JS `ctx.resultCount` (emitted rows in current chunk)
export const VM_CTX_RESULT_OFFSET = 16;      // u32: JS `ctx.resultOffset` (byte cursor in RESULT_BUFFER)
export const VM_CTX_ARENA_OFFSET = 20;       // u32: JS `ctx.arenaOffset` (logical query memory used)
export const VM_CTX_MAX_QUERY_MEMORY = 24;   // u32: JS `ctx.maxQueryMemory` (arena byte limit)
export const VM_CTX_HAS_BUFFER_POOL = 28;    // u32: JS `hasBufferPool ? 1 : 0`
export const VM_CTX_NUM_TABLES = 32;         // u32: JS `ctx.tables.length`
export const VM_CTX_NUM_OUTPUT_COLS = 36;    // u32: JS `ctx.outputColumns.length`
export const VM_CTX_NUM_KEY_INFOS = 40;      // u32: JS `ctx.keyInfos.length`
export const VM_CTX_NUM_IN_SETS = 44;        // u32: JS `ctx.inSets.length`
export const VM_CTX_UDF_ID = 48;             // u32: Pending host UDF index when status == VM_STATUS_HOST_UDF
export const VM_CTX_UDF_START_REG = 52;      // u32: First argument register for host UDF call
export const VM_CTX_UDF_NUM_ARGS = 56;       // u32: Number of arguments for host UDF call
export const VM_CTX_UDF_DEST_REG = 60;       // u32: Destination register for host UDF return value
export const VM_CTX_PHYS_ARENA_USED = 64;    // u32: Bump-pointer offset inside TRANSIENT_ARENA_OFFSET
export const VM_CTX_CURRENT_BUCKET_OFF = 68; // u32: JS `agg.currentBucket` pointer during OP_AGG_NEXT..OP_AGG_FINAL

// 64 Registers * 32 bytes each (at ctx_off + 72 .. ctx_off + 2119)
// Pure JS equivalent: `ctx.registers[reg_idx]` (tagged union holding number | bigint | string | Uint8Array | null)
export const VM_CTX_REGISTERS_OFF = 72;
export const VM_REG_SIZE = 32;
export const VM_REG_IS_NULL = 0;  // u8:  1 if `ctx.registers[r] === null`, 0 otherwise
export const VM_REG_TYPE = 1;     // u8:  DataType tag (INT32, INT64, FLOAT64, TEXT, BLOB, UUID, ULID)
export const VM_REG_I32 = 4;      // i32: 32-bit integer value (`Number(ctx.registers[r]) | 0`)
export const VM_REG_I64 = 8;      // i64: 64-bit BigInt value (`BigInt(ctx.registers[r])`)
export const VM_REG_F64 = 16;     // f64: IEEE-754 float64 value (`Number(ctx.registers[r])`)
export const VM_REG_DATA_OFF = 24;// u32: Linear memory byte offset for TEXT/BLOB/UUID/ULID slice
export const VM_REG_DATA_LEN = 28;// u32: Byte length of TEXT/BLOB/UUID/ULID slice

// 16 Cursors * 24 bytes each (at ctx_off + 2120 .. ctx_off + 2503)
// Pure JS equivalent: `ctx.cursors[cursor_idx]`
export const VM_CTX_CURSORS_OFF = 2120;
export const VM_CURSOR_SIZE = 24;
export const VM_CUR_PAGE_ID = 0;      // u32: JS `cursor.pageId`
export const VM_CUR_ROOT_PAGE_ID = 4; // u32: JS `cursor.rootPageId`
export const VM_CUR_SLOT_IDX = 8;     // i32: JS `cursor.slotIdx` (BufferPool frame slot)
export const VM_CUR_CELL_IDX = 12;    // i32: JS `cursor.cellIdx` (current row index in page)
export const VM_CUR_ROW_OFFSET = 16;  // u32: JS `cursor.rowOffset` (absolute byte offset of row cell)
export const VM_CUR_FLAGS = 20;       // u32: JS `cursor.flags`

// 16 Table Descriptors * 260 bytes each (at ctx_off + 2504 .. ctx_off + 6663)
// Pure JS equivalent: `ctx.tables[cursor_idx].columns` (supports up to MAX_COLUMNS_PER_TABLE = 256)
// +0: num_cols (u16), +2: null_bitmap_bytes (u16), +4..+259: col_types[256] (u8)
export const VM_CTX_TABLES_OFF = 2504;
export const VM_TABLE_DESC_SIZE = 260;

// Output Columns Descriptor (260 bytes at ctx_off + 6664 .. ctx_off + 6923)
// Pure JS equivalent: `ctx.outputColumns`
// +0: has_output_cols (u8), +2: num_cols (u16), +4..+259: col_types[256] (u8)
export const VM_CTX_OUTPUT_COLS_OFF = 6664;

// 8 KeyInfo Descriptors * 32 bytes each (at ctx_off + 6928 .. ctx_off + 7183)
// Pure JS equivalent: `ctx.keyInfos[key_info_idx]`
export const VM_CTX_KEY_INFOS_OFF = 6928;
export const VM_KEY_INFO_SIZE = 32;
export const VM_KI_NUM_KEYS = 0;     // u8:  JS `keyInfo.numKeys`
export const VM_KI_HAS_LIMIT = 1;    // u8:  JS `keyInfo.limit !== undefined ? 1 : 0`
export const VM_KI_LIMIT = 4;        // u32: JS `keyInfo.limit ?? 0`
export const VM_KI_OFFSET = 8;       // u32: JS `keyInfo.offset ?? 0`
export const VM_KI_DIRECTIONS = 12;  // u8[8]: JS `keyInfo.directions[k]` (0 = ASC, 1 = DESC)
export const VM_KI_NULL_ORDERS = 20; // u8[8]: JS `keyInfo.nullOrders[k]` (0 = NULLS FIRST, 1 = NULLS LAST)

// 4 Sorter Descriptors * 32 bytes each (at ctx_off + 7184 .. ctx_off + 7311)
// Pure JS equivalent: `ctx.sorters[sorter_id]`
export const VM_CTX_SORTERS_OFF = 7184;
export const VM_SORTER_SIZE = 32;
export const VM_SRT_IS_OPEN = 0;      // u8:  JS `ctx.sorters[id] !== undefined`
export const VM_SRT_IS_SORTED = 1;    // u8:  JS `sorter.isSorted`
export const VM_SRT_KEY_INFO_IDX = 2; // u8:  Index into `ctx.keyInfos`
export const VM_SRT_ENTRY_COUNT = 4;  // u32: JS `sorter.entries.length`
export const VM_SRT_CAPACITY = 8;     // u32: Allocated length of `ptrs_off` array in arena
export const VM_SRT_READ_IDX = 12;    // u32: JS `sorter.readIdx`
export const VM_SRT_MAX_K = 16;       // u32: JS `sorter.maxK` (Top-K bounded heap limit)
export const VM_SRT_PTRS_OFF = 20;    // u32: Arena byte offset of `u32 entry_ptrs[capacity]`
export const VM_SRT_SCRATCH_OFF = 24; // u32: Arena byte offset of merge-sort scratch buffer

// 4 Aggregator Descriptors * 32 bytes each (at ctx_off + 7312 .. ctx_off + 7439)
// Pure JS equivalent: `ctx.aggregators[agg_id]`
export const VM_CTX_AGGS_OFF = 7312;
export const VM_AGG_SIZE = 32;
export const VM_AGG_IS_OPEN = 0;         // u8:  JS `ctx.aggregators[id] !== undefined`
export const VM_AGG_MODE = 1;            // u8:  JS `agg.mode` (0 = hash table, 1 = stream)
export const VM_AGG_START_KEY_REG = 2;   // u8:  JS `agg.startKeyReg`
export const VM_AGG_NUM_KEYS = 3;        // u8:  JS `agg.numKeys`
export const VM_AGG_CAPACITY = 4;        // u32: JS `agg.capacity` (number of hash buckets)
export const VM_AGG_OCCUPIED = 8;        // u32: JS `agg.occupiedCount`
export const VM_AGG_READ_IDX = 12;       // u32: JS `agg.readIdx`
export const VM_AGG_BUCKETS_OFF = 16;    // u32: Arena byte offset of `u32 bucket_ptrs[capacity]`
export const VM_AGG_CURR_BUCKET_OFF = 20;// u32: Arena byte offset of active `VmAggBucket`

export const VM_CTX_IN_SETS_OFF = 7440;  // 16 * 8B (`count: u32, items_off: u32`) -> JS `ctx.inSets[set_idx]`
export const VM_CTX_SCRATCH_OFF = 7680;  // Scratch buffer inside `VM_CONTEXT_OFFSET`
export const VM_STATUS_HOST_UDF = 99;    // Yield code asking host wrapper to invoke `ctx.udfs[udf_id]`

// ============================================================================
// 1. Flat Linear-Memory Primitives (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function to_lower_char(c: i32): i32 {
  if (c >= 65 && c <= 90) return c + 32;
  return c;
}

/**
 * @export_c
 */
export function to_upper_char(c: i32): i32 {
  if (c >= 97 && c <= 122) return c - 32;
  return c;
}

/**
 * @export_c
 * Pure JS equivalent: `&ctx.registers[reg_idx]` (each register slot is 32 bytes: `reg_idx << 5`).
 */
export function vm_reg_off(ctx_off: u32, reg_idx: u32): u32 {
  return ctx_off + VM_CTX_REGISTERS_OFF + (reg_idx << 5);
}

/**
 * @export_c
 * Pure JS equivalent: `&ctx.cursors[cursor_idx]` (each cursor struct is 24 bytes).
 */
export function vm_cursor_off(ctx_off: u32, cursor_idx: u32): u32 {
  return ctx_off + VM_CTX_CURSORS_OFF + cursor_idx * VM_CURSOR_SIZE;
}

/**
 * @export_c
 * Pure JS equivalent: `ctx.tables?.[cursor_idx] ?? ctx.table`
 */
export function vm_resolve_table_off(view: DataView, ctx_off: u32, cursor_idx: u32): u32 {
  const num_tables: u32 = read_u32(view, ctx_off + VM_CTX_NUM_TABLES);
  if (cursor_idx < num_tables) {
    return ctx_off + VM_CTX_TABLES_OFF + cursor_idx * VM_TABLE_DESC_SIZE;
  }
  return ctx_off + VM_CTX_TABLES_OFF;
}

/**
 * @export_c
 * Bump-pointer allocator in `TRANSIENT_ARENA_OFFSET` (8-byte aligned).
 * Pure JS equivalent: `new Uint8Array(bytes)` / heap object allocation.
 */
export function vm_phys_alloc(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  bytes: u32,
): u32 {
  const aligned: u32 = (bytes + 7) & (~7 >>> 0);
  const used: u32 = read_u32(view, ctx_off + VM_CTX_PHYS_ARENA_USED); // JS: ctx.physArenaUsed
  if (used + aligned > DEFAULT_MAX_QUERY_MEMORY) {
    return 0;
  }
  write_u32(view, ctx_off + VM_CTX_PHYS_ARENA_USED, used + aligned); // JS: ctx.physArenaUsed = used + aligned
  return arena_base + used;
}

/**
 * @export_c
 * Pure JS equivalent: `ctx.registers[reg_idx] = null`
 */
export function vm_reg_set_null(view: DataView, reg_off: u32): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 1);          // JS: reg.isNull = true
  write_u8(view, reg_off + VM_REG_TYPE, DataType.NULL); // JS: reg.type = DataType.NULL
  write_i32(view, reg_off + VM_REG_I32, 0);             // JS: reg.i32 = 0
  write_i64(view, reg_off + VM_REG_I64, 0n);            // JS: reg.i64 = 0n
  write_f64(view, reg_off + VM_REG_F64, 0.0);           // JS: reg.f64 = 0.0
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);        // JS: reg.dataOff = 0
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);        // JS: reg.dataLen = 0
}

/**
 * @export_c
 * Pure JS equivalent: `ctx.registers[reg_idx] = val` (32-bit integer)
 */
export function vm_reg_set_i32(view: DataView, reg_off: u32, val: i32): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);           // JS: reg.isNull = false
  write_u8(view, reg_off + VM_REG_TYPE, DataType.INT32); // JS: reg.type = DataType.INT32
  write_i32(view, reg_off + VM_REG_I32, val);            // JS: reg.i32 = val
  write_i64(view, reg_off + VM_REG_I64, f64_to_i64(val));// JS: reg.i64 = BigInt(val)
  write_f64(view, reg_off + VM_REG_F64, val);            // JS: reg.f64 = Number(val)
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

/**
 * @export_c
 * Pure JS equivalent: `ctx.registers[reg_idx] = val` (64-bit BigInt)
 */
export function vm_reg_set_i64(view: DataView, reg_off: u32, val: i64): void {
  const as_f64: f64 = i64_to_f64(val);
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);           // JS: reg.isNull = false
  write_u8(view, reg_off + VM_REG_TYPE, DataType.INT64); // JS: reg.type = DataType.INT64
  write_i32(view, reg_off + VM_REG_I32, i64_to_i32(val));// JS: reg.i32 = Number(val) | 0
  write_i64(view, reg_off + VM_REG_I64, val);            // JS: reg.i64 = val
  write_f64(view, reg_off + VM_REG_F64, as_f64);         // JS: reg.f64 = Number(val)
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

/**
 * @export_c
 * Pure JS equivalent: `ctx.registers[reg_idx] = val` (64-bit float)
 */
export function vm_reg_set_f64(view: DataView, reg_off: u32, val: f64): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);             // JS: reg.isNull = false
  write_u8(view, reg_off + VM_REG_TYPE, DataType.FLOAT64); // JS: reg.type = DataType.FLOAT64
  write_i32(view, reg_off + VM_REG_I32, f64_to_i32(val));  // JS: reg.i32 = Math.trunc(val)
  write_i64(view, reg_off + VM_REG_I64, f64_to_i64(val));  // JS: reg.i64 = BigInt(Math.trunc(val))
  write_f64(view, reg_off + VM_REG_F64, val);              // JS: reg.f64 = val
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

/**
 * @export_c
 * Stores a zero-copy byte slice (pointer + length) in a register.
 * Pure JS equivalent: `ctx.registers[reg_idx] = textDecoder.decode(subarray)` or `new Uint8Array(subarray)`
 */
export function vm_reg_set_slice(
  view: DataView,
  reg_off: u32,
  col_type: u8,
  data_off: u32,
  data_len: u32,
): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);            // JS: reg.isNull = false
  write_u8(view, reg_off + VM_REG_TYPE, col_type);        // JS: reg.type = col_type (TEXT/BLOB/UUID/ULID)
  write_i32(view, reg_off + VM_REG_I32, 0);
  write_i64(view, reg_off + VM_REG_I64, 0n);
  write_f64(view, reg_off + VM_REG_F64, 0.0);
  write_u32(view, reg_off + VM_REG_DATA_OFF, data_off);   // JS: reg.dataOff = data_off
  write_u32(view, reg_off + VM_REG_DATA_LEN, data_len);   // JS: reg.dataLen = data_len
}

/**
 * @export_c
 * Pure JS equivalent: `ctx.registers[dst_idx] = ctx.registers[src_idx]`
 */
export function vm_reg_copy(
  view: DataView,
  dst_reg_off: u32,
  src_reg_off: u32,
): void {
  if (dst_reg_off === src_reg_off) return;
  memcpy(view, dst_reg_off, view, src_reg_off, VM_REG_SIZE);
}

/**
 * @export_c
 */
export function vm_reg_clone_to_arena(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  dst_slot_off: u32,
  src_reg_off: u32,
): i32 {
  memcpy(view, dst_slot_off, view, src_reg_off, VM_REG_SIZE);
  const is_null: u8 = read_u8(view, src_reg_off + VM_REG_IS_NULL);
  if (is_null !== 0) return 0;

  const r_type: u8 = read_u8(view, src_reg_off + VM_REG_TYPE);
  if (
    r_type === DataType.TEXT ||
    r_type === DataType.BLOB ||
    r_type === DataType.UUID ||
    r_type === DataType.ULID
  ) {
    const d_off: u32 = read_u32(view, src_reg_off + VM_REG_DATA_OFF);
    const d_len: u32 = read_u32(view, src_reg_off + VM_REG_DATA_LEN);
    if (d_len > 0 && d_off < arena_base) {
      const copy_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, d_len);
      if (copy_off === 0) return -1;
      memcpy(view, copy_off, view, d_off, d_len);
      write_u32(view, dst_slot_off + VM_REG_DATA_OFF, copy_off);
    }
  }
  return 0;
}

// ============================================================================
// 2. UUID & ULID Flat DataView Transcoders (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function vm_hex_char(nibble: u32): u8 {
  return (nibble < 10 ? 48 + nibble : 87 + nibble) as u8;
}

/**
 * @export_c
 */
export function vm_crockford_char(idx: u32): u8 {
  if (idx < 10) return (48 + idx) as u8;
  if (idx < 18) return (65 + (idx - 10)) as u8;
  if (idx === 18) return 74;
  if (idx === 19) return 75;
  if (idx === 20) return 77;
  if (idx === 21) return 78;
  if (idx < 27) return (80 + (idx - 22)) as u8;
  return (86 + (idx - 27)) as u8;
}

/**
 * @export_c
 */
export function vm_uuid_decode_view(
  view: DataView,
  src_off: u32,
  dst_off: u32,
): void {
  let out_idx: u32 = 0;
  for (let i: u32 = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      write_u8(view, dst_off + out_idx, 45);
      out_idx++;
    }
    const b: u32 = read_u8(view, src_off + i);
    write_u8(view, dst_off + out_idx, vm_hex_char((b >> 4) & 0x0f));
    out_idx++;
    write_u8(view, dst_off + out_idx, vm_hex_char(b & 0x0f));
    out_idx++;
  }
}

/**
 * @export_c
 */
export function vm_uuid_encode_view(
  view: DataView,
  src_off: u32,
  src_len: u32,
  dst_off: u32,
): i32 {
  let clean_idx: u32 = 0;
  let hi: i32 = -1;
  for (let i: u32 = 0; i < src_len; i++) {
    const c: i32 = read_u8(view, src_off + i);
    if (c !== 45) {
      if (clean_idx >= 32) return -1;
      const val: i32 = hex_val(c);
      if (val < 0) return -1;
      if ((clean_idx & 1) === 0) {
        hi = val;
      } else {
        write_u8(view, dst_off + (clean_idx >> 1), ((hi << 4) | val) as u8);
      }
      clean_idx++;
    }
  }
  return clean_idx === 32 ? 0 : -1;
}

/**
 * @export_c
 */
export function vm_ulid_decode_view(
  view: DataView,
  src_off: u32,
  dst_off: u32,
): void {
  let time: i64 = 0n;
  for (let i: u32 = 0; i < 6; i++) {
    time = (time << 8n) | BigInt(read_u8(view, src_off + i));
  }
  for (let i: i32 = 9; i >= 0; i--) {
    const rem: u32 = i64_to_i32(time & 31n) as u32;
    write_u8(view, dst_off + (i as u32), vm_crockford_char(rem));
    time = time >> 5n;
  }

  let rand_hi: i64 = 0n;
  for (let i: u32 = 0; i < 5; i++) {
    rand_hi = (rand_hi << 8n) | BigInt(read_u8(view, src_off + 6 + i));
  }

  let rand_lo: i64 = 0n;
  for (let i: u32 = 0; i < 5; i++) {
    rand_lo = (rand_lo << 8n) | BigInt(read_u8(view, src_off + 11 + i));
  }

  for (let i: i32 = 25; i >= 18; i--) {
    const rem: u32 = i64_to_i32(rand_lo & 31n) as u32;
    write_u8(view, dst_off + (i as u32), vm_crockford_char(rem));
    rand_lo = rand_lo >> 5n;
  }

  for (let i: i32 = 17; i >= 10; i--) {
    const rem: u32 = i64_to_i32(rand_hi & 31n) as u32;
    write_u8(view, dst_off + (i as u32), vm_crockford_char(rem));
    rand_hi = rand_hi >> 5n;
  }
}

/**
 * @export_c
 */
export function vm_ulid_encode_view(
  view: DataView,
  src_off: u32,
  src_len: u32,
  dst_off: u32,
): i32 {
  if (src_len !== 26) return -1;

  let time: i64 = 0n;
  for (let i: u32 = 0; i < 10; i++) {
    const v: i32 = crockford_decode(read_u8(view, src_off + i));
    if (v < 0) return -1;
    time = (time << 5n) | BigInt(v);
  }

  write_u8(view, dst_off + 0, i64_to_i32((time >> 40n) & 0xffn) as u8);
  write_u8(view, dst_off + 1, i64_to_i32((time >> 32n) & 0xffn) as u8);
  write_u8(view, dst_off + 2, i64_to_i32((time >> 24n) & 0xffn) as u8);
  write_u8(view, dst_off + 3, i64_to_i32((time >> 16n) & 0xffn) as u8);
  write_u8(view, dst_off + 4, i64_to_i32((time >> 8n) & 0xffn) as u8);
  write_u8(view, dst_off + 5, i64_to_i32(time & 0xffn) as u8);

  let rand_hi: i64 = 0n;
  for (let i: u32 = 10; i < 18; i++) {
    const v: i32 = crockford_decode(read_u8(view, src_off + i));
    if (v < 0) return -1;
    rand_hi = (rand_hi << 5n) | BigInt(v);
  }

  let rand_lo: i64 = 0n;
  for (let i: u32 = 18; i < 26; i++) {
    const v: i32 = crockford_decode(read_u8(view, src_off + i));
    if (v < 0) return -1;
    rand_lo = (rand_lo << 5n) | BigInt(v);
  }

  write_u8(view, dst_off + 6, i64_to_i32((rand_hi >> 32n) & 0xffn) as u8);
  write_u8(view, dst_off + 7, i64_to_i32((rand_hi >> 24n) & 0xffn) as u8);
  write_u8(view, dst_off + 8, i64_to_i32((rand_hi >> 16n) & 0xffn) as u8);
  write_u8(view, dst_off + 9, i64_to_i32((rand_hi >> 8n) & 0xffn) as u8);
  write_u8(view, dst_off + 10, i64_to_i32(rand_hi & 0xffn) as u8);

  write_u8(view, dst_off + 11, i64_to_i32((rand_lo >> 32n) & 0xffn) as u8);
  write_u8(view, dst_off + 12, i64_to_i32((rand_lo >> 24n) & 0xffn) as u8);
  write_u8(view, dst_off + 13, i64_to_i32((rand_lo >> 16n) & 0xffn) as u8);
  write_u8(view, dst_off + 14, i64_to_i32((rand_lo >> 8n) & 0xffn) as u8);
  write_u8(view, dst_off + 15, i64_to_i32(rand_lo & 0xffn) as u8);

  return 0;
}

// ============================================================================
// 3. Row & Column Offset Helpers (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function vm_resolve_page_offset(
  view: DataView,
  has_buffer_pool: u32,
  page_id: u32,
): u32 {
  if (page_id === 0) return 0;
  if (has_buffer_pool !== 0) {
    const slot: i32 = buf_pool_get_resident_slot(
      view,
      PAGE_TO_SLOT_OFFSET,
      DEFAULT_PAGE_TO_SLOT_BUCKETS,
      page_id,
    );
    if (slot >= 0) {
      return (slot as u32) * PAGE_SIZE;
    }
  }
  return (page_id - 1) * PAGE_SIZE;
}

/**
 * @export_c
 */
export function vm_row_is_null(
  view: DataView,
  null_bitmap_offset: u32,
  col_idx: u32,
): i32 {
  const b: u8 = read_u8(view, null_bitmap_offset + (col_idx >> 3));
  return (b & (1 << (col_idx & 7))) !== 0 ? 1 : 0;
}

/**
 * @export_c
 */
export function vm_compute_fixed_col_offset(
  view: DataView,
  null_bitmap_offset: u32,
  null_bitmap_bytes: u32,
  tbl_off: u32,
  target_col_idx: u32,
): u32 {
  let col_offset: u32 = null_bitmap_offset + null_bitmap_bytes;
  for (let i: u32 = 0; i < target_col_idx; i++) {
    if (vm_row_is_null(view, null_bitmap_offset, i) === 0) {
      const col_type: u8 = read_u8(view, tbl_off + 4 + i);
      if (col_type === DataType.INT32) {
        col_offset += 4;
      } else if (col_type === DataType.INT64 || col_type === DataType.FLOAT64) {
        col_offset += 8;
      } else if (col_type === DataType.UUID || col_type === DataType.ULID) {
        col_offset += 16;
      }
    }
  }
  return col_offset;
}

/**
 * @export_c
 */
export function vm_compute_var_col_idx(
  view: DataView,
  tbl_off: u32,
  target_col_idx: u32,
): u32 {
  let var_idx: u32 = 0;
  for (let i: u32 = 0; i < target_col_idx; i++) {
    const col_type: u8 = read_u8(view, tbl_off + 4 + i);
    if (col_type === DataType.TEXT || col_type === DataType.BLOB) {
      var_idx++;
    }
  }
  return var_idx;
}

// ============================================================================
// 4. 3VL Comparisons & Index Seek Helpers (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function vm_compare_bytes_raw(
  view: DataView,
  off_a: u32,
  len_a: u32,
  off_b: u32,
  len_b: u32,
): i32 {
  const min_len: u32 = len_a < len_b ? len_a : len_b;
  for (let i: u32 = 0; i < min_len; i++) {
    const ba: u8 = read_u8(view, off_a + i);
    const bb: u8 = read_u8(view, off_b + i);
    if (ba !== bb) {
      return ba < bb ? -1 : 1;
    }
  }
  if (len_a === len_b) return 0;
  return len_a < len_b ? -1 : 1;
}

/**
 * @export_c
 * Returns -2 if either register is NULL (UNKNOWN in 3VL), otherwise -1, 0, or 1.
 */
export function vm_compare_reg_3vl(
  view: DataView,
  reg_a_off: u32,
  reg_b_off: u32,
): i32 {
  const a_null: u8 = read_u8(view, reg_a_off + VM_REG_IS_NULL);
  const b_null: u8 = read_u8(view, reg_b_off + VM_REG_IS_NULL);
  if (a_null !== 0 || b_null !== 0) {
    return -2;
  }

  const type_a: u8 = read_u8(view, reg_a_off + VM_REG_TYPE);
  const type_b: u8 = read_u8(view, reg_b_off + VM_REG_TYPE);

  if (type_a === DataType.INT64 && type_b === DataType.INT64) {
    const ia: i64 = read_i64(view, reg_a_off + VM_REG_I64);
    const ib: i64 = read_i64(view, reg_b_off + VM_REG_I64);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  }

  const a_is_num: i32 =
    type_a === DataType.INT32 ||
    type_a === DataType.INT64 ||
    type_a === DataType.FLOAT64
      ? 1
      : 0;
  const b_is_num: i32 =
    type_b === DataType.INT32 ||
    type_b === DataType.INT64 ||
    type_b === DataType.FLOAT64
      ? 1
      : 0;

  if (a_is_num !== 0 && b_is_num !== 0) {
    const fa: f64 = read_f64(view, reg_a_off + VM_REG_F64);
    const fb: f64 = read_f64(view, reg_b_off + VM_REG_F64);
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  }

  const off_a: u32 = read_u32(view, reg_a_off + VM_REG_DATA_OFF);
  const len_a: u32 = read_u32(view, reg_a_off + VM_REG_DATA_LEN);
  const off_b: u32 = read_u32(view, reg_b_off + VM_REG_DATA_OFF);
  const len_b: u32 = read_u32(view, reg_b_off + VM_REG_DATA_LEN);
  return vm_compare_bytes_raw(view, off_a, len_a, off_b, len_b);
}

/**
 * @export_c
 * Compares target key in reg_off against index leaf cell at slot_idx.
 * Returns <0 if target < cell, 0 if target == cell, >0 if target > cell.
 */
export function vm_compare_index_cell(
  view: DataView,
  ctx_off: u32,
  page_offset: u32,
  slot_idx: u16,
  key_type: u8,
  reg_off: u32,
): i32 {
  const cell_rel: u16 = page_get_cell_offset(view, page_offset, slot_idx);
  const cell_abs: u32 = page_offset + cell_rel;
  const k_len: u16 = read_u16(view, cell_abs);

  // NULL cell in index leaf is ordered before any non-NULL key
  if (k_len === 0) {
    return 1;
  }

  const cell_data: u32 = cell_abs + 2;

  if (key_type === DataType.INT32) {
    const target_v: f64 = read_f64(view, reg_off + VM_REG_F64);
    const cell_v: f64 = read_i32(view, cell_data);
    return target_v < cell_v ? -1 : target_v > cell_v ? 1 : 0;
  }

  if (key_type === DataType.INT64) {
    const cell_i64: i64 = read_i64(view, cell_data);
    const r_type: u8 = read_u8(view, reg_off + VM_REG_TYPE);
    if (r_type === DataType.INT64) {
      const target_i64: i64 = read_i64(view, reg_off + VM_REG_I64);
      return target_i64 < cell_i64 ? -1 : target_i64 > cell_i64 ? 1 : 0;
    }
    const target_f64: f64 = read_f64(view, reg_off + VM_REG_F64);
    const cell_f64: f64 = i64_to_f64(cell_i64);
    return target_f64 < cell_f64 ? -1 : target_f64 > cell_f64 ? 1 : 0;
  }

  if (key_type === DataType.FLOAT64) {
    const target_f64: f64 = read_f64(view, reg_off + VM_REG_F64);
    const cell_f64: f64 = read_f64(view, cell_data);
    return target_f64 < cell_f64 ? -1 : target_f64 > cell_f64 ? 1 : 0;
  }

  const target_off: u32 = read_u32(view, reg_off + VM_REG_DATA_OFF);
  const target_len: u32 = read_u32(view, reg_off + VM_REG_DATA_LEN);

  if (key_type === DataType.UUID && k_len === 16) {
    const scratch: u32 = ctx_off + VM_CTX_SCRATCH_OFF;
    vm_uuid_decode_view(view, cell_data, scratch);
    return vm_compare_bytes_raw(view, target_off, target_len, scratch, 36);
  }

  if (key_type === DataType.ULID && k_len === 16) {
    const scratch: u32 = ctx_off + VM_CTX_SCRATCH_OFF;
    vm_ulid_decode_view(view, cell_data, scratch);
    return vm_compare_bytes_raw(view, target_off, target_len, scratch, 26);
  }

  return vm_compare_bytes_raw(view, target_off, target_len, cell_data, k_len);
}

/**
 * @export_c
 */
export function vm_index_seek_leaf_eq(
  view: DataView,
  ctx_off: u32,
  page_offset: u32,
  key_type: u8,
  reg_off: u32,
): i32 {
  const cell_count: i32 = page_get_cell_count(view, page_offset);
  let lo: i32 = 0;
  let hi: i32 = cell_count - 1;
  let matched_slot: i32 = -1;

  while (lo <= hi) {
    const mid: i32 = (lo + hi) >> 1;
    const cmp: i32 = vm_compare_index_cell(
      view,
      ctx_off,
      page_offset,
      mid as u16,
      key_type,
      reg_off,
    );
    if (cmp <= 0) {
      if (cmp === 0) {
        matched_slot = mid;
      }
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return matched_slot;
}

/**
 * @export_c
 */
export function vm_index_seek_leaf_ge(
  view: DataView,
  ctx_off: u32,
  page_offset: u32,
  key_type: u8,
  reg_off: u32,
): i32 {
  const cell_count: i32 = page_get_cell_count(view, page_offset);
  let lo: i32 = 0;
  let hi: i32 = cell_count - 1;
  let candidate_slot: i32 = -1;

  while (lo <= hi) {
    const mid: i32 = (lo + hi) >> 1;
    const cmp: i32 = vm_compare_index_cell(
      view,
      ctx_off,
      page_offset,
      mid as u16,
      key_type,
      reg_off,
    );
    if (cmp <= 0) {
      candidate_slot = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return candidate_slot;
}

// ============================================================================
// 5. String & Math Helpers in Flat Linear Memory (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function sql_like_match_view(
  view: DataView,
  str_off: u32,
  str_len: u32,
  pat_off: u32,
  pat_len: u32,
): i32 {
  let s: u32 = 0;
  let p: u32 = 0;
  let star_p: i32 = -1;
  let star_s: i32 = -1;

  while (s < str_len) {
    const p_c: i32 = p < pat_len ? read_u8(view, pat_off + p) : 0;
    const s_c: i32 = read_u8(view, str_off + s);
    if (
      p < pat_len &&
      (p_c === 95 || to_lower_char(p_c) === to_lower_char(s_c))
    ) {
      s++;
      p++;
    } else if (p < pat_len && p_c === 37) {
      star_p = p as i32;
      p++;
      star_s = s as i32;
    } else if (star_p !== -1) {
      p = (star_p + 1) as u32;
      star_s++;
      s = star_s as u32;
    } else {
      return 0;
    }
  }

  while (p < pat_len && read_u8(view, pat_off + p) === 37) {
    p++;
  }

  return p === pat_len ? 1 : 0;
}

/**
 * @export_c
 */
export function vm_str_contains_view(
  view: DataView,
  str_off: u32,
  str_len: u32,
  sub_off: u32,
  sub_len: u32,
): i32 {
  if (sub_len === 0) return 1;
  if (sub_len > str_len) return 0;
  const limit: u32 = str_len - sub_len;
  for (let i: u32 = 0; i <= limit; i++) {
    let matched: i32 = 1;
    for (let j: u32 = 0; j < sub_len; j++) {
      if (read_u8(view, str_off + i + j) !== read_u8(view, sub_off + j)) {
        matched = 0;
        break;
      }
    }
    if (matched !== 0) return 1;
  }
  return 0;
}

/**
 * @export_c
 */
export function vm_str_starts_with_view(
  view: DataView,
  str_off: u32,
  str_len: u32,
  pfx_off: u32,
  pfx_len: u32,
): i32 {
  if (pfx_len > str_len) return 0;
  for (let i: u32 = 0; i < pfx_len; i++) {
    if (read_u8(view, str_off + i) !== read_u8(view, pfx_off + i)) {
      return 0;
    }
  }
  return 1;
}

/**
 * @export_c
 */
export function vm_str_ends_with_view(
  view: DataView,
  str_off: u32,
  str_len: u32,
  sfx_off: u32,
  sfx_len: u32,
): i32 {
  if (sfx_len > str_len) return 0;
  const start: u32 = str_len - sfx_len;
  for (let i: u32 = 0; i < sfx_len; i++) {
    if (read_u8(view, str_off + start + i) !== read_u8(view, sfx_off + i)) {
      return 0;
    }
  }
  return 1;
}

/**
 * @export_c
 */
export function vm_str_levenshtein_view(
  view: DataView,
  s1_off: u32,
  s1_len: u32,
  s2_off: u32,
  s2_len: u32,
  max_dist: u32,
): i32 {
  if (s1_len === 0) return s2_len <= max_dist ? (s2_len as i32) : ((max_dist + 1) as i32);
  if (s2_len === 0) return s1_len <= max_dist ? (s1_len as i32) : ((max_dist + 1) as i32);

  const diff: i32 = (s1_len as i32) - (s2_len as i32);
  const abs_diff: u32 = (diff < 0 ? -diff : diff) as u32;
  if (abs_diff > max_dist) return (max_dist + 1) as i32;

  const l1: u32 = s1_len > 64 ? 64 : s1_len;
  const l2: u32 = s2_len > 64 ? 64 : s2_len;

  const prev = new Uint32Array(65);
  const cur = new Uint32Array(65);
  const prev2 = new Uint32Array(65);

  for (let j: u32 = 0; j <= l2; j++) {
    prev[j] = j;
    prev2[j] = j;
  }

  for (let i: u32 = 1; i <= l1; i++) {
    cur[0] = i;
    let row_min: u32 = i;
    const c1: i32 = to_lower_char(read_u8(view, s1_off + i - 1));

    for (let j: u32 = 1; j <= l2; j++) {
      const c2: i32 = to_lower_char(read_u8(view, s2_off + j - 1));
      const cost: u32 = c1 === c2 ? 0 : 1;

      const del: u32 = prev[j] + 1;
      const ins: u32 = cur[j - 1] + 1;
      const sub: u32 = prev[j - 1] + cost;

      let min_val: u32 = del < ins ? del : ins;
      if (sub < min_val) min_val = sub;

      if (i > 1 && j > 1) {
        const c1_prev: i32 = to_lower_char(read_u8(view, s1_off + i - 2));
        const c2_prev: i32 = to_lower_char(read_u8(view, s2_off + j - 2));
        if (c1 === c2_prev && c1_prev === c2) {
          const trans: u32 = prev2[j - 2] + 1;
          if (trans < min_val) min_val = trans;
        }
      }

      cur[j] = min_val;
      if (min_val < row_min) row_min = min_val;
    }

    if (row_min > max_dist) {
      return (max_dist + 1) as i32;
    }

    for (let k: u32 = 0; k <= l2; k++) {
      prev2[k] = prev[k];
      prev[k] = cur[k];
    }
  }

  return cur[l2] as i32;
}

/**
 * @export_c
 */
export function vm_str_fuzzy_match_view(
  view: DataView,
  str_off: u32,
  str_len: u32,
  pat_off: u32,
  pat_len: u32,
  max_dist: u32,
  allow_prefix: u32,
): i32 {
  if (pat_len === 0) return 1;
  if (str_len === 0) return 0;

  if (vm_str_contains_view(view, str_off, str_len, pat_off, pat_len) !== 0) {
    return 1;
  }

  const whole_dist: i32 = vm_str_levenshtein_view(view, str_off, str_len, pat_off, pat_len, max_dist);
  if (whole_dist <= (max_dist as i32)) {
    return 1;
  }

  let word_start: u32 = 0;
  while (word_start < str_len) {
    while (word_start < str_len) {
      const b: i32 = read_u8(view, str_off + word_start);
      if (
        b <= 32 || b === 44 || b === 46 || b === 58 || b === 59 ||
        b === 45 || b === 95 || b === 47 || b === 39 || b === 34 ||
        b === 40 || b === 41 || b === 91 || b === 93
      ) {
        word_start++;
      } else {
        break;
      }
    }
    if (word_start >= str_len) break;

    let word_end: u32 = word_start;
    while (word_end < str_len) {
      const b: i32 = read_u8(view, str_off + word_end);
      if (
        b <= 32 || b === 44 || b === 46 || b === 58 || b === 59 ||
        b === 45 || b === 95 || b === 47 || b === 39 || b === 34 ||
        b === 40 || b === 41 || b === 91 || b === 93
      ) {
        break;
      }
      word_end++;
    }

    const word_len: u32 = word_end - word_start;
    const w_off: u32 = str_off + word_start;

    if (allow_prefix !== 0 && pat_len >= 2 && word_len >= pat_len) {
      let is_pfx: i32 = 1;
      for (let p: u32 = 0; p < pat_len; p++) {
        if (to_lower_char(read_u8(view, w_off + p)) !== to_lower_char(read_u8(view, pat_off + p))) {
          is_pfx = 0;
          break;
        }
      }
      if (is_pfx !== 0) return 1;
    }

    const w_dist: i32 = vm_str_levenshtein_view(view, w_off, word_len, pat_off, pat_len, max_dist);
    if (w_dist <= (max_dist as i32)) {
      return 1;
    }

    word_start = word_end;
  }

  return 0;
}

/**
 * @export_c
 */
export function vm_utf8_char_count(
  view: DataView,
  str_off: u32,
  byte_len: u32,
): i32 {
  let count: i32 = 0;
  let i: u32 = 0;
  while (i < byte_len) {
    const b: u8 = read_u8(view, str_off + i);
    if ((b & 0x80) === 0) {
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      i += 3;
    } else {
      i += 4;
    }
    count++;
  }
  return count;
}

/**
 * @export_c
 */
export function vm_str_lower(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  src_reg_off: u32,
  dest_reg_off: u32,
): void {
  if (read_u8(view, src_reg_off + VM_REG_IS_NULL) !== 0) {
    vm_reg_set_null(view, dest_reg_off);
    return;
  }
  const src_off: u32 = read_u32(view, src_reg_off + VM_REG_DATA_OFF);
  const len: u32 = read_u32(view, src_reg_off + VM_REG_DATA_LEN);
  if (len === 0) {
    vm_reg_set_slice(view, dest_reg_off, DataType.TEXT, 0, 0);
    return;
  }
  const out_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, len);
  if (out_off === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
    return;
  }
  for (let i: u32 = 0; i < len; i++) {
    write_u8(view, out_off + i, to_lower_char(read_u8(view, src_off + i)) as u8);
  }
  vm_reg_set_slice(view, dest_reg_off, DataType.TEXT, out_off, len);
}

/**
 * @export_c
 */
export function vm_str_upper(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  src_reg_off: u32,
  dest_reg_off: u32,
): void {
  if (read_u8(view, src_reg_off + VM_REG_IS_NULL) !== 0) {
    vm_reg_set_null(view, dest_reg_off);
    return;
  }
  const src_off: u32 = read_u32(view, src_reg_off + VM_REG_DATA_OFF);
  const len: u32 = read_u32(view, src_reg_off + VM_REG_DATA_LEN);
  if (len === 0) {
    vm_reg_set_slice(view, dest_reg_off, DataType.TEXT, 0, 0);
    return;
  }
  const out_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, len);
  if (out_off === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
    return;
  }
  for (let i: u32 = 0; i < len; i++) {
    write_u8(view, out_off + i, to_upper_char(read_u8(view, src_off + i)) as u8);
  }
  vm_reg_set_slice(view, dest_reg_off, DataType.TEXT, out_off, len);
}

/**
 * @export_c
 */
export function vm_str_trim(
  view: DataView,
  src_reg_off: u32,
  dest_reg_off: u32,
): void {
  if (read_u8(view, src_reg_off + VM_REG_IS_NULL) !== 0) {
    vm_reg_set_null(view, dest_reg_off);
    return;
  }
  const src_off: u32 = read_u32(view, src_reg_off + VM_REG_DATA_OFF);
  const len: u32 = read_u32(view, src_reg_off + VM_REG_DATA_LEN);
  let start: u32 = 0;
  let end: u32 = len;
  while (start < end) {
    const c: u8 = read_u8(view, src_off + start);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      start++;
    } else {
      break;
    }
  }
  while (end > start) {
    const c: u8 = read_u8(view, src_off + end - 1);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      end--;
    } else {
      break;
    }
  }
  vm_reg_set_slice(view, dest_reg_off, DataType.TEXT, src_off + start, end - start);
}

/**
 * @export_c
 */
export function vm_utf8_substr(
  view: DataView,
  src_reg_off: u32,
  start_reg_off: u32,
  len_reg_off: u32,
  dest_reg_off: u32,
): void {
  if (
    read_u8(view, src_reg_off + VM_REG_IS_NULL) !== 0 ||
    read_u8(view, start_reg_off + VM_REG_IS_NULL) !== 0
  ) {
    vm_reg_set_null(view, dest_reg_off);
    return;
  }

  const src_off: u32 = read_u32(view, src_reg_off + VM_REG_DATA_OFF);
  const byte_len: u32 = read_u32(view, src_reg_off + VM_REG_DATA_LEN);
  const raw_start: i32 = read_i32(view, start_reg_off + VM_REG_I32) - 1;
  const start_char: i32 = raw_start < 0 ? 0 : raw_start;

  const has_len: i32 = read_u8(view, len_reg_off + VM_REG_IS_NULL) === 0 ? 1 : 0;
  let max_chars: i32 = 2147483647;
  if (has_len !== 0) {
    const rl: i32 = read_i32(view, len_reg_off + VM_REG_I32);
    max_chars = rl < 0 ? 0 : rl;
  }

  let char_idx: i32 = 0;
  let byte_idx: u32 = 0;
  let slice_start: u32 = byte_len;

  while (byte_idx < byte_len && char_idx < start_char) {
    const b: u8 = read_u8(view, src_off + byte_idx);
    if ((b & 0x80) === 0) byte_idx += 1;
    else if ((b & 0xe0) === 0xc0) byte_idx += 2;
    else if ((b & 0xf0) === 0xe0) byte_idx += 3;
    else byte_idx += 4;
    char_idx++;
  }
  slice_start = byte_idx;

  let taken: i32 = 0;
  while (byte_idx < byte_len && taken < max_chars) {
    const b: u8 = read_u8(view, src_off + byte_idx);
    if ((b & 0x80) === 0) byte_idx += 1;
    else if ((b & 0xe0) === 0xc0) byte_idx += 2;
    else if ((b & 0xf0) === 0xe0) byte_idx += 3;
    else byte_idx += 4;
    taken++;
  }

  vm_reg_set_slice(
    view,
    dest_reg_off,
    DataType.TEXT,
    src_off + slice_start,
    byte_idx - slice_start,
  );
}

/**
 * @export_c
 */
export function vm_format_i64_to_scratch(
  view: DataView,
  scratch_off: u32,
  val: i64,
): u32 {
  if (val === 0n) {
    write_u8(view, scratch_off, 48);
    return 1;
  }
  let v: i64 = val;
  let is_neg: u32 = 0;
  if (v < 0n) {
    is_neg = 1;
    v = -v;
  }
  let temp_len: u32 = 0;
  const rev_off: u32 = scratch_off + 32;
  while (v > 0n) {
    const digit: u32 = i64_to_i32(v % 10n) as u32;
    write_u8(view, rev_off + temp_len, (48 + digit) as u8);
    temp_len++;
    v = v / 10n;
  }
  let out_len: u32 = 0;
  if (is_neg !== 0) {
    write_u8(view, scratch_off, 45);
    out_len++;
  }
  for (let i: u32 = 0; i < temp_len; i++) {
    write_u8(view, scratch_off + out_len, read_u8(view, rev_off + temp_len - 1 - i));
    out_len++;
  }
  return out_len;
}

/**
 * @export_c
 */
export function vm_str_concat(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  start_reg: u32,
  num_regs: u32,
  dest_reg: u32,
): void {
  let total_len: u32 = 0;
  let has_val: i32 = 0;
  const scratch: u32 = ctx_off + VM_CTX_SCRATCH_OFF;

  for (let i: u32 = 0; i < num_regs; i++) {
    const r_off: u32 = vm_reg_off(ctx_off, start_reg + i);
    if (read_u8(view, r_off + VM_REG_IS_NULL) === 0) {
      has_val = 1;
      const r_type: u8 = read_u8(view, r_off + VM_REG_TYPE);
      if (
        r_type === DataType.TEXT ||
        r_type === DataType.BLOB ||
        r_type === DataType.UUID ||
        r_type === DataType.ULID
      ) {
        total_len += read_u32(view, r_off + VM_REG_DATA_LEN);
      } else {
        total_len += vm_format_i64_to_scratch(
          view,
          scratch,
          read_i64(view, r_off + VM_REG_I64),
        );
      }
    }
  }

  const dest_off: u32 = vm_reg_off(ctx_off, dest_reg);
  if (has_val === 0) {
    vm_reg_set_null(view, dest_off);
    return;
  }
  if (total_len === 0) {
    vm_reg_set_slice(view, dest_off, DataType.TEXT, 0, 0);
    return;
  }

  const out_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, total_len);
  if (out_off === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
    return;
  }
  let pos: u32 = 0;
  for (let i: u32 = 0; i < num_regs; i++) {
    const r_off: u32 = vm_reg_off(ctx_off, start_reg + i);
    if (read_u8(view, r_off + VM_REG_IS_NULL) === 0) {
      const r_type: u8 = read_u8(view, r_off + VM_REG_TYPE);
      if (
        r_type === DataType.TEXT ||
        r_type === DataType.BLOB ||
        r_type === DataType.UUID ||
        r_type === DataType.ULID
      ) {
        const d_off: u32 = read_u32(view, r_off + VM_REG_DATA_OFF);
        const d_len: u32 = read_u32(view, r_off + VM_REG_DATA_LEN);
        if (d_len > 0) {
          memcpy(view, out_off + pos, view, d_off, d_len);
          pos += d_len;
        }
      } else {
        const fmt_len: u32 = vm_format_i64_to_scratch(
          view,
          scratch,
          read_i64(view, r_off + VM_REG_I64),
        );
        memcpy(view, out_off + pos, view, scratch, fmt_len);
        pos += fmt_len;
      }
    }
  }

  vm_reg_set_slice(view, dest_off, DataType.TEXT, out_off, total_len);
}

/**
 * @export_c
 */
export function vm_math_abs(x: f64): f64 {
  return x < 0.0 ? -x : x;
}

/**
 * @export_c
 */
export function vm_math_floor(x: f64): f64 {
  const t: f64 = Math.trunc(x);
  return x < t ? t - 1.0 : t;
}

/**
 * @export_c
 */
export function vm_math_ceil(x: f64): f64 {
  const t: f64 = Math.trunc(x);
  return x > t ? t + 1.0 : t;
}

/**
 * @export_c
 */
export function vm_math_round(x: f64): f64 {
  return vm_math_floor(x + 0.5);
}

// ============================================================================
// 6. OP_IN & Result Buffer Emission (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function vm_in_set_contains(
  view: DataView,
  ctx_off: u32,
  set_idx: u32,
  reg_off: u32,
): i32 {
  if (read_u8(view, reg_off + VM_REG_IS_NULL) !== 0) {
    return 0;
  }
  const num_sets: u32 = read_u32(view, ctx_off + VM_CTX_NUM_IN_SETS);
  if (set_idx >= num_sets) return 0;

  const set_desc_off: u32 = ctx_off + VM_CTX_IN_SETS_OFF + set_idx * 8;
  const count: u32 = read_u32(view, set_desc_off);
  const items_off: u32 = read_u32(view, set_desc_off + 4);

  for (let i: u32 = 0; i < count; i++) {
    const item_off: u32 = items_off + (i << 5);
    if (vm_compare_reg_3vl(view, reg_off, item_off) === 0) {
      return 1;
    }
  }
  return 0;
}

/**
 * @export_c
 */
export function vm_emit_raw_row(
  view: DataView,
  ctx_off: u32,
  row_src_off: u32,
  row_len: u32,
  instr_pc: u32,
): i32 {
  const result_offset: u32 = read_u32(view, ctx_off + VM_CTX_RESULT_OFFSET);
  const needed: u32 = 2 + row_len;
  if (result_offset + needed > RESULT_BUFFER_SIZE) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.BUFFER_FULL);
    write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
    return VmStatus.BUFFER_FULL;
  }

  const out_target: u32 = RESULT_BUFFER_OFFSET + result_offset;
  write_u16(view, out_target, row_len as u16);
  memcpy(view, out_target + 2, view, row_src_off, row_len);

  write_u32(view, ctx_off + VM_CTX_RESULT_OFFSET, result_offset + needed);
  write_u32(
    view,
    ctx_off + VM_CTX_RESULT_COUNT,
    read_u32(view, ctx_off + VM_CTX_RESULT_COUNT) + 1,
  );
  return VmStatus.RUNNING;
}

/**
 * @export_c
 */
export function vm_infer_result_col_type(
  view: DataView,
  ctx_off: u32,
  start_reg: u32,
  num_cols: u32,
  col_idx: u32,
): u8 {
  const out_cols_off: u32 = ctx_off + VM_CTX_OUTPUT_COLS_OFF;
  const has_out_cols: u8 = read_u8(view, out_cols_off);
  const out_num_cols: u16 = read_u16(view, out_cols_off + 2);
  if (has_out_cols !== 0 && num_cols === out_num_cols) {
    return read_u8(view, out_cols_off + 4 + col_idx);
  }

  const num_tables: u32 = read_u32(view, ctx_off + VM_CTX_NUM_TABLES);
  if (num_tables > 0) {
    const tbl0_off: u32 = ctx_off + VM_CTX_TABLES_OFF;
    const tbl0_cols: u16 = read_u16(view, tbl0_off);
    if (num_cols === tbl0_cols) {
      return read_u8(view, tbl0_off + 4 + col_idx);
    }
  }

  const reg_off: u32 = vm_reg_off(ctx_off, start_reg + col_idx);
  if (read_u8(view, reg_off + VM_REG_IS_NULL) !== 0) {
    return DataType.TEXT;
  }
  const r_type: u8 = read_u8(view, reg_off + VM_REG_TYPE);
  if (r_type === DataType.FLOAT64) {
    const fv: f64 = read_f64(view, reg_off + VM_REG_F64);
    if (
      fv === Math.trunc(fv) &&
      fv >= -2147483648.0 &&
      fv <= 2147483647.0
    ) {
      return DataType.INT32;
    }
    return DataType.FLOAT64;
  }
  return r_type;
}

/**
 * @export_c
 */
export function vm_serialize_and_emit_result_row(
  view: DataView,
  ctx_off: u32,
  start_reg: u32,
  num_cols: u32,
  instr_pc: u32,
): i32 {
  const null_bitmap_bytes: u32 = (num_cols + 7) >> 3;
  let fixed_slice_size: u32 = 0;
  let var_col_count: u32 = 0;
  let total_var_payload_size: u32 = 0;

  for (let c: u32 = 0; c < num_cols; c++) {
    const col_type: u8 = vm_infer_result_col_type(
      view,
      ctx_off,
      start_reg,
      num_cols,
      c,
    );
    const reg_off: u32 = vm_reg_off(ctx_off, start_reg + c);
    const is_null: u8 = read_u8(view, reg_off + VM_REG_IS_NULL);

    if (col_type === DataType.TEXT || col_type === DataType.BLOB) {
      var_col_count++;
      if (is_null === 0) {
        total_var_payload_size += read_u32(view, reg_off + VM_REG_DATA_LEN);
      }
    } else if (is_null === 0) {
      if (col_type === DataType.INT32) {
        fixed_slice_size += 4;
      } else if (col_type === DataType.INT64 || col_type === DataType.FLOAT64) {
        fixed_slice_size += 8;
      } else if (col_type === DataType.UUID || col_type === DataType.ULID) {
        fixed_slice_size += 16;
      }
    }
  }

  const var_offset_table_size: u32 = var_col_count * 4;
  const header_and_tables_size: u32 =
    3 + null_bitmap_bytes + fixed_slice_size + var_offset_table_size;
  const total_row_size: u32 = header_and_tables_size + total_var_payload_size;

  const result_offset: u32 = read_u32(view, ctx_off + VM_CTX_RESULT_OFFSET);
  const needed: u32 = 2 + total_row_size;
  if (result_offset + needed > RESULT_BUFFER_SIZE) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.BUFFER_FULL);
    write_u32(view, ctx_off + VM_CTX_PC, instr_pc);
    return VmStatus.BUFFER_FULL;
  }

  const out_target: u32 = RESULT_BUFFER_OFFSET + result_offset;
  write_u16(view, out_target, total_row_size as u16);

  const row_start: u32 = out_target + 2;
  write_u8(view, row_start + 0, 1);
  write_u16(view, row_start + 1, total_row_size as u16);
  memset(view, row_start + 3, 0, null_bitmap_bytes);

  let current_fixed_offset: u32 = row_start + 3 + null_bitmap_bytes;
  let current_var_table_offset: u32 = current_fixed_offset + fixed_slice_size;
  let current_payload_rel_offset: u32 = header_and_tables_size;

  for (let c: u32 = 0; c < num_cols; c++) {
    const col_type: u8 = vm_infer_result_col_type(
      view,
      ctx_off,
      start_reg,
      num_cols,
      c,
    );
    const reg_off: u32 = vm_reg_off(ctx_off, start_reg + c);
    const is_null: u8 = read_u8(view, reg_off + VM_REG_IS_NULL);

    if (is_null !== 0) {
      const bm_off: u32 = row_start + 3 + (c >> 3);
      write_u8(view, bm_off, (read_u8(view, bm_off) | (1 << (c & 7))) as u8);
      if (col_type === DataType.TEXT || col_type === DataType.BLOB) {
        write_u16(view, current_var_table_offset, 0);
        write_u16(view, current_var_table_offset + 2, 0);
        current_var_table_offset += 4;
      }
    } else if (col_type === DataType.TEXT || col_type === DataType.BLOB) {
      const d_off: u32 = read_u32(view, reg_off + VM_REG_DATA_OFF);
      const d_len: u32 = read_u32(view, reg_off + VM_REG_DATA_LEN);
      write_u16(view, current_var_table_offset, current_payload_rel_offset as u16);
      write_u16(view, current_var_table_offset + 2, d_len as u16);
      if (d_len > 0) {
        memcpy(view, row_start + current_payload_rel_offset, view, d_off, d_len);
        current_payload_rel_offset += d_len;
      }
      current_var_table_offset += 4;
    } else if (col_type === DataType.INT32) {
      write_i32(
        view,
        current_fixed_offset,
        f64_to_i32(read_f64(view, reg_off + VM_REG_F64)),
      );
      current_fixed_offset += 4;
    } else if (col_type === DataType.INT64) {
      const r_type: u8 = read_u8(view, reg_off + VM_REG_TYPE);
      const iv: i64 =
        r_type === DataType.INT64
          ? read_i64(view, reg_off + VM_REG_I64)
          : f64_to_i64(read_f64(view, reg_off + VM_REG_F64));
      write_i64(view, current_fixed_offset, iv);
      current_fixed_offset += 8;
    } else if (col_type === DataType.FLOAT64) {
      write_f64(view, current_fixed_offset, read_f64(view, reg_off + VM_REG_F64));
      current_fixed_offset += 8;
    } else if (col_type === DataType.UUID) {
      const d_off: u32 = read_u32(view, reg_off + VM_REG_DATA_OFF);
      const d_len: u32 = read_u32(view, reg_off + VM_REG_DATA_LEN);
      vm_uuid_encode_view(view, d_off, d_len, current_fixed_offset);
      current_fixed_offset += 16;
    } else if (col_type === DataType.ULID) {
      const d_off: u32 = read_u32(view, reg_off + VM_REG_DATA_OFF);
      const d_len: u32 = read_u32(view, reg_off + VM_REG_DATA_LEN);
      vm_ulid_encode_view(view, d_off, d_len, current_fixed_offset);
      current_fixed_offset += 16;
    }
  }

  write_u32(view, ctx_off + VM_CTX_RESULT_OFFSET, result_offset + needed);
  write_u32(
    view,
    ctx_off + VM_CTX_RESULT_COUNT,
    read_u32(view, ctx_off + VM_CTX_RESULT_COUNT) + 1,
  );
  return VmStatus.RUNNING;
}

// ============================================================================
// 7. Flat Arena Sorter Operations (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function vm_compare_sorter_key_slots(
  view: DataView,
  keys_a_base: u32,
  keys_b_base: u32,
  ki_off: u32,
): i32 {
  const num_keys: u32 = read_u8(view, ki_off + VM_KI_NUM_KEYS);
  for (let k: u32 = 0; k < num_keys; k++) {
    const ka_off: u32 = keys_a_base + (k << 5);
    const kb_off: u32 = keys_b_base + (k << 5);
    const direction: u8 = read_u8(view, ki_off + VM_KI_DIRECTIONS + k);
    const null_order: u8 = read_u8(view, ki_off + VM_KI_NULL_ORDERS + k);

    const a_null: u8 = read_u8(view, ka_off + VM_REG_IS_NULL);
    const b_null: u8 = read_u8(view, kb_off + VM_REG_IS_NULL);

    if (a_null !== 0 && b_null !== 0) {
      continue;
    }
    if (a_null !== 0 || b_null !== 0) {
      if (null_order === 0) {
        return a_null !== 0 ? -1 : 1;
      }
      return a_null !== 0 ? 1 : -1;
    }

    const cmp: i32 = vm_compare_reg_3vl(view, ka_off, kb_off);
    if (cmp !== 0) {
      return direction === 1 ? -cmp : cmp;
    }
  }
  return 0;
}

/**
 * @export_c
 */
export function vm_sorter_heap_sift_down(
  view: DataView,
  ptrs_off: u32,
  index: u32,
  length: u32,
  ki_off: u32,
): void {
  let curr: u32 = index;
  while (true) {
    let largest: u32 = curr;
    const left: u32 = 2 * curr + 1;
    const right: u32 = 2 * curr + 2;

    if (left < length) {
      const left_entry: u32 = read_u32(view, ptrs_off + (left << 2));
      const largest_entry: u32 = read_u32(view, ptrs_off + (largest << 2));
      if (
        vm_compare_sorter_key_slots(
          view,
          left_entry + 16,
          largest_entry + 16,
          ki_off,
        ) > 0
      ) {
        largest = left;
      }
    }

    if (right < length) {
      const right_entry: u32 = read_u32(view, ptrs_off + (right << 2));
      const largest_entry: u32 = read_u32(view, ptrs_off + (largest << 2));
      if (
        vm_compare_sorter_key_slots(
          view,
          right_entry + 16,
          largest_entry + 16,
          ki_off,
        ) > 0
      ) {
        largest = right;
      }
    }

    if (largest !== curr) {
      const tmp: u32 = read_u32(view, ptrs_off + (curr << 2));
      write_u32(
        view,
        ptrs_off + (curr << 2),
        read_u32(view, ptrs_off + (largest << 2)),
      );
      write_u32(view, ptrs_off + (largest << 2), tmp);
      curr = largest;
    } else {
      break;
    }
  }
}

/**
 * @export_c
 */
export function vm_sorter_open_raw(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  sorter_id: u32,
  key_info_idx: u32,
): i32 {
  const srt_off: u32 = ctx_off + VM_CTX_SORTERS_OFF + sorter_id * VM_SORTER_SIZE;
  const ki_off: u32 = ctx_off + VM_CTX_KEY_INFOS_OFF + key_info_idx * VM_KEY_INFO_SIZE;

  const has_limit: u8 = read_u8(view, ki_off + VM_KI_HAS_LIMIT);
  const limit: u32 = read_u32(view, ki_off + VM_KI_LIMIT);
  const offset: u32 = read_u32(view, ki_off + VM_KI_OFFSET);

  let requested_k: u32 = 0;
  if (has_limit !== 0 && limit > 0) {
    requested_k = offset + limit;
  }
  const max_k: u32 =
    requested_k > 0 && requested_k <= MAX_TOPK_HEAP_LIMIT ? requested_k : 0;

  const init_cap: u32 = max_k > 0 ? max_k : 256;
  const ptrs_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, init_cap * 4);
  if (ptrs_off === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
    return VmStatus.ARENA_EXHAUSTED;
  }

  write_u8(view, srt_off + VM_SRT_IS_OPEN, 1);
  write_u8(view, srt_off + VM_SRT_IS_SORTED, 0);
  write_u8(view, srt_off + VM_SRT_KEY_INFO_IDX, key_info_idx as u8);
  write_u32(view, srt_off + VM_SRT_ENTRY_COUNT, 0);
  write_u32(view, srt_off + VM_SRT_CAPACITY, init_cap);
  write_u32(view, srt_off + VM_SRT_READ_IDX, 0);
  write_u32(view, srt_off + VM_SRT_MAX_K, max_k);
  write_u32(view, srt_off + VM_SRT_PTRS_OFF, ptrs_off);
  write_u32(view, srt_off + VM_SRT_SCRATCH_OFF, 0);
  return VmStatus.RUNNING;
}

/**
 * @export_c
 */
export function vm_sorter_insert_raw(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  sorter_id: u32,
  start_reg: u32,
  num_keys: u32,
  cursor_idx: u32,
): i32 {
  const srt_off: u32 = ctx_off + VM_CTX_SORTERS_OFF + sorter_id * VM_SORTER_SIZE;
  if (read_u8(view, srt_off + VM_SRT_IS_OPEN) === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
    return VmStatus.INVALID_BYTECODE;
  }

  const key_info_idx: u32 = read_u8(view, srt_off + VM_SRT_KEY_INFO_IDX);
  const ki_off: u32 = ctx_off + VM_CTX_KEY_INFOS_OFF + key_info_idx * VM_KEY_INFO_SIZE;
  const entry_count: u32 = read_u32(view, srt_off + VM_SRT_ENTRY_COUNT);
  const max_k: u32 = read_u32(view, srt_off + VM_SRT_MAX_K);
  let ptrs_off: u32 = read_u32(view, srt_off + VM_SRT_PTRS_OFF);

  const cand_keys_base: u32 = vm_reg_off(ctx_off, start_reg);

  // Fast-path Top-K heap rejection
  if (max_k > 0 && entry_count >= max_k) {
    const root_entry: u32 = read_u32(view, ptrs_off);
    const cmp: i32 = vm_compare_sorter_key_slots(
      view,
      cand_keys_base,
      root_entry + 16,
      ki_off,
    );
    if (cmp >= 0) {
      return VmStatus.RUNNING;
    }

    const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
    const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
    const row_len: u32 = read_u16(view, row_offset + 1);
    const old_row_len: u32 = read_u32(view, root_entry + 4);

    const arena_off: u32 = read_u32(view, ctx_off + VM_CTX_ARENA_OFFSET);
    const max_mem: u32 = read_u32(view, ctx_off + VM_CTX_MAX_QUERY_MEMORY);
    if (row_len > old_row_len) {
      const diff: u32 = row_len - old_row_len;
      if (arena_off + diff > max_mem) {
        write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
        return VmStatus.ARENA_EXHAUSTED;
      }
      write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, arena_off + diff);
    } else {
      const diff: u32 = old_row_len - row_len;
      write_u32(
        view,
        ctx_off + VM_CTX_ARENA_OFFSET,
        arena_off >= diff ? arena_off - diff : 0,
      );
    }

    const new_entry_bytes: u32 = 16 + (num_keys << 5) + row_len;
    const new_entry_off: u32 = vm_phys_alloc(
      view,
      ctx_off,
      arena_base,
      new_entry_bytes,
    );
    if (new_entry_off === 0) {
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
      return VmStatus.ARENA_EXHAUSTED;
    }

    const row_dst_off: u32 = new_entry_off + 16 + (num_keys << 5);
    write_u32(view, new_entry_off + 0, num_keys);
    write_u32(view, new_entry_off + 4, row_len);
    write_u32(view, new_entry_off + 8, row_dst_off);
    write_u32(view, new_entry_off + 12, 0);

    for (let k: u32 = 0; k < num_keys; k++) {
      vm_reg_clone_to_arena(
        view,
        ctx_off,
        arena_base,
        new_entry_off + 16 + (k << 5),
        vm_reg_off(ctx_off, start_reg + k),
      );
    }
    memcpy(view, row_dst_off, view, row_offset, row_len);

    write_u32(view, ptrs_off, new_entry_off);
    vm_sorter_heap_sift_down(view, ptrs_off, 0, max_k, ki_off);
    return VmStatus.RUNNING;
  }

  // Regular insertion
  const cur_off: u32 = vm_cursor_off(ctx_off, cursor_idx);
  const row_offset: u32 = read_u32(view, cur_off + VM_CUR_ROW_OFFSET);
  const row_len: u32 = read_u16(view, row_offset + 1);

  const logical_entry_size: u32 = 16 + 16 * num_keys + row_len;
  const arena_off: u32 = read_u32(view, ctx_off + VM_CTX_ARENA_OFFSET);
  const max_mem: u32 = read_u32(view, ctx_off + VM_CTX_MAX_QUERY_MEMORY);
  if (arena_off + logical_entry_size > max_mem) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
    return VmStatus.ARENA_EXHAUSTED;
  }
  write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, arena_off + logical_entry_size);

  let capacity: u32 = read_u32(view, srt_off + VM_SRT_CAPACITY);
  if (entry_count >= capacity) {
    const new_cap: u32 = capacity * 2;
    const new_ptrs: u32 = vm_phys_alloc(view, ctx_off, arena_base, new_cap * 4);
    if (new_ptrs === 0) {
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
      return VmStatus.ARENA_EXHAUSTED;
    }
    memcpy(view, new_ptrs, view, ptrs_off, entry_count * 4);
    ptrs_off = new_ptrs;
    capacity = new_cap;
    write_u32(view, srt_off + VM_SRT_CAPACITY, capacity);
    write_u32(view, srt_off + VM_SRT_PTRS_OFF, ptrs_off);
  }

  const phys_entry_bytes: u32 = 16 + (num_keys << 5) + row_len;
  const entry_off: u32 = vm_phys_alloc(
    view,
    ctx_off,
    arena_base,
    phys_entry_bytes,
  );
  if (entry_off === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
    return VmStatus.ARENA_EXHAUSTED;
  }

  const row_dst_off: u32 = entry_off + 16 + (num_keys << 5);
  write_u32(view, entry_off + 0, num_keys);
  write_u32(view, entry_off + 4, row_len);
  write_u32(view, entry_off + 8, row_dst_off);
  write_u32(view, entry_off + 12, 0);

  for (let k: u32 = 0; k < num_keys; k++) {
    vm_reg_clone_to_arena(
      view,
      ctx_off,
      arena_base,
      entry_off + 16 + (k << 5),
      vm_reg_off(ctx_off, start_reg + k),
    );
  }
  memcpy(view, row_dst_off, view, row_offset, row_len);

  write_u32(view, ptrs_off + (entry_count << 2), entry_off);
  const new_count: u32 = entry_count + 1;
  write_u32(view, srt_off + VM_SRT_ENTRY_COUNT, new_count);

  if (max_k > 0 && new_count === max_k) {
    for (let h: i32 = ((max_k >> 1) as i32) - 1; h >= 0; h--) {
      vm_sorter_heap_sift_down(view, ptrs_off, h as u32, max_k, ki_off);
    }
  }

  return VmStatus.RUNNING;
}

/**
 * @export_c
 * Bottom-up stable merge sort over the u32 entry pointer array in the arena.
 */
export function vm_sorter_sort_raw(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  sorter_id: u32,
): i32 {
  const srt_off: u32 = ctx_off + VM_CTX_SORTERS_OFF + sorter_id * VM_SORTER_SIZE;
  if (read_u8(view, srt_off + VM_SRT_IS_OPEN) === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
    return VmStatus.INVALID_BYTECODE;
  }

  const n: u32 = read_u32(view, srt_off + VM_SRT_ENTRY_COUNT);
  const key_info_idx: u32 = read_u8(view, srt_off + VM_SRT_KEY_INFO_IDX);
  const ki_off: u32 = ctx_off + VM_CTX_KEY_INFOS_OFF + key_info_idx * VM_KEY_INFO_SIZE;
  const offset: u32 = read_u32(view, ki_off + VM_KI_OFFSET);

  if (n > 1) {
    const ptrs_off: u32 = read_u32(view, srt_off + VM_SRT_PTRS_OFF);
    const scratch_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, n * 4);
    if (scratch_off === 0) {
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
      return VmStatus.ARENA_EXHAUSTED;
    }

    for (let width: u32 = 1; width < n; width = width << 1) {
      for (let i: u32 = 0; i < n; i += width << 1) {
        const left: u32 = i;
        const mid: u32 = i + width < n ? i + width : n;
        const right: u32 = i + (width << 1) < n ? i + (width << 1) : n;

        let l: u32 = left;
        let r: u32 = mid;
        for (let k: u32 = left; k < right; k++) {
          if (l < mid && r < right) {
            const entry_l: u32 = read_u32(view, ptrs_off + (l << 2));
            const entry_r: u32 = read_u32(view, ptrs_off + (r << 2));
            const cmp: i32 = vm_compare_sorter_key_slots(
              view,
              entry_l + 16,
              entry_r + 16,
              ki_off,
            );
            if (cmp <= 0) {
              write_u32(view, scratch_off + (k << 2), entry_l);
              l++;
            } else {
              write_u32(view, scratch_off + (k << 2), entry_r);
              r++;
            }
          } else if (l < mid) {
            write_u32(
              view,
              scratch_off + (k << 2),
              read_u32(view, ptrs_off + (l << 2)),
            );
            l++;
          } else {
            write_u32(
              view,
              scratch_off + (k << 2),
              read_u32(view, ptrs_off + (r << 2)),
            );
            r++;
          }
        }
      }
      memcpy(view, ptrs_off, view, scratch_off, n * 4);
    }
  }

  write_u32(view, srt_off + VM_SRT_READ_IDX, offset);
  write_u8(view, srt_off + VM_SRT_IS_SORTED, 1);
  return VmStatus.RUNNING;
}

/**
 * @export_c
 */
export function vm_sorter_next_raw(
  view: DataView,
  ctx_off: u32,
  sorter_id: u32,
  jump_target: u32,
  instr_pc: u32,
): i32 {
  const srt_off: u32 = ctx_off + VM_CTX_SORTERS_OFF + sorter_id * VM_SORTER_SIZE;
  if (read_u8(view, srt_off + VM_SRT_IS_OPEN) === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
    return VmStatus.INVALID_BYTECODE;
  }

  const entry_count: u32 = read_u32(view, srt_off + VM_SRT_ENTRY_COUNT);
  const read_idx: u32 = read_u32(view, srt_off + VM_SRT_READ_IDX);
  const key_info_idx: u32 = read_u8(view, srt_off + VM_SRT_KEY_INFO_IDX);
  const ki_off: u32 = ctx_off + VM_CTX_KEY_INFOS_OFF + key_info_idx * VM_KEY_INFO_SIZE;

  const has_limit: u8 = read_u8(view, ki_off + VM_KI_HAS_LIMIT);
  const limit: u32 = read_u32(view, ki_off + VM_KI_LIMIT);
  const offset: u32 = read_u32(view, ki_off + VM_KI_OFFSET);

  let max_read: u32 = entry_count;
  if (has_limit !== 0) {
    const bound: u32 = offset + limit;
    if (bound < max_read) {
      max_read = bound;
    }
  }

  if (read_idx >= max_read) {
    return VmStatus.RUNNING;
  }

  const ptrs_off: u32 = read_u32(view, srt_off + VM_SRT_PTRS_OFF);
  const entry_off: u32 = read_u32(view, ptrs_off + (read_idx << 2));
  const row_len: u32 = read_u32(view, entry_off + 4);
  const row_data_off: u32 = read_u32(view, entry_off + 8);

  const emit_status: i32 = vm_emit_raw_row(
    view,
    ctx_off,
    row_data_off,
    row_len,
    instr_pc,
  );
  if (emit_status !== VmStatus.RUNNING) {
    return emit_status;
  }

  write_u32(view, srt_off + VM_SRT_READ_IDX, read_idx + 1);
  write_u32(view, ctx_off + VM_CTX_PC, jump_target);
  return VmStatus.RUNNING;
}

// ============================================================================
// 8. Flat Arena Hash Aggregator Operations (@export_c)
// ============================================================================

/**
 * @export_c
 */
export function vm_hash_group_keys(
  view: DataView,
  keys_base_off: u32,
  num_keys: u32,
): u32 {
  let hash: u32 = 0x811c9dc5;
  for (let k: u32 = 0; k < num_keys; k++) {
    const r_off: u32 = keys_base_off + (k << 5);
    const is_null: u8 = read_u8(view, r_off + VM_REG_IS_NULL);
    if (is_null !== 0) {
      hash ^= 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    } else {
      const r_type: u8 = read_u8(view, r_off + VM_REG_TYPE);
      if (
        r_type === DataType.INT32 ||
        r_type === DataType.INT64 ||
        r_type === DataType.FLOAT64
      ) {
        for (let b: u32 = 0; b < 8; b++) {
          hash ^= read_u8(view, r_off + VM_REG_F64 + b);
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
      } else {
        const d_off: u32 = read_u32(view, r_off + VM_REG_DATA_OFF);
        const d_len: u32 = read_u32(view, r_off + VM_REG_DATA_LEN);
        for (let b: u32 = 0; b < d_len; b++) {
          hash ^= read_u8(view, d_off + b);
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
      }
    }
  }
  hash = hash >>> 0;
  return hash === 0 ? 1 : hash;
}

/**
 * @export_c
 */
export function vm_group_key_slots_match(
  view: DataView,
  keys_a_base: u32,
  keys_b_base: u32,
  num_keys: u32,
): i32 {
  for (let k: u32 = 0; k < num_keys; k++) {
    const ka_off: u32 = keys_a_base + (k << 5);
    const kb_off: u32 = keys_b_base + (k << 5);
    const a_null: u8 = read_u8(view, ka_off + VM_REG_IS_NULL);
    const b_null: u8 = read_u8(view, kb_off + VM_REG_IS_NULL);
    if (a_null !== 0 && b_null !== 0) {
      continue;
    }
    if (a_null !== 0 || b_null !== 0) {
      return 0;
    }
    if (vm_compare_reg_3vl(view, ka_off, kb_off) !== 0) {
      return 0;
    }
  }
  return 1;
}

/**
 * @export_c
 * Allocates a 1320-byte group bucket in the physical arena:
 * +0: hash (u32), +4: num_keys (u32), +8: count (u32), +12: has_val (u32),
 * +16: sum (f64), +24: min_val (f64), +32: max_val (f64),
 * +40..295: keys[8] (8 * 32B),
 * +296..1319: slots[32] (32 * 32B).
 */
export function vm_alloc_agg_bucket(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  hash: u32,
  num_keys: u32,
  src_keys_base: u32,
): u32 {
  const bucket_off: u32 = vm_phys_alloc(view, ctx_off, arena_base, 1320);
  if (bucket_off === 0) return 0;

  memset(view, bucket_off, 0, 1320);
  write_u32(view, bucket_off + 0, hash);
  write_u32(view, bucket_off + 4, num_keys);

  for (let k: u32 = 0; k < num_keys; k++) {
    if (
      vm_reg_clone_to_arena(
        view,
        ctx_off,
        arena_base,
        bucket_off + 40 + (k << 5),
        src_keys_base + (k << 5),
      ) < 0
    ) {
      return 0;
    }
  }
  return bucket_off;
}

/**
 * @export_c
 */
export function vm_agg_init_raw(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  agg_id: u32,
  start_key_reg: u32,
  num_keys: u32,
  mode: u32,
): i32 {
  const agg_off: u32 = ctx_off + VM_CTX_AGGS_OFF + agg_id * VM_AGG_SIZE;
  write_u32(view, ctx_off + VM_CTX_CURRENT_BUCKET_OFF, 0);

  if (mode === 0) {
    const initial_capacity: u32 = 1024;
    const alloc_size: u32 = initial_capacity * 40;
    const arena_off: u32 = read_u32(view, ctx_off + VM_CTX_ARENA_OFFSET);
    const max_mem: u32 = read_u32(view, ctx_off + VM_CTX_MAX_QUERY_MEMORY);
    if (arena_off + alloc_size > max_mem) {
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
      return VmStatus.ARENA_EXHAUSTED;
    }
    write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, arena_off + alloc_size);

    const buckets_off: u32 = vm_phys_alloc(
      view,
      ctx_off,
      arena_base,
      initial_capacity * 4,
    );
    if (buckets_off === 0) {
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
      return VmStatus.ARENA_EXHAUSTED;
    }
    memset(view, buckets_off, 0, initial_capacity * 4);

    let occupied: u32 = 0;
    if (num_keys === 0) {
      const h: u32 = 0x811c9dc5;
      const slot: u32 = h % initial_capacity;
      const b_off: u32 = vm_alloc_agg_bucket(view, ctx_off, arena_base, h, 0, 0);
      if (b_off === 0) {
        write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
        return VmStatus.ARENA_EXHAUSTED;
      }
      write_u32(view, buckets_off + (slot << 2), b_off);
      occupied = 1;
    }

    write_u8(view, agg_off + VM_AGG_IS_OPEN, 1);
    write_u8(view, agg_off + VM_AGG_MODE, 0);
    write_u8(view, agg_off + VM_AGG_START_KEY_REG, start_key_reg as u8);
    write_u8(view, agg_off + VM_AGG_NUM_KEYS, num_keys as u8);
    write_u32(view, agg_off + VM_AGG_CAPACITY, initial_capacity);
    write_u32(view, agg_off + VM_AGG_OCCUPIED, occupied);
    write_u32(view, agg_off + VM_AGG_READ_IDX, 0);
    write_u32(view, agg_off + VM_AGG_BUCKETS_OFF, buckets_off);
    write_u32(view, agg_off + VM_AGG_CURR_BUCKET_OFF, 0);
  } else {
    write_u8(view, agg_off + VM_AGG_IS_OPEN, 1);
    write_u8(view, agg_off + VM_AGG_MODE, 1);
    write_u8(view, agg_off + VM_AGG_START_KEY_REG, start_key_reg as u8);
    write_u8(view, agg_off + VM_AGG_NUM_KEYS, num_keys as u8);
    write_u32(view, agg_off + VM_AGG_CAPACITY, 1);
    write_u32(view, agg_off + VM_AGG_OCCUPIED, 0);
    write_u32(view, agg_off + VM_AGG_READ_IDX, 0);
    write_u32(view, agg_off + VM_AGG_BUCKETS_OFF, 0);
    write_u32(view, agg_off + VM_AGG_CURR_BUCKET_OFF, 0);
  }
  return VmStatus.RUNNING;
}

/**
 * @export_c
 */
export function vm_agg_step_raw(
  view: DataView,
  ctx_off: u32,
  arena_base: u32,
  agg_id: u32,
  start_key_reg: u32,
  num_keys: u32,
  val_reg: u32,
  raw_func_id: u32,
): i32 {
  const agg_off: u32 = ctx_off + VM_CTX_AGGS_OFF + agg_id * VM_AGG_SIZE;
  if (read_u8(view, agg_off + VM_AGG_IS_OPEN) === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
    return VmStatus.INVALID_BYTECODE;
  }

  const func_id: u32 = raw_func_id & 0x07;
  const slot_idx: u32 = raw_func_id >> 3;
  const mode: u8 = read_u8(view, agg_off + VM_AGG_MODE);

  if (mode === 0) {
    let capacity: u32 = read_u32(view, agg_off + VM_AGG_CAPACITY);
    let occupied: u32 = read_u32(view, agg_off + VM_AGG_OCCUPIED);
    let buckets_off: u32 = read_u32(view, agg_off + VM_AGG_BUCKETS_OFF);

    const keys_base: u32 = vm_reg_off(ctx_off, start_key_reg);
    const hash: u32 = vm_hash_group_keys(view, keys_base, num_keys);
    const start_slot: u32 = hash % capacity;
    let target_bucket: u32 = 0;

    for (let probe: u32 = 0; probe < capacity; probe++) {
      const idx: u32 = (start_slot + probe) % capacity;
      const b_off: u32 = read_u32(view, buckets_off + (idx << 2));
      if (b_off === 0) {
        const new_b: u32 = vm_alloc_agg_bucket(
          view,
          ctx_off,
          arena_base,
          hash,
          num_keys,
          keys_base,
        );
        if (new_b === 0) {
          write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
          return VmStatus.ARENA_EXHAUSTED;
        }
        write_u32(view, buckets_off + (idx << 2), new_b);
        occupied++;
        write_u32(view, agg_off + VM_AGG_OCCUPIED, occupied);
        target_bucket = new_b;
        break;
      } else if (
        read_u32(view, b_off + 0) === hash &&
        vm_group_key_slots_match(view, b_off + 40, keys_base, num_keys) !== 0
      ) {
        target_bucket = b_off;
        break;
      }
    }

    if (target_bucket === 0) {
      write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
      return VmStatus.ARENA_EXHAUSTED;
    }

    const agg_slot_off: u32 = target_bucket + 296 + (slot_idx << 5);
    const val_is_non_null: i32 =
      val_reg !== 255 &&
      read_u8(view, vm_reg_off(ctx_off, val_reg) + VM_REG_IS_NULL) === 0
        ? 1
        : 0;

    if (func_id === 0) {
      if (val_reg === 255 || val_is_non_null !== 0) {
        write_u32(view, agg_slot_off + 0, read_u32(view, agg_slot_off + 0) + 1);
        write_u32(
          view,
          target_bucket + 8,
          read_u32(view, target_bucket + 8) + 1,
        );
      }
    } else if (func_id === 1 || func_id === 2) {
      if (val_is_non_null !== 0) {
        const num: f64 = read_f64(
          view,
          vm_reg_off(ctx_off, val_reg) + VM_REG_F64,
        );
        write_f64(view, agg_slot_off + 8, read_f64(view, agg_slot_off + 8) + num);
        write_u32(view, agg_slot_off + 0, read_u32(view, agg_slot_off + 0) + 1);
        write_u32(view, agg_slot_off + 4, 1);

        write_f64(
          view,
          target_bucket + 16,
          read_f64(view, target_bucket + 16) + num,
        );
        write_u32(view, target_bucket + 12, 1);
      }
    } else if (func_id === 3) {
      if (val_is_non_null !== 0) {
        const num: f64 = read_f64(
          view,
          vm_reg_off(ctx_off, val_reg) + VM_REG_F64,
        );
        if (
          read_u32(view, agg_slot_off + 4) === 0 ||
          num < read_f64(view, agg_slot_off + 16)
        ) {
          write_f64(view, agg_slot_off + 16, num);
        }
        write_u32(view, agg_slot_off + 0, read_u32(view, agg_slot_off + 0) + 1);
        write_u32(view, agg_slot_off + 4, 1);

        if (
          read_u32(view, target_bucket + 12) === 0 ||
          num < read_f64(view, target_bucket + 24)
        ) {
          write_f64(view, target_bucket + 24, num);
        }
        write_u32(view, target_bucket + 12, 1);
      }
    } else if (func_id === 4) {
      if (val_is_non_null !== 0) {
        const num: f64 = read_f64(
          view,
          vm_reg_off(ctx_off, val_reg) + VM_REG_F64,
        );
        if (
          read_u32(view, agg_slot_off + 4) === 0 ||
          num > read_f64(view, agg_slot_off + 24)
        ) {
          write_f64(view, agg_slot_off + 24, num);
        }
        write_u32(view, agg_slot_off + 0, read_u32(view, agg_slot_off + 0) + 1);
        write_u32(view, agg_slot_off + 4, 1);

        if (
          read_u32(view, target_bucket + 12) === 0 ||
          num > read_f64(view, target_bucket + 32)
        ) {
          write_f64(view, target_bucket + 32, num);
        }
        write_u32(view, target_bucket + 12, 1);
      }
    }

    // Dynamic Doubling at 70% Load Factor (occupied * 10 > capacity * 7)
    if (occupied * 10 > capacity * 7) {
      const new_capacity: u32 = capacity * 2;
      const add_size: u32 = new_capacity * 40;
      const arena_off: u32 = read_u32(view, ctx_off + VM_CTX_ARENA_OFFSET);
      const max_mem: u32 = read_u32(view, ctx_off + VM_CTX_MAX_QUERY_MEMORY);
      if (arena_off + add_size > max_mem) {
        write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
        return VmStatus.ARENA_EXHAUSTED;
      }
      write_u32(view, ctx_off + VM_CTX_ARENA_OFFSET, arena_off + add_size);

      const new_buckets_off: u32 = vm_phys_alloc(
        view,
        ctx_off,
        arena_base,
        new_capacity * 4,
      );
      if (new_buckets_off === 0) {
        write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.ARENA_EXHAUSTED);
        return VmStatus.ARENA_EXHAUSTED;
      }
      memset(view, new_buckets_off, 0, new_capacity * 4);

      for (let b_idx: u32 = 0; b_idx < capacity; b_idx++) {
        const old_b: u32 = read_u32(view, buckets_off + (b_idx << 2));
        if (old_b !== 0) {
          const bh: u32 = read_u32(view, old_b + 0);
          const s: u32 = bh % new_capacity;
          for (let p: u32 = 0; p < new_capacity; p++) {
            const pos: u32 = (s + p) % new_capacity;
            if (read_u32(view, new_buckets_off + (pos << 2)) === 0) {
              write_u32(view, new_buckets_off + (pos << 2), old_b);
              break;
            }
          }
        }
      }

      write_u32(view, agg_off + VM_AGG_CAPACITY, new_capacity);
      write_u32(view, agg_off + VM_AGG_BUCKETS_OFF, new_buckets_off);
    }
  }

  return VmStatus.RUNNING;
}

/**
 * @export_c
 */
export function vm_agg_next_raw(
  view: DataView,
  ctx_off: u32,
  agg_id: u32,
  out_key_reg: u32,
  out_acc_reg: u32,
  jump_target: u32,
): i32 {
  const agg_off: u32 = ctx_off + VM_CTX_AGGS_OFF + agg_id * VM_AGG_SIZE;
  if (read_u8(view, agg_off + VM_AGG_IS_OPEN) === 0) {
    write_i32(view, ctx_off + VM_CTX_STATUS, VmStatus.INVALID_BYTECODE);
    return VmStatus.INVALID_BYTECODE;
  }

  const capacity: u32 = read_u32(view, agg_off + VM_AGG_CAPACITY);
  const buckets_off: u32 = read_u32(view, agg_off + VM_AGG_BUCKETS_OFF);
  let read_idx: u32 = read_u32(view, agg_off + VM_AGG_READ_IDX);

  while (
    read_idx < capacity &&
    read_u32(view, buckets_off + (read_idx << 2)) === 0
  ) {
    read_idx++;
  }

  if (read_idx >= capacity) {
    write_u32(view, agg_off + VM_AGG_READ_IDX, read_idx);
    write_u32(view, agg_off + VM_AGG_CURR_BUCKET_OFF, 0);
    write_u32(view, ctx_off + VM_CTX_CURRENT_BUCKET_OFF, 0);
    return VmStatus.RUNNING;
  }

  const bucket_off: u32 = read_u32(view, buckets_off + (read_idx << 2));
  read_idx++;
  write_u32(view, agg_off + VM_AGG_READ_IDX, read_idx);
  write_u32(view, agg_off + VM_AGG_CURR_BUCKET_OFF, bucket_off);
  write_u32(view, ctx_off + VM_CTX_CURRENT_BUCKET_OFF, bucket_off);

  const num_keys: u32 = read_u32(view, bucket_off + 4);
  for (let k: u32 = 0; k < num_keys; k++) {
    vm_reg_copy(
      view,
      vm_reg_off(ctx_off, out_key_reg + k),
      bucket_off + 40 + (k << 5),
    );
  }

  const b_count: i32 = read_u32(view, bucket_off + 8) as i32;
  const b_has_val: u32 = read_u32(view, bucket_off + 12);
  const b_sum: f64 = read_f64(view, bucket_off + 16);
  const b_min: f64 = read_f64(view, bucket_off + 24);
  const b_max: f64 = read_f64(view, bucket_off + 32);

  vm_reg_set_f64(view, vm_reg_off(ctx_off, out_acc_reg), b_sum);
  vm_reg_set_i32(view, vm_reg_off(ctx_off, out_acc_reg + 1), b_count);
  if (b_has_val !== 0) {
    vm_reg_set_f64(view, vm_reg_off(ctx_off, out_acc_reg + 2), b_min);
    vm_reg_set_f64(view, vm_reg_off(ctx_off, out_acc_reg + 3), b_max);
  } else {
    vm_reg_set_null(view, vm_reg_off(ctx_off, out_acc_reg + 2));
    vm_reg_set_null(view, vm_reg_off(ctx_off, out_acc_reg + 3));
  }

  write_u32(view, ctx_off + VM_CTX_PC, jump_target);
  return VmStatus.RUNNING;
}

/**
 * @export_c
 */
export function vm_agg_final_raw(
  view: DataView,
  ctx_off: u32,
  sum_reg: u32,
  count_reg: u32,
  out_reg: u32,
  raw_func_id: u32,
): i32 {
  const func_id: u32 = raw_func_id & 0x07;
  const slot_idx: u32 = raw_func_id >> 3;
  const out_reg_off: u32 = vm_reg_off(ctx_off, out_reg);

  const curr_bucket: u32 = read_u32(view, ctx_off + VM_CTX_CURRENT_BUCKET_OFF);
  if (curr_bucket !== 0) {
    const slot_off: u32 = curr_bucket + 296 + (slot_idx << 5);
    const s_count: i32 = read_u32(view, slot_off + 0) as i32;
    const s_has_val: u32 = read_u32(view, slot_off + 4);
    const s_sum: f64 = read_f64(view, slot_off + 8);
    const s_min: f64 = read_f64(view, slot_off + 16);
    const s_max: f64 = read_f64(view, slot_off + 24);

    if (func_id === 0) {
      vm_reg_set_i32(view, out_reg_off, s_count);
    } else if (func_id === 1) {
      if (s_has_val !== 0) vm_reg_set_f64(view, out_reg_off, s_sum);
      else vm_reg_set_null(view, out_reg_off);
    } else if (func_id === 2) {
      if (s_count > 0) vm_reg_set_f64(view, out_reg_off, s_sum / s_count);
      else vm_reg_set_null(view, out_reg_off);
    } else if (func_id === 3) {
      if (s_has_val !== 0) vm_reg_set_f64(view, out_reg_off, s_min);
      else vm_reg_set_null(view, out_reg_off);
    } else if (func_id === 4) {
      if (s_has_val !== 0) vm_reg_set_f64(view, out_reg_off, s_max);
      else vm_reg_set_null(view, out_reg_off);
    }
    return VmStatus.RUNNING;
  }

  const sum_reg_off: u32 = vm_reg_off(ctx_off, sum_reg);
  const count_reg_off: u32 = vm_reg_off(ctx_off, count_reg);
  const count_val: i32 =
    read_u8(view, count_reg_off + VM_REG_IS_NULL) !== 0
      ? 0
      : read_i32(view, count_reg_off + VM_REG_I32);

  if (func_id === 0) {
    vm_reg_set_i32(view, out_reg_off, count_val);
  } else if (func_id === 1) {
    if (count_val > 0) {
      vm_reg_set_f64(view, out_reg_off, read_f64(view, sum_reg_off + VM_REG_F64));
    } else {
      vm_reg_set_null(view, out_reg_off);
    }
  } else if (func_id === 2) {
    if (count_val > 0) {
      vm_reg_set_f64(
        view,
        out_reg_off,
        read_f64(view, sum_reg_off + VM_REG_F64) / count_val,
      );
    } else {
      vm_reg_set_null(view, out_reg_off);
    }
  } else if (func_id === 3 || func_id === 4) {
    vm_reg_copy(view, out_reg_off, sum_reg_off);
  }

  return VmStatus.RUNNING;
}

// ============================================================================
// 9. Legacy / Host-Boundary Exports for Public & Test Compatibility
// ============================================================================

/**
 * @export_c
 */
export function fnv1a_32_bytes(data: Uint8Array, len: u32): u32 {
  let hash: u32 = 0x811c9dc5;
  for (let i: u32 = 0; i < len; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash !== 0 ? (hash >>> 0) : 1;
}

/**
 * @export_c
 */
export function sql_like_match_raw(
  str: string,
  str_len: u32,
  pattern: string,
  pat_len: u32,
): i32 {
  let s: u32 = 0;
  let p: u32 = 0;
  let star_p: i32 = -1;
  let star_s: i32 = -1;

  while (s < str_len) {
    const p_c: u32 = p < pat_len ? pattern.charCodeAt(p) : 0;
    const s_c: u32 = str.charCodeAt(s);
    if (p < pat_len && (p_c === 95 || to_lower_char(p_c as i32) === to_lower_char(s_c as i32))) {
      s++;
      p++;
    } else if (p < pat_len && p_c === 37) {
      star_p = p++;
      star_s = s;
    } else if (star_p !== -1) {
      p = (star_p + 1) as u32;
      s = ++star_s as u32;
    } else {
      return 0;
    }
  }

  while (p < pat_len && pattern.charCodeAt(p) === 37) {
    p++;
  }

  return p === pat_len ? 1 : 0;
}

export interface Compare3VLResult {
  result: i32;
  is_unknown: i32;
}

/**
 * @export_c
 */
export function compare_3vl_int64(
  a: i64,
  a_null: i32,
  b: i64,
  b_null: i32,
): Compare3VLResult {
  if (a_null !== 0 || b_null !== 0) {
    return { result: 0, is_unknown: 1 };
  }
  return { result: a < b ? -1 : a > b ? 1 : 0, is_unknown: 0 };
}

/**
 * @export_c
 */
export function compare_3vl_float64(
  a: f64,
  a_null: i32,
  b: f64,
  b_null: i32,
): Compare3VLResult {
  if (a_null !== 0 || b_null !== 0) {
    return { result: 0, is_unknown: 1 };
  }
  return { result: a < b ? -1 : a > b ? 1 : 0, is_unknown: 0 };
}

/**
 * @export_c
 */
export function compare_3vl_bytes(
  a: Uint8Array,
  a_len: u32,
  a_null: i32,
  b: Uint8Array,
  b_len: u32,
  b_null: i32,
): Compare3VLResult {
  if (a_null !== 0 || b_null !== 0) {
    return { result: 0, is_unknown: 1 };
  }
  const min_len: u32 = a_len < b_len ? a_len : b_len;
  for (let i: u32 = 0; i < min_len; i++) {
    if (a[i] !== b[i]) {
      return { result: a[i] < b[i] ? -1 : 1, is_unknown: 0 };
    }
  }
  return { result: a_len < b_len ? -1 : a_len > b_len ? 1 : 0, is_unknown: 0 };
}

export function get_cursor(ctx: VmContext, cursor_idx: number): VmCursor {
  if (ctx.cursors && ctx.cursors[cursor_idx]) {
    return ctx.cursors[cursor_idx];
  }
  return ctx.cursor;
}

export function resolve_page_offset(view: DataView, page_id: number): number {
  if (page_id <= 0) return 0;
  const has_pool = view.byteLength >= PAGE_TO_SLOT_OFFSET + PAGE_TO_SLOT_SIZE ? 1 : 0;
  return vm_resolve_page_offset(view, has_pool, page_id);
}

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
    return { result: num_a === num_b ? 0 : num_a > num_b ? 1 : -1, is_unknown: false };
  }
  if (typeof val_a === "bigint" || typeof val_b === "bigint") {
    const a = BigInt(val_a);
    const b = BigInt(val_b);
    return { result: a === b ? 0 : a > b ? 1 : -1, is_unknown: false };
  }
  if (val_a instanceof Uint8Array && val_b instanceof Uint8Array) {
    const min_len = Math.min(val_a.byteLength, val_b.byteLength);
    for (let i = 0; i < min_len; i++) {
      if (val_a[i] !== val_b[i]) {
        return { result: val_a[i] > val_b[i] ? 1 : -1, is_unknown: false };
      }
    }
    return {
      result:
        val_a.byteLength === val_b.byteLength
          ? 0
          : val_a.byteLength > val_b.byteLength
            ? 1
            : -1,
      is_unknown: false,
    };
  }
  return { result: val_a === val_b ? 0 : val_a > val_b ? 1 : -1, is_unknown: false };
}

export function sql_like_match(str: string, pattern: string): boolean {
  return sql_like_match_raw(str, str.length, pattern, pattern.length) === 1;
}

export function compare_sorter_keys(
  keys_a: any[],
  keys_b: any[],
  key_info: VmKeyInfo,
): number {
  const num_keys = key_info.numKeys;
  for (let k = 0; k < num_keys; k++) {
    const a = keys_a[k];
    const b = keys_b[k];
    const direction = key_info.directions[k] ?? 0;
    const null_order = key_info.nullOrders[k] ?? (direction === 1 ? 1 : 0);

    const a_is_null = a === null || a === undefined;
    const b_is_null = b === null || b === undefined;
    if (a_is_null && b_is_null) continue;
    if (a_is_null || b_is_null) {
      return null_order === 0 ? (a_is_null ? -1 : 1) : a_is_null ? 1 : -1;
    }
    const cmp = compare_3vl(a, b).result;
    if (cmp !== 0) {
      return direction === 1 ? -cmp : cmp;
    }
  }
  return 0;
}

export function compare_registers_to_sorter_keys(
  registers: any[],
  start_reg: number,
  keys_b: any[],
  key_info: VmKeyInfo,
): number {
  return compare_sorter_keys(
    registers.slice(start_reg, start_reg + key_info.numKeys),
    keys_b,
    key_info,
  );
}

export function fnv1a_32(values: any[]): number {
  let hash = 0x811c9dc5;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (v === null || v === undefined) {
      hash ^= 0xff;
      hash = Math.imul(hash, 0x01000193);
    } else if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) {
        hash ^= v.charCodeAt(i) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    } else {
      const n = Number(v) | 0;
      hash ^= n & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  hash = hash >>> 0;
  return hash === 0 ? 1 : hash;
}

export function group_keys_match(keys_a: any[], keys_b: any[]): boolean {
  if (keys_a.length !== keys_b.length) return false;
  for (let i = 0; i < keys_a.length; i++) {
    const a = keys_a[i];
    const b = keys_b[i];
    if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    if (compare_3vl(a, b).result !== 0) return false;
  }
  return true;
}

export function create_agg_buckets(capacity: number): VmAggBucket[] {
  return Array.from({ length: capacity }, () => ({
    hash: 0,
    keys: [],
    count: 0,
    sum: 0,
    min_val: Infinity,
    max_val: -Infinity,
    has_val: false,
  }));
}

export function sort_sorter_entries(sorter: VmSorter): void {
  sorter.entries.sort((a, b) => compare_sorter_keys(a.keys, b.keys, sorter.keyInfo));
  sorter.readIdx = sorter.keyInfo.offset ?? 0;
}

export function sorter_insert_row(
  ctx: VmContext,
  sorter: VmSorter,
  keys: any[],
  cursor_row_offset: number,
  row_len: number,
  view: DataView,
  _max_k: number,
): VmStatus {
  const row_data = new Uint8Array(row_len);
  row_data.set(new Uint8Array(view.buffer, view.byteOffset + cursor_row_offset, row_len));
  sorter.entries.push({ keys, rowOffset: cursor_row_offset, rowLen: row_len, rowData: row_data });
  return ctx.status;
}

export function serialize_result_registers(
  ctx: VmContext,
  start_reg: number,
  num_cols: number,
): Uint8Array {
  const cols: ColumnMeta[] =
    ctx.outputColumns && num_cols === ctx.outputColumns.length
      ? ctx.outputColumns
      : ctx.table && num_cols === ctx.table.columns.length
        ? ctx.table.columns
        : Array.from({ length: num_cols }, (_, c) => ({
            name: `col_${c}`,
            type: DataType.TEXT,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          }));
  const record: Record<string, any> = {};
  for (let c = 0; c < num_cols; c++) {
    record[cols[c].name] = ctx.registers[start_reg + c];
  }
  return page_serialize_row(cols, record);
}

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
  new Uint8Array(view.buffer, view.byteOffset + out_target + 2, row_bytes.byteLength).set(
    row_bytes,
  );
  ctx.resultOffset += needed;
  ctx.resultCount++;
  return VmStatus.RUNNING;
}

export function row_is_null(
  view: DataView,
  null_bitmap_offset: number,
  col_idx: number,
): boolean {
  return vm_row_is_null(view, null_bitmap_offset, col_idx) !== 0;
}

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
