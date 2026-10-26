#ifndef WEBDB_CODECS_H
#define WEBDB_CODECS_H

#include "webdb_types.h"

WEBDB_EXPORT int32_t hex_val(int32_t c);
WEBDB_EXPORT int32_t crockford_decode(int32_t c);
WEBDB_EXPORT int32_t uuid_encode(const char * uuid_str, uint8_t * target, uint32_t offset);
WEBDB_EXPORT void uuid_decode(const uint8_t * source, uint32_t offset, char * out_str);
WEBDB_EXPORT int32_t ulid_encode(const char * ulid_str, uint8_t * target, uint32_t offset);
WEBDB_EXPORT void ulid_decode(const uint8_t * source, uint32_t offset, char * out_str);

#endif // WEBDB_CODECS_H
