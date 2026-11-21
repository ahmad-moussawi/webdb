/**
 * WebDB WebAssembly Core Runtime Adapter
 *
 * Wraps compiled C WebAssembly exports without statically importing either
 * `embedded_wasm.ts` (70 KB base64) or the JS VM interpreter (`vm.c.ts` /
 * `vm.helpers.c.ts`), enabling on-demand loading and external `.wasm` streaming.
 */

import {
  PAGE_TYPE_LEAF_DATA,
  BYTECODE_OFFSET,
  BYTECODE_SIZE,
  WASM_STACK_TOP,
} from "../../constants.ts";
import { DataType } from "../../types/index.ts";
import { UuidCodec, UlidCodec } from "../js/codecs.c.ts";
import {
  page_compact as js_page_compact,
  page_insert_row as js_page_insert_row,
  page_update_row as js_page_update_row,
  page_insert_index_leaf_cell as js_page_insert_index_leaf_cell,
  page_delete_index_leaf_cell as js_page_delete_index_leaf_cell,
  page_binary_search_index_leaf as js_page_binary_search_index_leaf,
} from "../js/page.c.ts";
import {
  buf_pool_pin_slot as js_buf_pool_pin_slot,
  buf_pool_unpin_slot as js_buf_pool_unpin_slot,
  buf_pool_is_pinned as js_buf_pool_is_pinned,
  buf_pool_find_victim as js_buf_pool_find_victim,
  buf_pool_select_eviction_victim as js_buf_pool_select_eviction_victim,
} from "../js/buffer_pool.c.ts";
import { catalog_read_page1_header as js_catalog_read_page1_header } from "../js/catalog.c.ts";
import {
  executeVmStepWithRunner,
  sql_like_match as host_sql_like_match,
  fnv1a_32 as host_fnv1a_32,
  compare_sorter_keys as host_compare_sorter_keys,
  type VmStepFn,
} from "../js/vm_host.ts";

const wasmTextEncoder = new TextEncoder();

export interface WasmCoreExports {
  instance: WebAssembly.Instance;
  exports: Record<string, any>;
  memory: WebAssembly.Memory;

  // Page
  page_init: (view: DataView, page_offset: number, page_type?: number, next_page_id?: number) => void;
  page_init_free: (view: DataView, page_offset: number, next_free_page_id?: number) => void;
  page_get_type: (view: DataView, page_offset: number) => number;
  page_set_type: (view: DataView, page_offset: number, type: number) => void;
  page_get_cell_count: (view: DataView, page_offset: number) => number;
  page_set_cell_count: (view: DataView, page_offset: number, count: number) => void;
  page_get_cell_content_offset: (view: DataView, page_offset: number) => number;
  page_set_cell_content_offset: (view: DataView, page_offset: number, offset: number) => void;
  page_get_next_page_id: (view: DataView, page_offset: number) => number;
  page_set_next_page_id: (view: DataView, page_offset: number, next_page_id: number) => void;
  page_get_free_bytes: (view: DataView, page_offset: number) => number;
  page_set_free_bytes: (view: DataView, page_offset: number, free_bytes: number) => void;
  page_get_checksum: (view: DataView, page_offset: number) => number;
  page_set_checksum: (view: DataView, page_offset: number, checksum: number) => void;
  page_get_cell_offset: (view: DataView, page_offset: number, slot_idx: number) => number;
  page_set_cell_offset: (view: DataView, page_offset: number, slot_idx: number, cell_offset: number) => void;
  page_get_contiguous_free_space: (view: DataView, page_offset: number) => number;
  page_get_total_free_space: (view: DataView, page_offset: number) => number;
  page_compact: (view: DataView, page_offset: number, scratchpad_offset?: number, replacement?: any) => void;
  page_get_row_length: (view: DataView, row_offset: number) => number;
  page_insert_row: (view: DataView, page_offset: number, row_bytes: Uint8Array, scratchpad_offset?: number) => number;
  page_delete_row: (view: DataView, page_offset: number, cell_idx: number) => void;
  page_update_row: (view: DataView, page_offset: number, cell_idx: number, new_row_bytes: Uint8Array, scratchpad_offset?: number) => boolean;
  page_insert_index_leaf_cell: (view: DataView, page_offset: number, key_type: DataType, key_value: any, rowid: bigint, scratchpad_offset?: number) => number;
  page_delete_index_leaf_cell: (view: DataView, page_offset: number, slot_idx: number) => void;
  page_binary_search_index_leaf: (view: DataView, page_offset: number, target_type: DataType, target_value: any, target_row_id?: bigint) => { found: boolean; slot_idx: number };

