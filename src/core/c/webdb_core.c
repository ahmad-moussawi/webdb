/**
 * WebDB C Core Engine - Master Compilation Unity Unit
 *
 * Compiles all core modules into a single compilation unit for
 * optimal inlining, link-time optimization (LTO), and minimum WASM binary size.
 */

#include "webdb_types.h"
#include "codecs.h"
#include "page_table.h"
#include "buffer_pool.h"
#include "page.h"
#include "catalog.h"
#include "vm_helpers.h"
#include "vm.h"

// Include source files directly for single-unit compilation
#include "codecs.c"
#include "page_table.c"
#include "buffer_pool.c"
#include "page.c"
#include "catalog.c"
#include "vm_helpers.c"
#include "vm.c"

// Freestanding library symbol definitions for LLVM loop idiom lowering
__attribute__((no_builtin("strlen"), visibility("default")))
size_t strlen(const char *s) {
  size_t len = 0;
  while (s[len] != '\0') len++;
  return len;
}

__attribute__((no_builtin("memcmp"), visibility("default")))
int memcmp(const void *s1, const void *s2, size_t n) {
  const uint8_t *p1 = (const uint8_t *)s1;
  const uint8_t *p2 = (const uint8_t *)s2;
  for (size_t i = 0; i < n; i++) {
    if (p1[i] != p2[i]) {
      return (int)p1[i] - (int)p2[i];
    }
  }
  return 0;
}

// Version query export
WEBDB_EXPORT uint32_t webdb_core_version(void) {
  return CURRENT_ENGINE_VERSION;
}
