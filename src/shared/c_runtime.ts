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

const u8Cache = new WeakMap<ArrayBufferLike, Uint8Array>();
function getU8(target: Uint8Array | DataView): Uint8Array {
  if (target instanceof Uint8Array) return target;
  if (target.byteOffset === 0 && target.byteLength === target.buffer.byteLength) {
    let cached = u8Cache.get(target.buffer);
    if (!cached) {
      cached = new Uint8Array(target.buffer);
      u8Cache.set(target.buffer, cached);
    }
    return cached;
  }
  return new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
}

/**
 * C: void *memcpy(void *dest, const void *src, size_t n);
 * Copies n bytes from memory area src to memory area dest.
 */
export function memcpy(
  dest: Uint8Array | DataView,
  dest_offset: number,
  src: Uint8Array | DataView,
  src_offset: number,
  n: number,
): void {
  if (n <= 0) return;
  const d = getU8(dest);
  const s = getU8(src);
  if (d === s) {
    d.copyWithin(dest_offset, src_offset, src_offset + n);
  } else {
    for (let i = 0; i < n; i++) {
      d[dest_offset + i] = s[src_offset + i];
    }
  }
}

/**
 * C: void *memset(void *s, int c, size_t n);
 * Fills the first n bytes of the memory area pointed to by s with the constant byte c.
 */
export function memset(
  dest: Uint8Array | DataView,
  dest_offset: number,
  c: number,
  n: number,
): void {
  if (n <= 0) return;
  const d = getU8(dest);
  d.fill(c & 0xff, dest_offset, dest_offset + n);
}

/**
 * C: int memcmp(const void *s1, const void *s2, size_t n);
 * Compares the first n bytes of the memory areas s1 and s2.
 * Returns <0, 0, or >0.
 */
export function memcmp(
  s1: Uint8Array | DataView,
  s1_offset: number,
  s2: Uint8Array | DataView,
  s2_offset: number,
  n: number,
): number {
  const b1 = getU8(s1);
  const b2 = getU8(s2);
  for (let i = 0; i < n; i++) {
    const diff = b1[s1_offset + i] - b2[s2_offset + i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * C: size_t strlen(const char *s);
 * Returns length of null-terminated string or JS string length.
 */
export function strlen(s: string): number {
  return s.length;
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

export function i64_to_f64(val: bigint): number {
  return Number(val);
}

export function i64_to_i32(val: bigint): number {
  return Number(val) | 0;
}

export function f64_to_i64(val: number): bigint {
  return BigInt(Math.trunc(val));
}

export function f64_to_i32(val: number): number {
  return Math.trunc(val) | 0;
}

// ============================================================================
// Bitwise Bitmask Manipulation (C macros: GET_BIT, SET_BIT, CLEAR_BIT)
// ============================================================================

export function get_bit(mask: Uint8Array, offset_or_bit: number, bit_idx?: number): number {
  if (bit_idx !== undefined) {
    return (mask[offset_or_bit + (bit_idx >> 3)] & (1 << (bit_idx & 7))) !== 0 ? 1 : 0;
  }
  return (mask[offset_or_bit >> 3] & (1 << (offset_or_bit & 7))) !== 0 ? 1 : 0;
}

export function set_bit(mask: Uint8Array, offset_or_bit: number, bit_idx?: number): void {
  if (bit_idx !== undefined) {
    mask[offset_or_bit + (bit_idx >> 3)] |= (1 << (bit_idx & 7));
  } else {
    mask[offset_or_bit >> 3] |= (1 << (offset_or_bit & 7));
  }
}

export function clear_bit(mask: Uint8Array, offset_or_bit: number, bit_idx?: number): void {
  if (bit_idx !== undefined) {
    mask[offset_or_bit + (bit_idx >> 3)] &= ~(1 << (bit_idx & 7));
  } else {
    mask[offset_or_bit >> 3] &= ~(1 << (offset_or_bit & 7));
  }
}

// ============================================================================
// C Assertion Helper
// ============================================================================

export function c_assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}