  // Page Table
  page_table_hash: (page_id: number, mask: number) => number;
  page_table_get: (view: DataView, base_offset: number, bucket_count: number, page_id: number) => number;
  page_table_set: (view: DataView, base_offset: number, bucket_count: number, page_id: number, slot_idx: number) => void;
  page_table_delete: (view: DataView, base_offset: number, bucket_count: number, page_id: number) => boolean;

  // Buffer Pool
  buf_pool_get_slot_offset: (slot_idx: number) => number;
  buf_pool_read_slot_to_page: (view: DataView, slot_to_page_offset: number, slot_idx: number) => number;
  buf_pool_write_slot_to_page: (view: DataView, slot_to_page_offset: number, slot_idx: number, page_id: number) => void;
  buf_pool_get_resident_slot: (view: DataView, page_to_slot_offset: number, page_to_slot_buckets: number, page_id: number) => number;
  buf_pool_assign_slot: (view: DataView, slot_to_page_offset: number, page_to_slot_offset: number, page_to_slot_buckets: number, slot_idx: number, page_id: number) => void;
  buf_pool_unassign_slot: (view: DataView, slot_to_page_offset: number, page_to_slot_offset: number, page_to_slot_buckets: number, slot_idx: number) => void;
  buf_pool_mark_dirty: (view: DataView | Uint8Array, dirty_mask_offset: number, slot_idx: number) => void;
  buf_pool_clear_dirty: (view: DataView | Uint8Array, dirty_mask_offset: number, slot_idx: number) => void;
  buf_pool_is_dirty: (view: DataView | Uint8Array, dirty_mask_offset: number, slot_idx: number) => boolean;
  buf_pool_pin_slot: (pin_counts: Uint32Array, slot_idx: number) => void;
  buf_pool_unpin_slot: (pin_counts: Uint32Array, slot_idx: number) => void;
  buf_pool_is_pinned: (pin_counts: Uint32Array, slot_idx: number) => boolean;
  buf_pool_find_victim: (buffer: ArrayBuffer, ref_bits: Uint8Array, pin_counts: Uint32Array, slot_to_page_offset: number, slot_count: number, current_clock_hand: number) => { candidate_slot: number; next_clock_hand: number };
  buf_pool_select_eviction_victim: (buffer: ArrayBuffer, ref_bits: Uint8Array, pin_counts: Uint32Array, slot_to_page_offset: number, dirty_mask_offset: number, slot_count: number, current_clock_hand: number, page_id: number) => { candidate_slot: number; flush_page_id: number; next_clock_hand: number };

  // Catalog
  catalog_init_page1: (view: DataView) => void;
  catalog_read_page1_header: typeof js_catalog_read_page1_header;
  catalog_get_total_pages: (view: DataView) => number;
  catalog_set_total_pages: (view: DataView, count: number) => void;
  catalog_get_free_page_head: (view: DataView) => number;
  catalog_set_free_page_head: (view: DataView, page_id: number) => void;
  catalog_get_schema_version: (view: DataView) => number;
  catalog_increment_schema_version: (view: DataView) => number;
  catalog_get_change_counter: (view: DataView) => number;
  catalog_increment_change_counter: (view: DataView) => number;
  catalog_update_page1_checksum: (view: DataView) => number;

