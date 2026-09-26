/**
 * Shared C Runtime & Memory Helpers for WebAssembly Memory and Direct Buffers
 *
 * Provides drop-in C-standard library functions (memcpy, memset, memcmp)
 * and pointer-dereferencing primitives (read_u32, write_u32, get_bit, set_bit, etc.)
 * matching C99 / wasm32-nostdlib semantics.
 */

// ============================================================================
// Standard C Memory Functions (<string.h>)
// ============================================================================

/**
 * C: void *memcpy(void *dest, const void *src, size_t n);
 * Copies n bytes from memory area src to memory area dest.
 */
export function memcpy(
  dest: Uint8Array,
  dest_offset: number,
  src: Uint8Array,
  src_offset: number,
  n: number,
): void {
  dest.set(src.subarray(src_offset, src_offset + n), dest_offset);
}

/**
 * C: void *memset(void *s, int c, size_t n);
 * Fills the first n bytes of the memory area pointed to by s with the constant byte c.
 */
export function memset(
  dest: Uint8Array,
  dest_offset: number,
  c: number,
  n: number,
): void {
  dest.fill(c & 0xff, dest_offset, dest_offset + n);
}

/**
 * C: int memcmp(const void *s1, const void *s2, size_t n);
 * Compares the first n bytes of the memory areas s1 and s2.
 * Returns <0, 0, or >0.
 */
export function memcmp(
  s1: Uint8Array,
  s1_offset: number,
  s2: Uint8Array,
  s2_offset: number,
  n: number,
): number {
  for (let i = 0; i < n; i++) {
    const diff = s1[s1_offset + i] - s2[s2_offset + i];
    if (diff !== 0) return diff;
  }
  return 0;
}

// ============================================================================
// Direct Pointer Memory Access Primitives (Little-Endian, zero heap allocation)
// Matching C: *(uint32_t*)(ptr), etc.
// ============================================================================

export function read_u8(view: DataView | Uint8Array, offset: number): number {
  return view instanceof Uint8Array ? view[offset] : view.getUint8(offset);
}

export function write_u8(
  view: DataView | Uint8Array,
  offset: number,
  val: number,
): void {
  if (view instanceof Uint8Array) {
    view[offset] = val & 0xff;
  } else {
    view.setUint8(offset, val & 0xff);
  }
}

export function read_u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

export function write_u16(view: DataView, offset: number, val: number): void {
  view.setUint16(offset, val & 0xffff, true);
}

export function read_u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export function write_u32(view: DataView, offset: number, val: number): void {
  view.setUint32(offset, val >>> 0, true);
}

export function read_i32(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

export function write_i32(view: DataView, offset: number, val: number): void {
  view.setInt32(offset, val | 0, true);
}

export function read_f64(view: DataView, offset: number): number {
  return view.getFloat64(offset, true);
}

export function write_f64(view: DataView, offset: number, val: number): void {
  view.setFloat64(offset, val, true);
}

export function read_u64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

export function write_u64(view: DataView, offset: number, val: bigint): void {
  view.setBigUint64(offset, val, true);
}

export function read_i64(view: DataView, offset: number): bigint {
  return view.getBigInt64(offset, true);
}

export function write_i64(view: DataView, offset: number, val: bigint): void {
  view.setBigInt64(offset, val, true);
}

// ============================================================================
// Bitwise Bitmask Manipulation (C macros: GET_BIT, SET_BIT, CLEAR_BIT)
// ============================================================================

export function get_bit(mask: Uint8Array, bit_idx: number): number {
  return (mask[bit_idx >> 3] & (1 << (bit_idx & 7))) !== 0 ? 1 : 0;
}

export function set_bit(mask: Uint8Array, bit_idx: number): void {
  mask[bit_idx >> 3] |= (1 << (bit_idx & 7));
}

export function clear_bit(mask: Uint8Array, bit_idx: number): void {
  mask[bit_idx >> 3] &= ~(1 << (bit_idx & 7));
}

// ============================================================================
// C Assertion Helper
// ============================================================================

export function c_assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}
