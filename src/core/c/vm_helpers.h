/**
 * WebDB C Core Engine - Virtual Machine Helpers
 */

#ifndef WEBDB_VM_HELPERS_H
#define WEBDB_VM_HELPERS_H

#include "webdb_types.h"

// 32-bit FNV-1a hash over raw byte buffer
WEBDB_EXPORT uint32_t fnv1a_32_bytes(const uint8_t *data, uint32_t len);

// Standard SQL LIKE pattern matcher (% and _)
WEBDB_EXPORT int32_t sql_like_match_raw(const char *str, uint32_t str_len, const char *pattern, uint32_t pat_len);

// 3-Valued Logic Comparison Result
typedef struct {
  int32_t result;      // -1 (less), 0 (equal), 1 (greater)
  int32_t is_unknown;  // 1 if null, 0 otherwise
} Compare3VLResult;

WEBDB_EXPORT Compare3VLResult compare_3vl_int64(int64_t a, int32_t a_null, int64_t b, int32_t b_null);
WEBDB_EXPORT Compare3VLResult compare_3vl_float64(double a, int32_t a_null, double b, int32_t b_null);
WEBDB_EXPORT Compare3VLResult compare_3vl_bytes(const uint8_t *a, uint32_t a_len, int32_t a_null,
                                                const uint8_t *b, uint32_t b_len, int32_t b_null);

#endif /* WEBDB_VM_HELPERS_H */
