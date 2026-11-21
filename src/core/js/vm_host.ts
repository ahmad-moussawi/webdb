/**
 * Shared Host-Boundary VM Runner & Pure-JS Helpers
 *
 * Kept intentionally free of any imports from `vm.c.ts` or `vm.helpers.c.ts`
 * so the WASM engine and host compiler/API can use this module without
 * statically pulling in the ~168 kB JS VM interpreter.
 */

import {
  SLOTS_BASE_OFFSET,
  PAGE_TO_SLOT_OFFSET,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  SLOT_TO_PAGE_OFFSET,
  VM_CONTEXT_OFFSET,
  RESULT_BUFFER_OFFSET,
  BYTECODE_OFFSET,
  BYTECODE_SIZE,
  TRANSIENT_ARENA_OFFSET,
  TOTAL_MEMORY_BYTES,
  DEFAULT_MAX_QUERY_MEMORY,
} from "../../constants.ts";
import { VmStatus, DataType } from "../../types/index.ts";
import {
  memset,
  read_u8,
  write_u8,
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
import type { VmContext, VmKeyInfo } from "../../shared/index.ts";
import type { WasmCoreExports } from "../wasm/wasm_runtime.ts";

// ============================================================================
// Shared VmContext Layout Constants (must match src/core/js/vm.helpers.c.ts)
// ============================================================================

export const VM_CTX_PC = 0;
export const VM_CTX_STATUS = 4;
export const VM_CTX_FAULT_PAGE_ID = 8;
export const VM_CTX_RESULT_COUNT = 12;
export const VM_CTX_RESULT_OFFSET = 16;
export const VM_CTX_ARENA_OFFSET = 20;
export const VM_CTX_MAX_QUERY_MEMORY = 24;
export const VM_CTX_HAS_BUFFER_POOL = 28;
export const VM_CTX_NUM_TABLES = 32;
export const VM_CTX_NUM_KEY_INFOS = 40;
export const VM_CTX_NUM_IN_SETS = 44;
export const VM_CTX_UDF_ID = 48;
export const VM_CTX_UDF_START_REG = 52;
export const VM_CTX_UDF_NUM_ARGS = 56;
export const VM_CTX_UDF_DEST_REG = 60;
export const VM_CTX_PHYS_ARENA_USED = 64;

export const VM_CTX_REGISTERS_OFF = 72;
export const VM_REG_IS_NULL = 0;
export const VM_REG_TYPE = 1;
export const VM_REG_I32 = 4;
export const VM_REG_I64 = 8;
export const VM_REG_F64 = 16;
export const VM_REG_DATA_OFF = 24;
export const VM_REG_DATA_LEN = 28;

export const VM_CTX_CURSORS_OFF = 2120;
export const VM_CURSOR_SIZE = 24;
export const VM_CUR_PAGE_ID = 0;
export const VM_CUR_ROOT_PAGE_ID = 4;
export const VM_CUR_SLOT_IDX = 8;
export const VM_CUR_CELL_IDX = 12;
export const VM_CUR_ROW_OFFSET = 16;

export const VM_CTX_TABLES_OFF = 2504;
export const VM_TABLE_DESC_SIZE = 260;
export const VM_CTX_OUTPUT_COLS_OFF = 6664;
export const VM_CTX_KEY_INFOS_OFF = 6928;
export const VM_KEY_INFO_SIZE = 32;
export const VM_KI_NUM_KEYS = 0;
export const VM_KI_HAS_LIMIT = 1;
export const VM_KI_LIMIT = 4;
export const VM_KI_OFFSET = 8;
export const VM_KI_DIRECTIONS = 12;
export const VM_KI_NULL_ORDERS = 20;

export const VM_CTX_SORTERS_OFF = 7184;
export const VM_CTX_AGGS_OFF = 7312;
export const VM_AGG_SIZE = 32;
export const VM_AGG_IS_OPEN = 0;
export const VM_AGG_MODE = 1;
export const VM_AGG_START_KEY_REG = 2;
export const VM_AGG_NUM_KEYS = 3;
export const VM_AGG_CAPACITY = 4;
export const VM_AGG_OCCUPIED = 8;
export const VM_AGG_READ_IDX = 12;

export const VM_CTX_IN_SETS_OFF = 7440;
export const VM_CTX_SLOTS_BASE_OFF = 7568;
export const VM_CTX_PAGE_TO_SLOT_OFF = 7572;
export const VM_CTX_PAGE_TO_SLOT_BUCKETS = 7576;
export const VM_CTX_ARENA_BASE_OFF = 7580;
export const VM_STATUS_HOST_UDF = 99;

// ============================================================================
// Pluggable Core Engine Contract
// ============================================================================

export type VmStepFn = (
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array,
) => VmStatus;

export interface WebDbCoreEngine {
  readonly mode: "js" | "wasm";
  init(memory: WebAssembly.Memory):
    | Promise<{ vm_step: VmStepFn; wasmCore?: WasmCoreExports }>
    | { vm_step: VmStepFn; wasmCore?: WasmCoreExports };
}

// ============================================================================
// Minimal Linear-Memory Register/Arena Primitives for Host Marshaling
// ============================================================================

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

function hostRegOff(ctx_off: number, reg_idx: number): number {
  return ctx_off + VM_CTX_REGISTERS_OFF + (reg_idx << 5);
}

function hostCursorOff(ctx_off: number, cursor_idx: number): number {
  return ctx_off + VM_CTX_CURSORS_OFF + cursor_idx * VM_CURSOR_SIZE;
}

function hostPhysAlloc(
  view: DataView,
  ctx_off: number,
  arena_base: number,
  bytes: number,
): number {
  const aligned = (bytes + 7) & (~7 >>> 0);
  const used = read_u32(view, ctx_off + VM_CTX_PHYS_ARENA_USED);
  if (
    bytes > DEFAULT_MAX_QUERY_MEMORY ||
    aligned < bytes ||
    used > DEFAULT_MAX_QUERY_MEMORY ||
    aligned > DEFAULT_MAX_QUERY_MEMORY - used
  ) {
    return 0;
  }
  write_u32(view, ctx_off + VM_CTX_PHYS_ARENA_USED, used + aligned);
  return arena_base + used;
}

function hostRegSetNull(view: DataView, reg_off: number): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 1);
  write_u8(view, reg_off + VM_REG_TYPE, DataType.NULL);
  write_i32(view, reg_off + VM_REG_I32, 0);
  write_i64(view, reg_off + VM_REG_I64, 0n);
  write_f64(view, reg_off + VM_REG_F64, 0.0);
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

