/**
 * WebDB Core Engine C / FFI Export Boundary
 *
 * Explicitly exposes each C Core function annotated with @export_c to the Host layer.
 * In Phase 1 (TypeScript Core), these are direct C-style functional exports.
 * In Phase 2 (C/Wasm Core), these correspond 1-to-1 to the compiled WebAssembly exports.
 */

// ============================================================================
// Page Operations (@export_c)
// ============================================================================
export {
  page_init,
  page_init_free,
  page_get_type,
  page_set_type,
  page_get_cell_count,
  page_set_cell_count,
  page_get_cell_content_offset,
  page_set_cell_content_offset,
  page_get_next_page_id,
  page_set_next_page_id,
  page_get_free_bytes,
  page_set_free_bytes,
  page_get_checksum,
  page_set_checksum,
  page_get_cell_offset,
  page_set_cell_offset,
  page_get_contiguous_free_space,
  page_get_total_free_space,
  page_compact,
  page_get_row_length,
  page_insert_row,
  page_delete_row,
  page_update_row,
  page_get_table_layout,
  page_serialize_row,
  page_deserialize_row,
  page_init_interior,
  page_get_right_child_page_id,
  page_set_right_child_page_id,
  page_insert_interior_cell,
  page_binary_search_interior,
  page_split_interior,
  page_init_index_leaf,
  page_compare_index_keys,
  page_insert_index_leaf_cell,
  page_binary_search_index_leaf,
  serialize_single_key,
  serialize_composite_key,
} from "./js/page.c.js";

// ============================================================================
// Page Table Operations (@export_c)
// ============================================================================
export {
  page_table_hash,
  page_table_get,
  page_table_set,
  page_table_delete,
} from "./js/page_table.c.js";

// ============================================================================
// Buffer Pool Operations (@export_c)
// ============================================================================
export {
  buf_pool_get_slot_offset,
  buf_pool_read_slot_to_page,
  buf_pool_write_slot_to_page,
  buf_pool_get_resident_slot,
  buf_pool_assign_slot,
  buf_pool_unassign_slot,
  buf_pool_mark_dirty,
  buf_pool_clear_dirty,
  buf_pool_is_dirty,
  buf_pool_pin_slot,
  buf_pool_unpin_slot,
  buf_pool_is_pinned,
  buf_pool_find_victim,
  buf_pool_select_eviction_victim,
} from "./js/buffer_pool.c.js";

// ============================================================================
// Virtual Machine Execution Loop (@export_c)
// ============================================================================
export {
  vm_step,
  sql_like_match,
  compare_sorter_keys,
  fnv1a_32,
} from "./js/vm.c.js";

// ============================================================================
// Schema Catalog Operations (@export_c)
// ============================================================================
export {
  catalog_init_page1,
  catalog_read_page1_header,
  catalog_get_total_pages,
  catalog_set_total_pages,
  catalog_get_free_page_head,
  catalog_set_free_page_head,
  catalog_get_schema_version,
  catalog_increment_schema_version,
  catalog_get_change_counter,
  catalog_increment_change_counter,
  catalog_update_page1_checksum,
  catalog_write_fixed_string,
  catalog_read_fixed_string,
  catalog_parse_data_type,
  catalog_read_table_descriptor,
  catalog_write_table_descriptor,
  catalog_find_table_by_name,
  catalog_find_table_slot,
  catalog_find_free_table_slot,
  catalog_list_table_descriptors,
  catalog_read_index_descriptor,
  catalog_write_index_descriptor,
  catalog_find_free_index_slot,
  catalog_find_index_by_name,
  catalog_list_table_indexes,
  catalog_delete_index_descriptor,
  catalog_delete_table_descriptor,
  catalog_init_page,
  catalog_read_page_header,
  catalog_write_page_header,
  catalog_write_column_meta,
  catalog_read_column_meta,
  catalog_map_column_location,
  catalog_create_table,
  catalog_load_table_meta,
  catalog_load_all_tables,
} from "./js/catalog.c.js";
