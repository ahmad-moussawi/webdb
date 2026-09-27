/**
 * Native 128-bit Identity Types: UUID & ULID Codecs
 * Transcodes between canonical string representations and 16-byte raw binary slices.
 */

// ==========================================
// 1. UUID Transcoder (36-char Hex <-> 16 Bytes)
// ==========================================
export class UuidCodec {
  /** Packs a 36-char hyphenated UUID string into 16 raw binary bytes */
  static encode(
    uuid_str: string,
    target: Uint8Array,
    offset: number = 0,
  ): void {
    const clean = uuid_str.replace(/-/g, "");
    if (clean.length !== 32) {
      throw new Error(
        `Invalid UUID format: "${uuid_str}" (must be 36 characters with hyphens)`,
      );
    }
    for (let i = 0; i < 16; i++) {
      target[offset + i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
  }

  /** Unpacks 16 raw bytes into canonical 36-char hyphenated UUID string */
  static decode(source: Uint8Array, offset: number = 0): string {
    let hex = "";
    for (let i = 0; i < 16; i++) {
      hex += source[offset + i].toString(16).padStart(2, "0");
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
}

// ==========================================
// 2. ULID Transcoder (26-char Crockford Base32 <-> 16 Bytes)
// ==========================================
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_DECODE = new Uint8Array(128);
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  CROCKFORD_DECODE[CROCKFORD_ALPHABET.charCodeAt(i)] = i;
}

export class UlidCodec {
  /** Packs a 26-character Crockford Base32 string into 16 raw bytes */
  static encode(
    ulid_str: string,
    target: Uint8Array,
    offset: number = 0,
  ): void {
    if (ulid_str.length !== 26) {
      throw new Error(
        `Invalid ULID length: "${ulid_str}" (must be 26 Crockford Base32 characters)`,
      );
    }
    const clean = ulid_str.toUpperCase();

    // 1. Parse 48-bit timestamp (first 10 characters = 50 bits; top 2 bits 0)
    let time = 0;
    for (let i = 0; i < 10; i++) {
      time = time * 32 + CROCKFORD_DECODE[clean.charCodeAt(i)];
    }
    target[offset + 0] = (time / 0x10000000000) & 0xff;
    target[offset + 1] = (time / 0x100000000) & 0xff;
    target[offset + 2] = (time / 0x1000000) & 0xff;
    target[offset + 3] = (time / 0x10000) & 0xff;
    target[offset + 4] = (time / 0x100) & 0xff;
    target[offset + 5] = time & 0xff;

    // 2. Parse 80-bit randomness (remaining 16 characters -> 10 bytes)
    let rand_hi = 0n;
    for (let i = 10; i < 18; i++) {
      rand_hi = (rand_hi << 5n) | BigInt(CROCKFORD_DECODE[clean.charCodeAt(i)]);
    }
    let rand_lo = 0n;
    for (let i = 18; i < 26; i++) {
      rand_lo = (rand_lo << 5n) | BigInt(CROCKFORD_DECODE[clean.charCodeAt(i)]);
    }
    for (let i = 0; i < 5; i++) {
      target[offset + 6 + i] = Number((rand_hi >> BigInt((4 - i) * 8)) & 0xffn);
      target[offset + 11 + i] = Number(
        (rand_lo >> BigInt((4 - i) * 8)) & 0xffn,
      );
    }
  }

  /** Unpacks 16 raw bytes into canonical 26-char Crockford Base32 string */
  static decode(source: Uint8Array, offset: number = 0): string {
    // 1. Extract 48-bit timestamp
    let time = 0;
    for (let i = 0; i < 6; i++) {
      time = time * 256 + source[offset + i];
    }
    let str = "";
    for (let i = 9; i >= 0; i--) {
      str = CROCKFORD_ALPHABET[time % 32] + str;
      time = Math.floor(time / 32);
    }

    // 2. Extract 80-bit randomness
    let rand_hi = 0n;
    for (let i = 0; i < 5; i++) {
      rand_hi = (rand_hi << 8n) | BigInt(source[offset + 6 + i]);
    }
    let rand_lo = 0n;
    for (let i = 0; i < 5; i++) {
      rand_lo = (rand_lo << 8n) | BigInt(source[offset + 11 + i]);
    }
    let rand_part = "";
    for (let i = 0; i < 8; i++) {
      rand_part = CROCKFORD_ALPHABET[Number(rand_lo & 31n)] + rand_part;
      rand_lo >>= 5n;
    }
    for (let i = 0; i < 8; i++) {
      rand_part = CROCKFORD_ALPHABET[Number(rand_hi & 31n)] + rand_part;
      rand_hi >>= 5n;
    }
    return str + rand_part;
  }
}