function hostRegSetI32(view: DataView, reg_off: number, val: number): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);
  write_u8(view, reg_off + VM_REG_TYPE, DataType.INT32);
  write_i32(view, reg_off + VM_REG_I32, val);
  write_i64(view, reg_off + VM_REG_I64, f64_to_i64(val));
  write_f64(view, reg_off + VM_REG_F64, val);
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

function hostRegSetI64(view: DataView, reg_off: number, val: bigint): void {
  const as_f64 = i64_to_f64(val);
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);
  write_u8(view, reg_off + VM_REG_TYPE, DataType.INT64);
  write_i32(view, reg_off + VM_REG_I32, i64_to_i32(val));
  write_i64(view, reg_off + VM_REG_I64, val);
  write_f64(view, reg_off + VM_REG_F64, as_f64);
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

function hostRegSetF64(view: DataView, reg_off: number, val: number): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);
  write_u8(view, reg_off + VM_REG_TYPE, DataType.FLOAT64);
  write_i32(view, reg_off + VM_REG_I32, f64_to_i32(val));
  write_i64(view, reg_off + VM_REG_I64, f64_to_i64(val));
  write_f64(view, reg_off + VM_REG_F64, val);
  write_u32(view, reg_off + VM_REG_DATA_OFF, 0);
  write_u32(view, reg_off + VM_REG_DATA_LEN, 0);
}

function hostRegSetSlice(
  view: DataView,
  reg_off: number,
  col_type: number,
  data_off: number,
  data_len: number,
): void {
  write_u8(view, reg_off + VM_REG_IS_NULL, 0);
  write_u8(view, reg_off + VM_REG_TYPE, col_type);
  write_i32(view, reg_off + VM_REG_I32, 0);
  write_i64(view, reg_off + VM_REG_I64, 0n);
  write_f64(view, reg_off + VM_REG_F64, 0.0);
  write_u32(view, reg_off + VM_REG_DATA_OFF, data_off);
  write_u32(view, reg_off + VM_REG_DATA_LEN, data_len);
}