  // VM & Helpers
  sql_like_match: (str: string, pattern: string) => boolean;
  fnv1a_32: (values: any[]) => number;
  compare_sorter_keys: typeof host_compare_sorter_keys;
  vm_step: VmStepFn;
}

function wrapWasmInstance(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
): WasmCoreExports {
  const exp = instance.exports as Record<string, any>;
  if (exp.__stack_pointer && typeof exp.__stack_pointer === "object" && "value" in exp.__stack_pointer) {
    exp.__stack_pointer.value = WASM_STACK_TOP;
  }

  const getAbsOffset = (view: DataView | Uint8Array, offset: number = 0) => {
    return view.byteOffset + offset;
  };

  let cachedMemU8 = new Uint8Array(memory.buffer);
  const getMemU8 = () => {
    if (cachedMemU8.buffer !== memory.buffer) {
      cachedMemU8 = new Uint8Array(memory.buffer);
    }
    return cachedMemU8;
  };

  return {
    instance,
    exports: exp,
    memory,

    // Page Operations
    page_init: (view, page_offset, page_type = PAGE_TYPE_LEAF_DATA, next_page_id = 0) => {
      exp.page_init(getAbsOffset(view, page_offset), page_type, next_page_id);
    },
    page_init_free: (view, page_offset, next_free_page_id = 0) => {
      exp.page_init_free(getAbsOffset(view, page_offset), next_free_page_id);
    },
    page_get_type: (view, page_offset) => exp.page_get_type(getAbsOffset(view, page_offset)),
    page_set_type: (view, page_offset, type) => {
      exp.page_set_type(getAbsOffset(view, page_offset), type);
    },
    page_get_cell_count: (view, page_offset) => exp.page_get_cell_count(getAbsOffset(view, page_offset)),
    page_set_cell_count: (view, page_offset, count) => {
      exp.page_set_cell_count(getAbsOffset(view, page_offset), count);
    },
    page_get_cell_content_offset: (view, page_offset) => exp.page_get_cell_content_offset(getAbsOffset(view, page_offset)),
    page_set_cell_content_offset: (view, page_offset, offset) => {
      exp.page_set_cell_content_offset(getAbsOffset(view, page_offset), offset);
    },
    page_get_next_page_id: (view, page_offset) => exp.page_get_next_page_id(getAbsOffset(view, page_offset)),
    page_set_next_page_id: (view, page_offset, next_page_id) => {
      exp.page_set_next_page_id(getAbsOffset(view, page_offset), next_page_id);
    },
    page_get_free_bytes: (view, page_offset) => exp.page_get_free_bytes(getAbsOffset(view, page_offset)),
    page_set_free_bytes: (view, page_offset, free_bytes) => {
      exp.page_set_free_bytes(getAbsOffset(view, page_offset), free_bytes);
    },
    page_get_checksum: (view, page_offset) => exp.page_get_checksum(getAbsOffset(view, page_offset)),
    page_set_checksum: (view, page_offset, checksum) => {
      exp.page_set_checksum(getAbsOffset(view, page_offset), checksum);
    },
    page_get_cell_offset: (view, page_offset, slot_idx) => exp.page_get_cell_offset(getAbsOffset(view, page_offset), slot_idx),
    page_set_cell_offset: (view, page_offset, slot_idx, cell_offset) => {
      exp.page_set_cell_offset(getAbsOffset(view, page_offset), slot_idx, cell_offset);
    },
    page_get_contiguous_free_space: (view, page_offset) => exp.page_get_contiguous_free_space(getAbsOffset(view, page_offset)),
    page_get_total_free_space: (view, page_offset) => exp.page_get_total_free_space(getAbsOffset(view, page_offset)),

    page_compact: (view, page_offset, scratchpad_offset = 0, replacement) => {
      if (replacement || view.buffer !== memory.buffer) {
        js_page_compact(view, page_offset, scratchpad_offset, replacement);
      } else {
        exp.page_compact_raw(getAbsOffset(view, page_offset), scratchpad_offset);
      }
    },

    page_get_row_length: (view, row_offset) => exp.page_get_row_length(getAbsOffset(view, row_offset)),

    page_insert_row: (view, page_offset, row_bytes, scratchpad_offset = 0) => {
      if (view.buffer === memory.buffer && exp.page_insert_row_raw) {
        if (row_bytes.byteLength > BYTECODE_SIZE) {
          return -1;
        }
        const memU8 = getMemU8();
        memU8.set(row_bytes, BYTECODE_OFFSET);
        return exp.page_insert_row_raw(
          getAbsOffset(view, page_offset),
          BYTECODE_OFFSET,
          row_bytes.byteLength,
          scratchpad_offset,
        );
      }
      return js_page_insert_row(view, page_offset, row_bytes, scratchpad_offset);
    },

    page_delete_row: (view, page_offset, cell_idx) => {
      exp.page_delete_row(getAbsOffset(view, page_offset), cell_idx);
    },

    page_update_row: (view, page_offset, cell_idx, new_row_bytes, scratchpad_offset = 0) => {
      return js_page_update_row(view, page_offset, cell_idx, new_row_bytes, scratchpad_offset);
    },

    page_insert_index_leaf_cell: (view, page_offset, key_type, key_value, rowid, scratchpad_offset = 0) => {
      if (view.buffer === memory.buffer && exp.page_insert_index_cell_raw) {
        const absPageOff = getAbsOffset(view, page_offset);
        if (key_type === DataType.NULL || key_value === null || key_value === undefined) {
          return exp.page_insert_index_cell_raw(absPageOff, DataType.NULL, 0n, 0.0, 0, 0, rowid, scratchpad_offset);
        }
        if (key_type === DataType.INT32) {
          return exp.page_insert_index_cell_raw(absPageOff, DataType.INT32, 0n, Number(key_value) | 0, 0, 4, rowid, scratchpad_offset);
        }
        if (key_type === DataType.INT64) {
          const bi = BigInt(key_value);
          return exp.page_insert_index_cell_raw(absPageOff, DataType.INT64, bi, Number(bi), 0, 8, rowid, scratchpad_offset);
        }
        if (key_type === DataType.FLOAT64) {
          return exp.page_insert_index_cell_raw(absPageOff, DataType.FLOAT64, 0n, Number(key_value), 0, 8, rowid, scratchpad_offset);
        }
        const memU8 = getMemU8();
        let keyLen = 0;
        if (key_type === DataType.UUID) {
          UuidCodec.encode(String(key_value), memU8, BYTECODE_OFFSET);
          keyLen = 16;
        } else if (key_type === DataType.ULID) {
          UlidCodec.encode(String(key_value), memU8, BYTECODE_OFFSET);
          keyLen = 16;
        } else if (key_type === DataType.TEXT) {
          const str = String(key_value);
          const encRes = wasmTextEncoder.encodeInto(str, memU8.subarray(BYTECODE_OFFSET, BYTECODE_OFFSET + BYTECODE_SIZE));
          if (encRes.read < str.length) {
            return -1;
          }
          keyLen = encRes.written;
        } else {
          const bytes = key_value instanceof Uint8Array ? key_value : new Uint8Array(key_value);
          if (bytes.byteLength > BYTECODE_SIZE) {
            return -1;
          }
          keyLen = bytes.byteLength;
          memU8.set(bytes, BYTECODE_OFFSET);
        }
        return exp.page_insert_index_cell_raw(absPageOff, key_type, 0n, 0.0, BYTECODE_OFFSET, keyLen, rowid, scratchpad_offset);
      }
      return js_page_insert_index_leaf_cell(view, page_offset, key_type, key_value, rowid, scratchpad_offset);
    },

    page_delete_index_leaf_cell: (view, page_offset, slot_idx) => {
      if (view.buffer === memory.buffer && exp.page_delete_index_leaf_cell) {
        exp.page_delete_index_leaf_cell(getAbsOffset(view, page_offset), slot_idx);
      } else {
        js_page_delete_index_leaf_cell(view, page_offset, slot_idx);
      }
    },

    page_binary_search_index_leaf: (view, page_offset, target_type, target_value, target_row_id) => {
      if (view.buffer === memory.buffer && exp.page_binary_search_index_raw) {
        const absPageOff = getAbsOffset(view, page_offset);
        const hasRowid = target_row_id !== undefined ? 1 : 0;
        const rowidVal = target_row_id !== undefined ? target_row_id : 0n;
        let effType = target_type;
        if (target_type === DataType.NULL || target_value === null || target_value === undefined) {
          effType = DataType.NULL;
        }
        if (
          effType === DataType.NULL ||
          effType === DataType.INT32 ||
          effType === DataType.INT64 ||
          effType === DataType.FLOAT64
        ) {
          const numF64 = effType === DataType.NULL ? 0.0 : Number(target_value);
          const res = exp.page_binary_search_index_raw(absPageOff, effType, numF64, 0, 0, hasRowid, rowidVal);
          return res >= 0 ? { found: true, slot_idx: res } : { found: false, slot_idx: -res - 1 };
        }
        const memU8 = getMemU8();
        let keyLen = 0;
        if (effType === DataType.UUID) {
          UuidCodec.encode(String(target_value), memU8, BYTECODE_OFFSET);
          keyLen = 16;
        } else if (effType === DataType.ULID) {
          UlidCodec.encode(String(target_value), memU8, BYTECODE_OFFSET);
          keyLen = 16;
        } else if (effType === DataType.TEXT) {
          const str = String(target_value);
          const encRes = wasmTextEncoder.encodeInto(str, memU8.subarray(BYTECODE_OFFSET, BYTECODE_OFFSET + BYTECODE_SIZE));
          if (encRes.read < str.length) {
            return js_page_binary_search_index_leaf(view, page_offset, target_type, target_value, target_row_id);
          }
          keyLen = encRes.written;
        } else {
          const bytes = target_value instanceof Uint8Array ? target_value : new Uint8Array(target_value);
          if (bytes.byteLength > BYTECODE_SIZE) {
            return js_page_binary_search_index_leaf(view, page_offset, target_type, target_value, target_row_id);
          }
          keyLen = bytes.byteLength;
          memU8.set(bytes, BYTECODE_OFFSET);
        }
        const res = exp.page_binary_search_index_raw(absPageOff, effType, 0.0, BYTECODE_OFFSET, keyLen, hasRowid, rowidVal);
        return res >= 0 ? { found: true, slot_idx: res } : { found: false, slot_idx: -res - 1 };
      }
      return js_page_binary_search_index_leaf(view, page_offset, target_type, target_value, target_row_id);
    },

    // Page Table
    page_table_hash: (page_id, mask) => exp.page_table_hash(page_id, mask),
    page_table_get: (view, base_offset, bucket_count, page_id) =>
      exp.page_table_get(getAbsOffset(view, base_offset), bucket_count, page_id),
    page_table_set: (view, base_offset, bucket_count, page_id, slot_idx) => {
      const res = exp.page_table_set(getAbsOffset(view, base_offset), bucket_count, page_id, slot_idx);
      if (res < 0) {
        throw new Error(`BufferPool page table full: cannot insert page ${page_id}`);
      }
    },
    page_table_delete: (view, base_offset, bucket_count, page_id) =>
      exp.page_table_delete(getAbsOffset(view, base_offset), bucket_count, page_id) !== 0,

    // Buffer Pool
    buf_pool_get_slot_offset: (slot_idx) => exp.buf_pool_get_slot_offset(slot_idx),
    buf_pool_read_slot_to_page: (view, slot_to_page_offset, slot_idx) =>
      exp.buf_pool_read_slot_to_page(getAbsOffset(view, slot_to_page_offset), slot_idx),
    buf_pool_write_slot_to_page: (view, slot_to_page_offset, slot_idx, page_id) => {
      exp.buf_pool_write_slot_to_page(getAbsOffset(view, slot_to_page_offset), slot_idx, page_id);
    },
    buf_pool_get_resident_slot: (view, page_to_slot_offset, page_to_slot_buckets, page_id) =>
      exp.buf_pool_get_resident_slot(getAbsOffset(view, page_to_slot_offset), page_to_slot_buckets, page_id),
    buf_pool_assign_slot: (view, slot_to_page_offset, page_to_slot_offset, page_to_slot_buckets, slot_idx, page_id) => {
      exp.buf_pool_assign_slot(
        getAbsOffset(view, slot_to_page_offset),
        getAbsOffset(view, page_to_slot_offset),
        page_to_slot_buckets,
        slot_idx,
        page_id,
      );
    },
    buf_pool_unassign_slot: (view, slot_to_page_offset, page_to_slot_offset, page_to_slot_buckets, slot_idx) => {
      exp.buf_pool_unassign_slot(
        getAbsOffset(view, slot_to_page_offset),
        getAbsOffset(view, page_to_slot_offset),
        page_to_slot_buckets,
        slot_idx,
      );
    },
    buf_pool_mark_dirty: (view, dirty_mask_offset, slot_idx) => {
      exp.buf_pool_mark_dirty(getAbsOffset(view as any, dirty_mask_offset), slot_idx);
    },
    buf_pool_clear_dirty: (view, dirty_mask_offset, slot_idx) => {
      exp.buf_pool_clear_dirty(getAbsOffset(view as any, dirty_mask_offset), slot_idx);
    },
    buf_pool_is_dirty: (view, dirty_mask_offset, slot_idx) =>
      exp.buf_pool_is_dirty(getAbsOffset(view as any, dirty_mask_offset), slot_idx) !== 0,
    buf_pool_pin_slot: (pin_counts, slot_idx) => {
      js_buf_pool_pin_slot(pin_counts, slot_idx);
    },
    buf_pool_unpin_slot: (pin_counts, slot_idx) => {
      js_buf_pool_unpin_slot(pin_counts, slot_idx);
    },
    buf_pool_is_pinned: (pin_counts, slot_idx) => js_buf_pool_is_pinned(pin_counts, slot_idx),
    buf_pool_find_victim: (buffer, ref_bits, pin_counts, slot_to_page_offset, slot_count, current_clock_hand) =>
      js_buf_pool_find_victim(buffer, ref_bits, pin_counts, slot_to_page_offset, slot_count, current_clock_hand),
    buf_pool_select_eviction_victim: (buffer, ref_bits, pin_counts, slot_to_page_offset, dirty_mask_offset, slot_count, current_clock_hand, page_id) =>
      js_buf_pool_select_eviction_victim(buffer, ref_bits, pin_counts, slot_to_page_offset, dirty_mask_offset, slot_count, current_clock_hand, page_id),

    // Catalog Operations
    catalog_init_page1: (view) => {
      exp.catalog_init_page1(getAbsOffset(view));
    },
    catalog_read_page1_header: (view, verify_checksum) =>
      js_catalog_read_page1_header(view, verify_checksum),
    catalog_get_total_pages: (view) => exp.catalog_get_total_pages(getAbsOffset(view)),
    catalog_set_total_pages: (view, count) => {
      exp.catalog_set_total_pages(getAbsOffset(view), count);
    },
    catalog_get_free_page_head: (view) => exp.catalog_get_free_page_head(getAbsOffset(view)),
    catalog_set_free_page_head: (view, page_id) => {
      exp.catalog_set_free_page_head(getAbsOffset(view), page_id);
    },
    catalog_get_schema_version: (view) => exp.catalog_get_schema_version(getAbsOffset(view)),
    catalog_increment_schema_version: (view) => exp.catalog_increment_schema_version(getAbsOffset(view)),
    catalog_get_change_counter: (view) => exp.catalog_get_change_counter(getAbsOffset(view)),
    catalog_increment_change_counter: (view) => exp.catalog_increment_change_counter(getAbsOffset(view)),
    catalog_update_page1_checksum: (view) => exp.catalog_update_page1_checksum(getAbsOffset(view)),

    // Helpers & VM
    sql_like_match: (str, pattern) => host_sql_like_match(str, pattern),
    fnv1a_32: (values) => host_fnv1a_32(values),
    compare_sorter_keys: host_compare_sorter_keys,
    vm_step: (ctx, view, bytecode) => {
      return executeVmStepWithRunner(
        ctx,
        view,
        bytecode,
        (_activeView, ctxOff, codeOff, codeLen, arenaBase) =>
          exp.vm_step_raw(ctxOff, codeOff, codeLen, arenaBase),
        memory.buffer,
      );
    },
  };
}

