/**
 * Native 128-bit Identity Types: UUID & ULID Codecs
 * Transcodes between canonical string representations and 16-byte raw binary slices.
 */

import { u32, i32, u64 } from "../types.ts";
import { strlen } from "../../shared/c_runtime.ts";

const text_decoder = new TextDecoder();

export const HEX_CHARS = "0123456789abcdef";
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * @export_c
 */
function hex_val(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 97 + 10;
  if (c >= 65 && c <= 70) return c - 65 + 10;
  return -1;
}

/**
 * @export_c
 */
function crockford_decode(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 122) c = c - 32;

  switch (c) {
    case 65: return 10;
    case 66: return 11;
    case 67: return 12;
    case 68: return 13;
    case 69: return 14;
    case 70: return 15;
    case 71: return 16;
    case 72: return 17;
    case 74: return 18;
    case 75: return 19;
    case 77: return 20;
    case 78: return 21;
    case 80: return 22;
    case 81: return 23;
    case 82: return 24;
    case 83: return 25;
    case 84: return 26;
    case 86: return 27;
    case 87: return 28;
    case 88: return 29;
    case 89: return 30;
    case 90: return 31;
    case 73:
    case 76: return 1; // Crockford aliases
    case 79: return 0;
    default: return -1;
  }
}

// ==========================================
// 1. UUID Transcoder (36-char Hex <-> 16 Bytes)
// ==========================================

/**
 * @export_c
 */
export function uuid_encode(
  uuid_str: string,
  target: Uint8Array,
  offset: u32,
): i32 {
  let clean_idx = 0;
  let hi = -1;

  for (let i = 0; i < strlen(uuid_str); i++) {
    const c = uuid_str.charCodeAt(i);
    if (c !== 45) {
      if (clean_idx >= 32) return -1;
      const val = hex_val(c);
      if (val < 0) return -1;
      if (clean_idx % 2 === 0) {
        hi = val;
      } else {
        target[offset + (clean_idx >> 1)] = (hi << 4) | val;
      }
      clean_idx++;
    }
  }

  if (clean_idx !== 32) return -1;
  return 0;
}

/**
 * @export_c
 */
export function uuid_decode(
  source: Uint8Array,
  offset: u32,
  out_str: any,
): void {
  let out_idx = 0;
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      out_str[out_idx++] = 45; // '-'
    }
    const b = source[offset + i];
    out_str[out_idx++] = HEX_CHARS.charCodeAt((b >> 4) & 0x0f);
    out_str[out_idx++] = HEX_CHARS.charCodeAt(b & 0x0f);
  }
  out_str[out_idx] = 0;
}

export class UuidCodec {
  /** Packs a 36-char hyphenated UUID string into 16 raw binary bytes */
  static encode(
    uuid_str: string,
    target: Uint8Array,
    offset: number = 0,
  ): void {
    const err = uuid_encode(uuid_str, target, offset);
    if (err !== 0) {
      throw new Error(
        `Invalid UUID format: "${uuid_str}" (must be 36 characters with hyphens)`,
      );
    }
  }

  /** Unpacks 16 raw bytes into canonical 36-char hyphenated UUID string */
  static decode(source: Uint8Array, offset: number = 0): string {
    const buf = new Uint8Array(37);
    uuid_decode(source, offset, buf);
    return text_decoder.decode(buf.subarray(0, 36));
  }
}

// ==========================================
// 2. ULID Transcoder (26-char Crockford Base32 <-> 16 Bytes)
// ==========================================

/**
 * @export_c
 */
export function ulid_encode(
  ulid_str: string,
  target: Uint8Array,
  offset: u32,
): i32 {
  if (strlen(ulid_str) !== 26) return -1;

  let time: u64 = 0n;
  for (let i = 0; i < 10; i++) {
    const v = crockford_decode(ulid_str.charCodeAt(i));
    if (v < 0) return -1;
    time = (time << 5n) | BigInt(v);
  }

  target[offset + 0] = Number((time >> 40n) & 0xffn);
  target[offset + 1] = Number((time >> 32n) & 0xffn);
  target[offset + 2] = Number((time >> 24n) & 0xffn);
  target[offset + 3] = Number((time >> 16n) & 0xffn);
  target[offset + 4] = Number((time >> 8n) & 0xffn);
  target[offset + 5] = Number(time & 0xffn);

  let rand_hi: u64 = 0n;
  for (let i = 10; i < 18; i++) {
    const v = crockford_decode(ulid_str.charCodeAt(i));
    if (v < 0) return -1;
    rand_hi = (rand_hi << 5n) | BigInt(v);
  }

  let rand_lo: u64 = 0n;
  for (let i = 18; i < 26; i++) {
    const v = crockford_decode(ulid_str.charCodeAt(i));
    if (v < 0) return -1;
    rand_lo = (rand_lo << 5n) | BigInt(v);
  }

  for (let i = 0; i < 5; i++) {
    target[offset + 6 + i] = Number((rand_hi >> BigInt((4 - i) * 8)) & 0xffn);
    target[offset + 11 + i] = Number((rand_lo >> BigInt((4 - i) * 8)) & 0xffn);
  }

  return 0;
}

/**
 * @export_c
 */
export function ulid_decode(
  source: Uint8Array,
  offset: u32,
  out_str: any,
): void {
  let time: u64 = 0n;
  for (let i = 0; i < 6; i++) {
    time = (time << 8n) | BigInt(source[offset + i]);
  }

  for (let i = 9; i >= 0; i--) {
    out_str[i] = CROCKFORD_ALPHABET.charCodeAt(Number(time % 32n));
    time /= 32n;
  }

  let rand_hi: u64 = 0n;
  for (let i = 0; i < 5; i++) {
    rand_hi = (rand_hi << 8n) | BigInt(source[offset + 6 + i]);
  }

  let rand_lo: u64 = 0n;
  for (let i = 0; i < 5; i++) {
    rand_lo = (rand_lo << 8n) | BigInt(source[offset + 11 + i]);
  }

  for (let i = 25; i >= 18; i--) {
    out_str[i] = CROCKFORD_ALPHABET.charCodeAt(Number(rand_lo & 31n));
    rand_lo >>= 5n;
  }

  for (let i = 17; i >= 10; i--) {
    out_str[i] = CROCKFORD_ALPHABET.charCodeAt(Number(rand_hi & 31n));
    rand_hi >>= 5n;
  }

  out_str[26] = 0;
}

export class UlidCodec {
  /** Packs a 26-character Crockford Base32 string into 16 raw bytes */
  static encode(
    ulid_str: string,
    target: Uint8Array,
    offset: number = 0,
  ): void {
    const err = ulid_encode(ulid_str, target, offset);
    if (err !== 0) {
      throw new Error(
        `Invalid ULID length: "${ulid_str}" (must be 26 Crockford Base32 characters)`,
      );
    }
  }

  /** Unpacks 16 raw bytes into canonical 26-char Crockford Base32 string */
  static decode(source: Uint8Array, offset: number = 0): string {
    const buf = new Uint8Array(27);
    ulid_decode(source, offset, buf);
    return text_decoder.decode(buf.subarray(0, 26));
  }
}
