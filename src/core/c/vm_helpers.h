#ifndef WEBDB_VM_HELPERS_H
#define WEBDB_VM_HELPERS_H

#include "webdb_types.h"

typedef struct {
  int32_t result;
  int32_t is_unknown;
} Compare3VLResult;

WEBDB_EXPORT int32_t to_lower_char(int32_t c);
WEBDB_EXPORT int32_t to_upper_char(int32_t c);
WEBDB_EXPORT uint32_t vm_reg_off(uint32_t ctx_off, uint32_t reg_idx);
WEBDB_EXPORT uint32_t vm_cursor_off(uint32_t ctx_off, uint32_t cursor_idx);
WEBDB_EXPORT uint32_t vm_resolve_table_off(uint32_t ctx_off, uint32_t cursor_idx);
WEBDB_EXPORT uint32_t vm_phys_alloc(uint32_t ctx_off, uint32_t arena_base, uint32_t bytes);
WEBDB_EXPORT void vm_reg_set_null(uint32_t reg_off);
WEBDB_EXPORT void vm_reg_set_i32(uint32_t reg_off, int32_t val);
WEBDB_EXPORT void vm_reg_set_i64(uint32_t reg_off, int64_t val);
WEBDB_EXPORT void vm_reg_set_f64(uint32_t reg_off, double val);
WEBDB_EXPORT void vm_reg_set_slice(uint32_t reg_off, uint8_t col_type, uint32_t data_off, uint32_t data_len);
WEBDB_EXPORT void vm_reg_copy(uint32_t dst_reg_off, uint32_t src_reg_off);
WEBDB_EXPORT int32_t vm_reg_clone_to_arena(uint32_t ctx_off, uint32_t arena_base, uint32_t dst_slot_off, uint32_t src_reg_off);
WEBDB_EXPORT uint8_t vm_hex_char(uint32_t nibble);
WEBDB_EXPORT uint8_t vm_crockford_char(uint32_t idx);
WEBDB_EXPORT void vm_uuid_decode_view(uint32_t src_off, uint32_t dst_off);
WEBDB_EXPORT int32_t vm_uuid_encode_view(uint32_t src_off, uint32_t src_len, uint32_t dst_off);
WEBDB_EXPORT void vm_ulid_decode_view(uint32_t src_off, uint32_t dst_off);
WEBDB_EXPORT int32_t vm_ulid_encode_view(uint32_t src_off, uint32_t src_len, uint32_t dst_off);
WEBDB_EXPORT uint32_t vm_resolve_page_offset(uint32_t has_buffer_pool, uint32_t page_id);
WEBDB_EXPORT int32_t vm_row_is_null(uint32_t null_bitmap_offset, uint32_t col_idx);
WEBDB_EXPORT uint32_t vm_compute_fixed_col_offset(uint32_t null_bitmap_offset, uint32_t null_bitmap_bytes, uint32_t tbl_off, uint32_t target_col_idx);
WEBDB_EXPORT uint32_t vm_compute_var_col_idx(uint32_t tbl_off, uint32_t target_col_idx);
WEBDB_EXPORT int32_t vm_compare_bytes_raw(uint32_t off_a, uint32_t len_a, uint32_t off_b, uint32_t len_b);
WEBDB_EXPORT int32_t vm_compare_reg_3vl(uint32_t reg_a_off, uint32_t reg_b_off);
WEBDB_EXPORT int32_t vm_compare_index_cell(uint32_t ctx_off, uint32_t page_offset, uint16_t slot_idx, uint8_t key_type, uint32_t reg_off);
WEBDB_EXPORT int32_t vm_index_seek_leaf_eq(uint32_t ctx_off, uint32_t page_offset, uint8_t key_type, uint32_t reg_off);
WEBDB_EXPORT int32_t vm_index_seek_leaf_ge(uint32_t ctx_off, uint32_t page_offset, uint8_t key_type, uint32_t reg_off);
WEBDB_EXPORT int32_t sql_like_match_view(uint32_t str_off, uint32_t str_len, uint32_t pat_off, uint32_t pat_len);
WEBDB_EXPORT int32_t vm_str_contains_view(uint32_t str_off, uint32_t str_len, uint32_t sub_off, uint32_t sub_len);
WEBDB_EXPORT int32_t vm_str_starts_with_view(uint32_t str_off, uint32_t str_len, uint32_t pfx_off, uint32_t pfx_len);
WEBDB_EXPORT int32_t vm_str_ends_with_view(uint32_t str_off, uint32_t str_len, uint32_t sfx_off, uint32_t sfx_len);
WEBDB_EXPORT int32_t vm_str_levenshtein_view(uint32_t s1_off, uint32_t s1_len, uint32_t s2_off, uint32_t s2_len, uint32_t max_dist);
WEBDB_EXPORT int32_t vm_str_fuzzy_match_view(uint32_t str_off, uint32_t str_len, uint32_t pat_off, uint32_t pat_len, uint32_t max_dist, uint32_t allow_prefix);
WEBDB_EXPORT int32_t vm_utf8_char_count(uint32_t str_off, uint32_t byte_len);
WEBDB_EXPORT void vm_str_lower(uint32_t ctx_off, uint32_t arena_base, uint32_t src_reg_off, uint32_t dest_reg_off);
WEBDB_EXPORT void vm_str_upper(uint32_t ctx_off, uint32_t arena_base, uint32_t src_reg_off, uint32_t dest_reg_off);
WEBDB_EXPORT void vm_str_trim(uint32_t src_reg_off, uint32_t dest_reg_off);
WEBDB_EXPORT void vm_utf8_substr(uint32_t src_reg_off, uint32_t start_reg_off, uint32_t len_reg_off, uint32_t dest_reg_off);
WEBDB_EXPORT uint32_t vm_format_i64_to_scratch(uint32_t scratch_off, int64_t val);
WEBDB_EXPORT void vm_str_concat(uint32_t ctx_off, uint32_t arena_base, uint32_t start_reg, uint32_t num_regs, uint32_t dest_reg);
WEBDB_EXPORT double vm_math_abs(double x);
WEBDB_EXPORT double vm_math_floor(double x);
WEBDB_EXPORT double vm_math_ceil(double x);
WEBDB_EXPORT double vm_math_round(double x);
WEBDB_EXPORT int32_t vm_in_set_contains(uint32_t ctx_off, uint32_t set_idx, uint32_t reg_off);
WEBDB_EXPORT int32_t vm_emit_raw_row(uint32_t ctx_off, uint32_t row_src_off, uint32_t row_len, uint32_t instr_pc);
WEBDB_EXPORT uint8_t vm_infer_result_col_type(uint32_t ctx_off, uint32_t start_reg, uint32_t num_cols, uint32_t col_idx);
WEBDB_EXPORT int32_t vm_serialize_and_emit_result_row(uint32_t ctx_off, uint32_t start_reg, uint32_t num_cols, uint32_t instr_pc);
WEBDB_EXPORT int32_t vm_compare_sorter_key_slots(uint32_t keys_a_base, uint32_t keys_b_base, uint32_t ki_off);
WEBDB_EXPORT void vm_sorter_heap_sift_down(uint32_t ptrs_off, uint32_t index, uint32_t length, uint32_t ki_off);
WEBDB_EXPORT int32_t vm_sorter_open_raw(uint32_t ctx_off, uint32_t arena_base, uint32_t sorter_id, uint32_t key_info_idx);
WEBDB_EXPORT int32_t vm_sorter_insert_raw(uint32_t ctx_off, uint32_t arena_base, uint32_t sorter_id, uint32_t start_reg, uint32_t num_keys, uint32_t cursor_idx);
WEBDB_EXPORT int32_t vm_sorter_sort_raw(uint32_t ctx_off, uint32_t arena_base, uint32_t sorter_id);
WEBDB_EXPORT int32_t vm_sorter_next_raw(uint32_t ctx_off, uint32_t sorter_id, uint32_t jump_target, uint32_t instr_pc);
WEBDB_EXPORT uint32_t vm_hash_group_keys(uint32_t keys_base_off, uint32_t num_keys);
WEBDB_EXPORT int32_t vm_group_key_slots_match(uint32_t keys_a_base, uint32_t keys_b_base, uint32_t num_keys);
WEBDB_EXPORT uint32_t vm_alloc_agg_bucket(uint32_t ctx_off, uint32_t arena_base, uint32_t hash, uint32_t num_keys, uint32_t src_keys_base);
WEBDB_EXPORT int32_t vm_agg_init_raw(uint32_t ctx_off, uint32_t arena_base, uint32_t agg_id, uint32_t start_key_reg, uint32_t num_keys, uint32_t mode);
WEBDB_EXPORT int32_t vm_agg_step_raw(uint32_t ctx_off, uint32_t arena_base, uint32_t agg_id, uint32_t start_key_reg, uint32_t num_keys, uint32_t val_reg, uint32_t raw_func_id);
WEBDB_EXPORT int32_t vm_agg_next_raw(uint32_t ctx_off, uint32_t agg_id, uint32_t out_key_reg, uint32_t out_acc_reg, uint32_t jump_target);
WEBDB_EXPORT int32_t vm_agg_final_raw(uint32_t ctx_off, uint32_t sum_reg, uint32_t count_reg, uint32_t out_reg, uint32_t raw_func_id);
WEBDB_EXPORT uint32_t fnv1a_32_bytes(uint8_t * data, uint32_t len);
WEBDB_EXPORT int32_t sql_like_match_raw(const char * str, uint32_t str_len, const char * pattern, uint32_t pat_len);
WEBDB_EXPORT Compare3VLResult compare_3vl_int64(int64_t a, int32_t a_null, int64_t b, int32_t b_null);
WEBDB_EXPORT Compare3VLResult compare_3vl_float64(double a, int32_t a_null, double b, int32_t b_null);
WEBDB_EXPORT Compare3VLResult compare_3vl_bytes(uint8_t * a, uint32_t a_len, int32_t a_null, uint8_t * b, uint32_t b_len, int32_t b_null);

#endif // WEBDB_VM_HELPERS_H