function toWasmBufferSource(bytes: Uint8Array | ArrayBuffer): BufferSource {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    u8.buffer instanceof SharedArrayBuffer
  ) {
    return u8.slice() as unknown as BufferSource;
  }
  return u8 as unknown as BufferSource;
}

/**
 * Synchronously instantiates the WebAssembly core from pre-loaded `.wasm` bytes.
 * Does NOT import `embedded_wasm.ts`.
 */
export function instantiateWasmCore(
  memory: WebAssembly.Memory,
  bytes: Uint8Array | ArrayBuffer,
): WasmCoreExports {
  const wasmModule = new WebAssembly.Module(toWasmBufferSource(bytes));
  const instance = new WebAssembly.Instance(wasmModule, {
    env: { memory },
  });
  return wrapWasmInstance(instance, memory);
}

/**
 * Asynchronously instantiates the WebAssembly core from `.wasm` bytes.
 * Recommended in browsers to avoid main-thread compilation limits (>4 KB sync cap).
 */
export async function instantiateWasmCoreAsync(
  memory: WebAssembly.Memory,
  bytes: Uint8Array | ArrayBuffer,
): Promise<WasmCoreExports> {
  const { instance } = await WebAssembly.instantiate(
    toWasmBufferSource(bytes),
    { env: { memory } },
  );
  return wrapWasmInstance(instance, memory);
}

