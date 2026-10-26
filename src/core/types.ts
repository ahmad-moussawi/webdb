/**
 * Primitive C-compatible type aliases for the WebDB Core Engine.
 * Used by the TypeScript-to-C Transpiler to emit exact C native types.
 */

export type u8 = number;
export type u16 = number;
export type u32 = number;
export type i8 = number;
export type i16 = number;
export type i32 = number;
export type u64 = bigint;
export type i64 = bigint;
export type f64 = number;
export type byte_ptr = number;
export type c_bool = boolean | number;
export type const_u8_ptr = Uint8Array | number;
export type u8_ptr = Uint8Array | number;
export type const_char_ptr = string | number;
export type char_ptr = string | number;

/**
 * Compile-time intrinsic helper.
 * In TypeScript / Vitest execution, returns jsFallback.
 * In C transpilation, the transpiler emits cCode verbatim instead of calling this function.
 */
export function c_inline<T>(cCode: string, jsFallback: T): T {
  return jsFallback;
}
