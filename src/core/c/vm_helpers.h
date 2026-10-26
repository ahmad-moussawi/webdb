#ifndef WEBDB_VM_HELPERS_H
#define WEBDB_VM_HELPERS_H

#include "webdb_types.h"

typedef struct {
  int32_t result;
  int32_t is_unknown;
} Compare3VLResult;

WEBDB_EXPORT int32_t to_lower_char(int32_t c);
WEBDB_EXPORT uint32_t fnv1a_32_bytes(uint8_t * data, uint32_t len);
WEBDB_EXPORT int32_t sql_like_match_raw(const char * str, uint32_t str_len, const char * pattern, uint32_t pat_len);
WEBDB_EXPORT Compare3VLResult compare_3vl_int64(int64_t a, int32_t a_null, int64_t b, int32_t b_null);
WEBDB_EXPORT Compare3VLResult compare_3vl_float64(double a, int32_t a_null, double b, int32_t b_null);
WEBDB_EXPORT Compare3VLResult compare_3vl_bytes(uint8_t * a, uint32_t a_len, int32_t a_null, uint8_t * b, uint32_t b_len, int32_t b_null);

#endif // WEBDB_VM_HELPERS_H