/**
 * Streams and instantiates the WebAssembly core from a URL or Fetch `Response`.
 * Falls back to `arrayBuffer()` + `WebAssembly.instantiate()` if streaming is
 * unavailable or the server sends a non-`application/wasm` MIME type.
 */
export async function instantiateWasmCoreStreaming(
  memory: WebAssembly.Memory,
  source: string | URL | Response | Promise<Response>,
): Promise<WasmCoreExports> {
  const responsePromise =
    typeof source === "string" || source instanceof URL
      ? fetch(source)
      : Promise.resolve(source);

  const response = await responsePromise;
  if (!response.ok) {
    throw new Error(
      `WebDB: Failed to fetch WebAssembly binary (${response.status} ${response.statusText})`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (
    typeof WebAssembly.instantiateStreaming === "function" &&
    (!contentType || contentType.includes("application/wasm"))
  ) {
    try {
      const { instance } = await WebAssembly.instantiateStreaming(
        response.clone(),
        { env: { memory } },
      );
      void response.body?.cancel().catch(() => {});
      return wrapWasmInstance(instance, memory);
    } catch {
      // Fallback when server omits `Content-Type: application/wasm` or streaming fails
    }
  }

  const bytes = await response.arrayBuffer();
  return instantiateWasmCoreAsync(memory, bytes);
}
