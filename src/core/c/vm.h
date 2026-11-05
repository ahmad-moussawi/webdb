#ifndef WEBDB_VM_H
#define WEBDB_VM_H

#include "webdb_types.h"

WEBDB_EXPORT int32_t vm_step_raw(uint32_t ctx_off, uint32_t code_off, uint32_t code_len, uint32_t arena_base);

#endif // WEBDB_VM_H
