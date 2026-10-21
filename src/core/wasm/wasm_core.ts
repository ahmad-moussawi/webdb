/**
 * WebDB WebAssembly Core Adapter
 * Wraps compiled C WebAssembly exports with 1:1 API parity to the JS Core.
 */

import { getWebDbCoreWasmBytes } from "./embedded_wasm.ts";
import {
  PAGE_TYPE_LEAF_DATA,
} from "../../constants.ts";
import * as jsCore from "../js/index.ts";

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
  catalog_read_page1_header: typeof jsCore.catalog_read_page1_header;
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
  compare_sorter_keys: typeof jsCore.compare_sorter_keys;
  vm_step: typeof jsCore.vm_step;
}

export function createWasmCore(
  memory: WebAssembly.Memory,
  customBytes?: Uint8Array,
): WasmCoreExports {
  const bytes = customBytes ?? getWebDbCoreWasmBytes();
  const wasmModule = new WebAssembly.Module(bytes as unknown as BufferSource);
  const instance = new WebAssembly.Instance(wasmModule, {
    env: { memory },
  });

  const exp = instance.exports as Record<string, any>;

  const getAbsOffset = (view: DataView | Uint8Array, offset: number = 0) => {
    return view.byteOffset + offset;
  };

  const wasmExports: WasmCoreExports = {
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

    page_get_type: (view, page_offset) => {
      return exp.page_get_type(getAbsOffset(view, page_offset));
    },

    page_set_type: (view, page_offset, type) => {
      exp.page_set_type(getAbsOffset(view, page_offset), type);
    },

    page_get_cell_count: (view, page_offset) => {
      return exp.page_get_cell_count(getAbsOffset(view, page_offset));
    },

    page_set_cell_count: (view, page_offset, count) => {
      exp.page_set_cell_count(getAbsOffset(view, page_offset), count);
    },

    page_get_cell_content_offset: (view, page_offset) => {
      return exp.page_get_cell_content_offset(getAbsOffset(view, page_offset));
    },

    page_set_cell_content_offset: (view, page_offset, offset) => {
      exp.page_set_cell_content_offset(getAbsOffset(view, page_offset), offset);
    },

    page_get_next_page_id: (view, page_offset) => {
      return exp.page_get_next_page_id(getAbsOffset(view, page_offset));
    },

    page_set_next_page_id: (view, page_offset, next_page_id) => {
      exp.page_set_next_page_id(getAbsOffset(view, page_offset), next_page_id);
    },

    page_get_free_bytes: (view, page_offset) => {
      return exp.page_get_free_bytes(getAbsOffset(view, page_offset));
    },

    page_set_free_bytes: (view, page_offset, free_bytes) => {
      exp.page_set_free_bytes(getAbsOffset(view, page_offset), free_bytes);
    },

    page_get_checksum: (view, page_offset) => {
      return exp.page_get_checksum(getAbsOffset(view, page_offset));
    },

    page_set_checksum: (view, page_offset, checksum) => {
      exp.page_set_checksum(getAbsOffset(view, page_offset), checksum);
    },

    page_get_cell_offset: (view, page_offset, slot_idx) => {
      return exp.page_get_cell_offset(getAbsOffset(view, page_offset), slot_idx);
    },

    page_set_cell_offset: (view, page_offset, slot_idx, cell_offset) => {
      exp.page_set_cell_offset(getAbsOffset(view, page_offset), slot_idx, cell_offset);
    },

    page_get_contiguous_free_space: (view, page_offset) => {
      return exp.page_get_contiguous_free_space(getAbsOffset(view, page_offset));
    },

    page_get_total_free_space: (view, page_offset) => {
      return exp.page_get_total_free_space(getAbsOffset(view, page_offset));
    },

    page_compact: (view, page_offset, scratchpad_offset = 0, replacement) => {
      if (replacement) {
        // Fall back to JS core for replacement cell compaction edge-cases
        jsCore.page_compact(view, page_offset, scratchpad_offset, replacement);
      } else {
        exp.page_compact(getAbsOffset(view, page_offset), scratchpad_offset, -1, 0, 0);
      }
    },

    page_get_row_length: (view, row_offset) => {
      return exp.page_get_row_length(getAbsOffset(view, row_offset));
    },

    page_insert_row: (view, page_offset, row_bytes, scratchpad_offset = 0) => {
      // Direct call into JS or WASM
      return jsCore.page_insert_row(view, page_offset, row_bytes, scratchpad_offset);
    },

    page_delete_row: (view, page_offset, cell_idx) => {
      exp.page_delete_row(getAbsOffset(view, page_offset), cell_idx);
    },

    page_update_row: (view, page_offset, cell_idx, new_row_bytes, scratchpad_offset = 0) => {
      return jsCore.page_update_row(view, page_offset, cell_idx, new_row_bytes, scratchpad_offset);
    },

    // Page Table
    page_table_hash: (page_id, mask) => {
      return exp.page_table_hash(page_id, mask);
    },

    page_table_get: (view, base_offset, bucket_count, page_id) => {
      return exp.page_table_get(getAbsOffset(view, base_offset), bucket_count, page_id);
    },

    page_table_set: (view, base_offset, bucket_count, page_id, slot_idx) => {
      const res = exp.page_table_set(getAbsOffset(view, base_offset), bucket_count, page_id, slot_idx);
      if (res < 0) {
        throw new Error(`BufferPool page table full: cannot insert page ${page_id}`);
      }
    },

    page_table_delete: (view, base_offset, bucket_count, page_id) => {
      return exp.page_table_delete(getAbsOffset(view, base_offset), bucket_count, page_id) !== 0;
    },

    // Buffer Pool
    buf_pool_get_slot_offset: (slot_idx) => {
      return exp.buf_pool_get_slot_offset(slot_idx);
    },

    buf_pool_read_slot_to_page: (view, slot_to_page_offset, slot_idx) => {
      return exp.buf_pool_read_slot_to_page(getAbsOffset(view, slot_to_page_offset), slot_idx);
    },

    buf_pool_write_slot_to_page: (view, slot_to_page_offset, slot_idx, page_id) => {
      exp.buf_pool_write_slot_to_page(getAbsOffset(view, slot_to_page_offset), slot_idx, page_id);
    },

    buf_pool_get_resident_slot: (view, page_to_slot_offset, page_to_slot_buckets, page_id) => {
      return exp.buf_pool_get_resident_slot(getAbsOffset(view, page_to_slot_offset), page_to_slot_buckets, page_id);
    },

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

    buf_pool_is_dirty: (view, dirty_mask_offset, slot_idx) => {
      return exp.buf_pool_is_dirty(getAbsOffset(view as any, dirty_mask_offset), slot_idx) !== 0;
    },

    buf_pool_pin_slot: (pin_counts, slot_idx) => {
      jsCore.buf_pool_pin_slot(pin_counts, slot_idx);
    },

    buf_pool_unpin_slot: (pin_counts, slot_idx) => {
      jsCore.buf_pool_unpin_slot(pin_counts, slot_idx);
    },

    buf_pool_is_pinned: (pin_counts, slot_idx) => {
      return jsCore.buf_pool_is_pinned(pin_counts, slot_idx);
    },

    buf_pool_find_victim: (buffer, ref_bits, pin_counts, slot_to_page_offset, slot_count, current_clock_hand) => {
      return jsCore.buf_pool_find_victim(buffer, ref_bits, pin_counts, slot_to_page_offset, slot_count, current_clock_hand);
    },

    buf_pool_select_eviction_victim: (buffer, ref_bits, pin_counts, slot_to_page_offset, dirty_mask_offset, slot_count, current_clock_hand, page_id) => {
      return jsCore.buf_pool_select_eviction_victim(buffer, ref_bits, pin_counts, slot_to_page_offset, dirty_mask_offset, slot_count, current_clock_hand, page_id);
    },

    // Catalog Operations
    catalog_init_page1: (view) => {
      exp.catalog_init_page1(getAbsOffset(view));
    },

    catalog_read_page1_header: (view, verify_checksum) => {
      return jsCore.catalog_read_page1_header(view, verify_checksum);
    },

    catalog_get_total_pages: (view) => {
      return exp.catalog_get_total_pages(getAbsOffset(view));
    },

    catalog_set_total_pages: (view, count) => {
      exp.catalog_set_total_pages(getAbsOffset(view), count);
    },

    catalog_get_free_page_head: (view) => {
      return exp.catalog_get_free_page_head(getAbsOffset(view));
    },

    catalog_set_free_page_head: (view, page_id) => {
      exp.catalog_set_free_page_head(getAbsOffset(view), page_id);
    },

    catalog_get_schema_version: (view) => {
      return exp.catalog_get_schema_version(getAbsOffset(view));
    },

    catalog_increment_schema_version: (view) => {
      return exp.catalog_increment_schema_version(getAbsOffset(view));
    },

    catalog_get_change_counter: (view) => {
      return exp.catalog_get_change_counter(getAbsOffset(view));
    },

    catalog_increment_change_counter: (view) => {
      return exp.catalog_increment_change_counter(getAbsOffset(view));
    },

    catalog_update_page1_checksum: (view) => {
      return exp.catalog_update_page1_checksum(getAbsOffset(view));
    },

    // Helpers
    sql_like_match: (str, pattern) => {
      return jsCore.sql_like_match(str, pattern);
    },

    fnv1a_32: (values) => {
      return jsCore.fnv1a_32(values);
    },

    compare_sorter_keys: jsCore.compare_sorter_keys,
    vm_step: jsCore.vm_step,
  };

  return wasmExports;
}
