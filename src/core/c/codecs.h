/**
 * WebDB C Core Engine - Native 128-bit Identity Types: UUID & ULID Codecs
 */

#ifndef WEBDB_CODECS_H
#define WEBDB_CODECS_H

#include "webdb_types.h"

// UUID
WEBDB_EXPORT int uuid_encode(const char *uuid_str, uint8_t *target, uint32_t offset);
WEBDB_EXPORT void uuid_decode(const uint8_t *source, uint32_t offset, char *out_str);

// ULID
WEBDB_EXPORT int ulid_encode(const char *ulid_str, uint8_t *target, uint32_t offset);
WEBDB_EXPORT void ulid_decode(const uint8_t *source, uint32_t offset, char *out_str);

#endif /* WEBDB_CODECS_H */