function writeValueToSlot(
  view: DataView,
  ctx_off: number,
  arena_base: number,
  slot_off: number,
  val: any,
): void {
  if (val === null || val === undefined) {
    hostRegSetNull(view, slot_off);
  } else if (typeof val === "boolean") {
    hostRegSetI32(view, slot_off, val ? 1 : 0);
  } else if (typeof val === "number") {
    if (Number.isInteger(val) && val >= -2147483648 && val <= 2147483647) {
      hostRegSetI32(view, slot_off, val);
    } else {
      hostRegSetF64(view, slot_off, val);
    }
  } else if (typeof val === "bigint") {
    hostRegSetI64(view, slot_off, val);
  } else if (typeof val === "string") {
    const bytes = text_encoder.encode(val);
    if (bytes.byteLength === 0) {
      hostRegSetSlice(view, slot_off, DataType.TEXT, 0, 0);
    } else {
      const dst = hostPhysAlloc(view, ctx_off, arena_base, bytes.byteLength);
      if (dst === 0) {
        throw new Error("Arena memory exhausted for UDF return value");
      }
      new Uint8Array(view.buffer, view.byteOffset + dst, bytes.byteLength).set(
        bytes,
      );
      hostRegSetSlice(view, slot_off, DataType.TEXT, dst, bytes.byteLength);
    }
  } else if (val instanceof Uint8Array) {
    if (val.byteLength === 0) {
      hostRegSetSlice(view, slot_off, DataType.BLOB, 0, 0);
    } else {
      const dst = hostPhysAlloc(view, ctx_off, arena_base, val.byteLength);
      if (dst === 0) {
        throw new Error("Arena memory exhausted for UDF return value");
      }
      new Uint8Array(view.buffer, view.byteOffset + dst, val.byteLength).set(
        val,
      );
      hostRegSetSlice(view, slot_off, DataType.BLOB, dst, val.byteLength);
    }
  } else {
    hostRegSetNull(view, slot_off);
  }
}

function readValueFromSlot(view: DataView, slot_off: number): any {
  if (read_u8(view, slot_off + VM_REG_IS_NULL) !== 0) {
    return null;
  }
  const r_type = read_u8(view, slot_off + VM_REG_TYPE);
  if (r_type === DataType.INT32) {
    return read_i32(view, slot_off + VM_REG_I32);
  }
  if (r_type === DataType.INT64) {
    const v = read_i64(view, slot_off + VM_REG_I64);
    if (v >= -9007199254740991n && v <= 9007199254740991n) {
      return Number(v);
    }
    return v;
  }
  if (r_type === DataType.FLOAT64) {
    return read_f64(view, slot_off + VM_REG_F64);
  }
  const d_off = read_u32(view, slot_off + VM_REG_DATA_OFF);
  const d_len = read_u32(view, slot_off + VM_REG_DATA_LEN);
  if (
    r_type === DataType.TEXT ||
    r_type === DataType.UUID ||
    r_type === DataType.ULID
  ) {
    if (d_len === 0) return "";
    return text_decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + d_off, d_len),
    );
  }
  if (r_type === DataType.BLOB) {
    const out = new Uint8Array(d_len);
    if (d_len > 0) {
      out.set(new Uint8Array(view.buffer, view.byteOffset + d_off, d_len));
    }
    return out;
  }
  return null;
}

// ============================================================================
// Host-Boundary Marshaling for JS & WASM Execution
// ============================================================================

export function executeVmStepWithRunner(
  ctx: VmContext,
  view: DataView,
  bytecode: Uint8Array,
  runRaw: (
    activeView: DataView,
    ctxOff: number,
    codeOff: number,
    codeLen: number,
    arenaBase: number,
  ) => number,
  targetBuffer?: ArrayBuffer,
): VmStatus {
  let activeView = view;
  let needsCopyBack = false;
  const pool = (view.buffer as any).__webdbPool;
  const minArenaEnd =
    (pool ? pool.transientArenaOffset : TRANSIENT_ARENA_OFFSET) + 65536;

  if (targetBuffer) {
    if (view.buffer === targetBuffer && view.byteOffset === 0) {
      activeView =
        view.byteLength >= minArenaEnd
          ? view
          : new DataView(targetBuffer);
    } else {
      activeView = new DataView(targetBuffer);
      const copyLen = Math.min(
        view.byteLength,
        SLOT_TO_PAGE_OFFSET - SLOTS_BASE_OFFSET,
      );
      new Uint8Array(targetBuffer, SLOTS_BASE_OFFSET, copyLen).set(
        new Uint8Array(view.buffer, view.byteOffset, copyLen),
      );
      needsCopyBack = true;
    }
  } else if (view.byteLength < minArenaEnd || view.byteOffset !== 0) {
    const holder = executeVmStepWithRunner as any;
    if (!holder._fallbackBuffer || !holder._fallbackView) {
      holder._fallbackBuffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      holder._fallbackView = new DataView(holder._fallbackBuffer);
    }
    const copyLen = Math.min(
      view.byteLength,
      SLOT_TO_PAGE_OFFSET - SLOTS_BASE_OFFSET,
    );
    new Uint8Array(holder._fallbackBuffer, SLOTS_BASE_OFFSET, copyLen).set(
      new Uint8Array(view.buffer, view.byteOffset, copyLen),
    );
    activeView = holder._fallbackView;
    needsCopyBack = true;
  }

  const ctx_off = VM_CONTEXT_OFFSET;
  const code_off = BYTECODE_OFFSET;
  const arena_base = pool ? pool.transientArenaOffset : TRANSIENT_ARENA_OFFSET;
  const meta = ctx as any;
  const fastHost = ctx._fastHostMode === true;

  if (
    meta._syncedResetId !== ctx._resetId ||
    meta._syncedBuffer !== activeView.buffer
  ) {
    memset(activeView, ctx_off, 0, VM_CTX_CURSORS_OFF + 384);
    memset(activeView, ctx_off + VM_CTX_SORTERS_OFF, 0, 256);
    for (let r = 0; r < 64; r++) {
      write_u8(
        activeView,
        ctx_off + VM_CTX_REGISTERS_OFF + (r << 5) + VM_REG_IS_NULL,
        1,
      );
    }
    if (!fastHost) {
      if (!meta._lastSyncedRegs) {
        meta._lastSyncedRegs = new Array(64).fill(null);
      } else {
        meta._lastSyncedRegs.fill(null);
      }
    }
    meta._syncedInSetsRef = null;
    meta._syncedResetId = ctx._resetId;
    meta._syncedBuffer = activeView.buffer;
  }

  if (needsCopyBack && ctx.resultOffset > 0) {
    const resEnd = RESULT_BUFFER_OFFSET + ctx.resultOffset;
    if (view.byteLength >= resEnd) {
      new Uint8Array(
        activeView.buffer,
        activeView.byteOffset + RESULT_BUFFER_OFFSET,
        ctx.resultOffset,
      ).set(
        new Uint8Array(
          view.buffer,
          view.byteOffset + RESULT_BUFFER_OFFSET,
          ctx.resultOffset,
        ),
      );
    }
  }

  const tables = ctx.tables ?? (ctx.table ? [ctx.table] : []);
  const num_tables = Math.min(tables.length, 16);
  write_u32(activeView, ctx_off + VM_CTX_NUM_TABLES, num_tables);
  for (let t = 0; t < num_tables; t++) {
    const tbl = tables[t] ?? tables[0];
    const tbl_off = ctx_off + VM_CTX_TABLES_OFF + t * VM_TABLE_DESC_SIZE;
    if (tbl) {
      const num_cols = Math.min(tbl.columns.length, 256);
      write_u16(activeView, tbl_off + 0, num_cols);
      write_u16(activeView, tbl_off + 2, Math.ceil(num_cols / 8));
      for (let c = 0; c < num_cols; c++) {
        write_u8(activeView, tbl_off + 4 + c, tbl.columns[c].type);
      }
    }
  }

  const out_cols_off = ctx_off + VM_CTX_OUTPUT_COLS_OFF;
  if (ctx.outputColumns && ctx.outputColumns.length > 0) {
    const n_out = Math.min(ctx.outputColumns.length, 256);
    write_u8(activeView, out_cols_off + 0, 1);
    write_u16(activeView, out_cols_off + 2, n_out);
    for (let c = 0; c < n_out; c++) {
      write_u8(activeView, out_cols_off + 4 + c, ctx.outputColumns[c].type);
    }
  } else {
    write_u8(activeView, out_cols_off + 0, 0);
    write_u16(activeView, out_cols_off + 2, 0);
  }

  const num_ki = Math.min(ctx.keyInfos?.length ?? 0, 8);
  write_u32(activeView, ctx_off + VM_CTX_NUM_KEY_INFOS, num_ki);
  for (let k = 0; k < num_ki; k++) {
    const ki = ctx.keyInfos[k];
    const ki_off = ctx_off + VM_CTX_KEY_INFOS_OFF + k * VM_KEY_INFO_SIZE;
    const nk = Math.min(ki.numKeys, 8);
    write_u8(activeView, ki_off + VM_KI_NUM_KEYS, nk);
    write_u8(activeView, ki_off + VM_KI_HAS_LIMIT, ki.limit !== undefined ? 1 : 0);
    write_u32(activeView, ki_off + VM_KI_LIMIT, ki.limit ?? 0);
    write_u32(activeView, ki_off + VM_KI_OFFSET, ki.offset ?? 0);
    for (let d = 0; d < nk; d++) {
      const dir = ki.directions[d] ?? 0;
      const null_ord = ki.nullOrders?.[d] ?? (dir === 1 ? 1 : 0);
      write_u8(activeView, ki_off + VM_KI_DIRECTIONS + d, dir);
      write_u8(activeView, ki_off + VM_KI_NULL_ORDERS + d, null_ord);
    }
  }

  if (ctx.inSets && ctx.inSets.length > 0 && meta._syncedInSetsRef !== ctx.inSets) {
    const num_sets = Math.min(ctx.inSets.length, 16);
    write_u32(activeView, ctx_off + VM_CTX_NUM_IN_SETS, num_sets);
    for (let s = 0; s < num_sets; s++) {
      const set = ctx.inSets[s];
      const set_desc_off = ctx_off + VM_CTX_IN_SETS_OFF + s * 8;
      if (!set || set.size === 0) {
        write_u32(activeView, set_desc_off + 0, 0);
        write_u32(activeView, set_desc_off + 4, 0);
      } else {
        const items = Array.from(set);
        const items_off = hostPhysAlloc(
          activeView,
          ctx_off,
          arena_base,
          items.length * 32,
        );
        if (items_off === 0) {
          ctx.status = VmStatus.ARENA_EXHAUSTED;
          return VmStatus.ARENA_EXHAUSTED;
        }
        write_u32(activeView, set_desc_off + 0, items.length);
        write_u32(activeView, set_desc_off + 4, items_off);
        for (let idx = 0; idx < items.length; idx++) {
          try {
            writeValueToSlot(
              activeView,
              ctx_off,
              arena_base,
              items_off + idx * 32,
              items[idx],
            );
          } catch {
            ctx.status = VmStatus.ARENA_EXHAUSTED;
            return VmStatus.ARENA_EXHAUSTED;
          }
        }
      }
    }
    meta._syncedInSetsRef = ctx.inSets;
  }

  if (!fastHost) {
    for (let c = 0; c < 16; c++) {
      const cur = (ctx.cursors && ctx.cursors[c]) ?? (c === 0 ? ctx.cursor : undefined);
      const cur_off = hostCursorOff(ctx_off, c);
      if (cur) {
        write_u32(activeView, cur_off + VM_CUR_PAGE_ID, cur.pageId);
        write_u32(activeView, cur_off + VM_CUR_ROOT_PAGE_ID, cur.rootPageId ?? 0);
        write_i32(activeView, cur_off + VM_CUR_SLOT_IDX, cur.slotIdx);
        write_i32(activeView, cur_off + VM_CUR_CELL_IDX, cur.cellIdx);
        write_u32(activeView, cur_off + VM_CUR_ROW_OFFSET, cur.rowOffset);
      }
    }

    const lastRegs: any[] = meta._lastSyncedRegs;
    for (let r = 0; r < 64; r++) {
      if (ctx.registers[r] !== lastRegs[r]) {
        writeValueToSlot(
          activeView,
          ctx_off,
          arena_base,
          hostRegOff(ctx_off, r),
          ctx.registers[r],
        );
        lastRegs[r] = ctx.registers[r];
      }
    }
  }

  let has_buffer_pool = 0;
  let slots_base = needsCopyBack ? SLOTS_BASE_OFFSET : 0;
  let page_to_slot_off = PAGE_TO_SLOT_OFFSET;
  let page_to_slot_buckets = DEFAULT_PAGE_TO_SLOT_BUCKETS;

  if (pool && !needsCopyBack) {
    has_buffer_pool = 1;
    slots_base = pool.slotsBaseOffset ?? SLOTS_BASE_OFFSET;
    page_to_slot_off = pool.pageToSlotOffset;
    page_to_slot_buckets = pool.pageToSlotBuckets;
  } else if (
    !needsCopyBack &&
    view.byteLength >= SLOT_TO_PAGE_OFFSET + 4 &&
    view.getUint32(SLOT_TO_PAGE_OFFSET, true) > 0
  ) {
    has_buffer_pool = 1;
    slots_base = SLOTS_BASE_OFFSET;
  }

  write_u32(activeView, ctx_off + VM_CTX_PC, ctx.pc);
  write_i32(activeView, ctx_off + VM_CTX_STATUS, ctx.status);
  write_u32(activeView, ctx_off + VM_CTX_FAULT_PAGE_ID, ctx.fault_page_id);
  write_u32(activeView, ctx_off + VM_CTX_RESULT_COUNT, ctx.resultCount);
  write_u32(activeView, ctx_off + VM_CTX_RESULT_OFFSET, ctx.resultOffset);
  write_u32(activeView, ctx_off + VM_CTX_ARENA_OFFSET, ctx.arenaOffset);
  write_u32(activeView, ctx_off + VM_CTX_MAX_QUERY_MEMORY, ctx.maxQueryMemory);
  write_u32(activeView, ctx_off + VM_CTX_HAS_BUFFER_POOL, has_buffer_pool);
  write_u32(activeView, ctx_off + VM_CTX_SLOTS_BASE_OFF, slots_base);
  write_u32(activeView, ctx_off + VM_CTX_PAGE_TO_SLOT_OFF, page_to_slot_off);
  write_u32(activeView, ctx_off + VM_CTX_PAGE_TO_SLOT_BUCKETS, page_to_slot_buckets);
  write_u32(activeView, ctx_off + VM_CTX_ARENA_BASE_OFF, arena_base);

  if (bytecode.byteLength > BYTECODE_SIZE) {
    ctx.status = VmStatus.INVALID_BYTECODE;
    return VmStatus.INVALID_BYTECODE;
  }

  new Uint8Array(
    activeView.buffer,
    activeView.byteOffset + code_off,
    bytecode.byteLength,
  ).set(bytecode);

  let status = runRaw(
    activeView,
    ctx_off,
    code_off,
    bytecode.byteLength,
    arena_base,
  );

  while (status === VM_STATUS_HOST_UDF) {
    const udf_id = read_u32(activeView, ctx_off + VM_CTX_UDF_ID);
    const start_arg_reg = read_u32(activeView, ctx_off + VM_CTX_UDF_START_REG);
    const num_args = read_u32(activeView, ctx_off + VM_CTX_UDF_NUM_ARGS);
    const dest_reg = read_u32(activeView, ctx_off + VM_CTX_UDF_DEST_REG);

    const fn = ctx.udfs?.[udf_id];
    if (!fn) {
      status = VmStatus.INVALID_BYTECODE;
      write_i32(activeView, ctx_off + VM_CTX_STATUS, status);
      break;
    }

    const args: any[] = [];
    for (let a = 0; a < num_args; a++) {
      args.push(
        readValueFromSlot(activeView, hostRegOff(ctx_off, start_arg_reg + a)),
      );
    }

    try {
      const res = fn(...args);
      writeValueToSlot(
        activeView,
        ctx_off,
        arena_base,
        hostRegOff(ctx_off, dest_reg),
        res,
      );
      write_i32(activeView, ctx_off + VM_CTX_STATUS, VmStatus.RUNNING);
      status = runRaw(
        activeView,
        ctx_off,
        code_off,
        bytecode.byteLength,
        arena_base,
      );
    } catch {
      status = VmStatus.ERROR;
      write_i32(activeView, ctx_off + VM_CTX_STATUS, status);
      break;
    }
  }

  ctx.pc = read_u32(activeView, ctx_off + VM_CTX_PC);
  ctx.status = status as VmStatus;
  ctx.resultCount = read_u32(activeView, ctx_off + VM_CTX_RESULT_COUNT);
  ctx.resultOffset = read_u32(activeView, ctx_off + VM_CTX_RESULT_OFFSET);
  ctx.arenaOffset = read_u32(activeView, ctx_off + VM_CTX_ARENA_OFFSET);

  if (fastHost) {
    if (status === VmStatus.PAGE_FAULT) {
      ctx.fault_page_id = read_u32(activeView, ctx_off + VM_CTX_FAULT_PAGE_ID);
      for (let c = 0; c < 16; c++) {
        const cur = ctx.cursors[c];
        if (cur) {
          cur.pageId = read_u32(
            activeView,
            hostCursorOff(ctx_off, c) + VM_CUR_PAGE_ID,
          );
        }
      }
    }
  } else {
    ctx.fault_page_id = read_u32(activeView, ctx_off + VM_CTX_FAULT_PAGE_ID);

    for (let c = 0; c < 16; c++) {
      const cur_off = hostCursorOff(ctx_off, c);
      const cur = ctx.cursors[c];
      if (cur) {
        cur.pageId = read_u32(activeView, cur_off + VM_CUR_PAGE_ID);
        cur.rootPageId = read_u32(activeView, cur_off + VM_CUR_ROOT_PAGE_ID);
        cur.slotIdx = read_i32(activeView, cur_off + VM_CUR_SLOT_IDX);
        cur.cellIdx = read_i32(activeView, cur_off + VM_CUR_CELL_IDX);
        cur.rowOffset = read_u32(activeView, cur_off + VM_CUR_ROW_OFFSET);
      }
    }
    if (ctx.cursor && ctx.cursors && ctx.cursor !== ctx.cursors[0]) {
      Object.assign(ctx.cursor, ctx.cursors[0]);
    }

    const lastRegs: any[] = meta._lastSyncedRegs;
    for (let r = 0; r < 64; r++) {
      const val = readValueFromSlot(activeView, hostRegOff(ctx_off, r));
      ctx.registers[r] = val;
      lastRegs[r] = val;
    }

    for (let a = 0; a < 4; a++) {
      const agg_off = ctx_off + VM_CTX_AGGS_OFF + a * VM_AGG_SIZE;
      if (read_u8(activeView, agg_off + VM_AGG_IS_OPEN) !== 0) {
        const cap = read_u32(activeView, agg_off + VM_AGG_CAPACITY);
        const occ = read_u32(activeView, agg_off + VM_AGG_OCCUPIED);
        const rIdx = read_u32(activeView, agg_off + VM_AGG_READ_IDX);
        if (ctx.aggregators[a]) {
          ctx.aggregators[a].capacity = cap;
          ctx.aggregators[a].occupiedCount = occ;
          ctx.aggregators[a].readIdx = rIdx;
        } else {
          ctx.aggregators[a] = {
            mode: read_u8(activeView, agg_off + VM_AGG_MODE),
            startKeyReg: read_u8(activeView, agg_off + VM_AGG_START_KEY_REG),
            numKeys: read_u8(activeView, agg_off + VM_AGG_NUM_KEYS),
            capacity: cap,
            occupiedCount: occ,
            readIdx: rIdx,
            buckets: [],
            currentBucket: null,
          };
        }
      }
    }
  }

  if (needsCopyBack && ctx.resultOffset > 0) {
    const resEnd = RESULT_BUFFER_OFFSET + ctx.resultOffset;
    if (view.byteLength >= resEnd) {
      new Uint8Array(
        view.buffer,
        view.byteOffset + RESULT_BUFFER_OFFSET,
        ctx.resultOffset,
      ).set(
        new Uint8Array(
          activeView.buffer,
          activeView.byteOffset + RESULT_BUFFER_OFFSET,
          ctx.resultOffset,
        ),
      );
    }
  }

  return status as VmStatus;
}

// ============================================================================
// Pure-JS Host Helpers (LIKE, 3VL compare, sorter keys, FNV-1a)
// ============================================================================

function asciiLower(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

export function sql_like_match(str: string, pattern: string): boolean {
  const strLen = str.length;
  const patLen = pattern.length;
  let s = 0;
  let p = 0;
  let starP = -1;
  let starS = -1;

  while (s < strLen) {
    const pc = p < patLen ? pattern.charCodeAt(p) : 0;
    const sc = str.charCodeAt(s);
    if (p < patLen && (pc === 95 || asciiLower(pc) === asciiLower(sc))) {
      s++;
      p++;
    } else if (p < patLen && pc === 37) {
      starP = p++;
      starS = s;
    } else if (starP !== -1) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }

  while (p < patLen && pattern.charCodeAt(p) === 37) {
    p++;
  }

  return p === patLen;
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
    return {
      result: num_a === num_b ? 0 : num_a > num_b ? 1 : -1,
      is_unknown: false,
    };
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
  return {
    result: val_a === val_b ? 0 : val_a > val_b ? 1 : -1,
    is_unknown: false,
  };
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
