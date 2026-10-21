/**
 * WebDB C Core Engine - Native 128-bit Identity Types: UUID & ULID Codecs Implementation
 */

#include "codecs.h"

// ============================================================================
// 1. UUID Transcoder (36-char Hex <-> 16 Bytes)
// ============================================================================

static inline int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static const char HEX_CHARS[] = "0123456789abcdef";

int uuid_encode(const char *uuid_str, uint8_t *target, uint32_t offset) {
  if (!uuid_str || !target) return -1;

  char clean[32];
  int clean_idx = 0;

  for (int i = 0; uuid_str[i] != '\0' && clean_idx < 32; i++) {
    if (uuid_str[i] != '-') {
      clean[clean_idx++] = uuid_str[i];
    }
  }

  if (clean_idx != 32) return -1;

  for (int i = 0; i < 16; i++) {
    int hi = hex_val(clean[i * 2]);
    int lo = hex_val(clean[i * 2 + 1]);
    if (hi < 0 || lo < 0) return -1;
    target[offset + i] = (uint8_t)((hi << 4) | lo);
  }

  return 0;
}

void uuid_decode(const uint8_t *source, uint32_t offset, char *out_str) {
  if (!source || !out_str) return;

  int out_idx = 0;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) {
      out_str[out_idx++] = '-';
    }
    uint8_t b = source[offset + i];
    out_str[out_idx++] = HEX_CHARS[(b >> 4) & 0x0f];
    out_str[out_idx++] = HEX_CHARS[b & 0x0f];
  }
  out_str[out_idx] = '\0';
}

// ============================================================================
// 2. ULID Transcoder (26-char Crockford Base32 <-> 16 Bytes)
// ============================================================================

static const char CROCKFORD_ALPHABET[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static inline int crockford_decode(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');

  switch (c) {
    case 'A': return 10;
    case 'B': return 11;
    case 'C': return 12;
    case 'D': return 13;
    case 'E': return 14;
    case 'F': return 15;
    case 'G': return 16;
    case 'H': return 17;
    case 'J': return 18;
    case 'K': return 19;
    case 'M': return 20;
    case 'N': return 21;
    case 'P': return 22;
    case 'Q': return 23;
    case 'R': return 24;
    case 'S': return 25;
    case 'T': return 26;
    case 'V': return 27;
    case 'W': return 28;
    case 'X': return 29;
    case 'Y': return 30;
    case 'Z': return 31;
    case 'I':
    case 'L': return 1; // Crockford aliases
    case 'O': return 0;
    default: return -1;
  }
}

int ulid_encode(const char *ulid_str, uint8_t *target, uint32_t offset) {
  if (!ulid_str || !target) return -1;

  // Verify length == 26
  size_t len = strlen(ulid_str);
  if (len != 26) return -1;

  // 1. Parse 48-bit timestamp (first 10 chars = 50 bits; top 2 bits 0)
  uint64_t time = 0;
  for (int i = 0; i < 10; i++) {
    int v = crockford_decode(ulid_str[i]);
    if (v < 0) return -1;
    time = (time << 5) | (uint64_t)v;
  }

  target[offset + 0] = (uint8_t)((time >> 40) & 0xff);
  target[offset + 1] = (uint8_t)((time >> 32) & 0xff);
  target[offset + 2] = (uint8_t)((time >> 24) & 0xff);
  target[offset + 3] = (uint8_t)((time >> 16) & 0xff);
  target[offset + 4] = (uint8_t)((time >> 8) & 0xff);
  target[offset + 5] = (uint8_t)(time & 0xff);

  // 2. Parse 80-bit randomness (chars 10..25 -> 10 bytes)
  // chars 10..17 (8 chars * 5 bits = 40 bits)
  uint64_t rand_hi = 0;
  for (int i = 10; i < 18; i++) {
    int v = crockford_decode(ulid_str[i]);
    if (v < 0) return -1;
    rand_hi = (rand_hi << 5) | (uint64_t)v;
  }

  // chars 18..25 (8 chars * 5 bits = 40 bits)
  uint64_t rand_lo = 0;
  for (int i = 18; i < 26; i++) {
    int v = crockford_decode(ulid_str[i]);
    if (v < 0) return -1;
    rand_lo = (rand_lo << 5) | (uint64_t)v;
  }

  for (int i = 0; i < 5; i++) {
    target[offset + 6 + i] = (uint8_t)((rand_hi >> ((4 - i) * 8)) & 0xff);
    target[offset + 11 + i] = (uint8_t)((rand_lo >> ((4 - i) * 8)) & 0xff);
  }

  return 0;
}

void ulid_decode(const uint8_t *source, uint32_t offset, char *out_str) {
  if (!source || !out_str) return;

  // 1. Extract 48-bit timestamp
  uint64_t time = 0;
  for (int i = 0; i < 6; i++) {
    time = (time << 8) | source[offset + i];
  }

  char time_str[11];
  time_str[10] = '\0';
  for (int i = 9; i >= 0; i--) {
    time_str[i] = CROCKFORD_ALPHABET[time % 32];
    time /= 32;
  }

  // 2. Extract 80-bit randomness
  uint64_t rand_hi = 0;
  for (int i = 0; i < 5; i++) {
    rand_hi = (rand_hi << 8) | source[offset + 6 + i];
  }

  uint64_t rand_lo = 0;
  for (int i = 0; i < 5; i++) {
    rand_lo = (rand_lo << 8) | source[offset + 11 + i];
  }

  char rand_lo_part[9];
  rand_lo_part[8] = '\0';
  for (int i = 7; i >= 0; i--) {
    rand_lo_part[i] = CROCKFORD_ALPHABET[rand_lo & 31];
    rand_lo >>= 5;
  }

  char rand_hi_part[9];
  rand_hi_part[8] = '\0';
  for (int i = 7; i >= 0; i--) {
    rand_hi_part[i] = CROCKFORD_ALPHABET[rand_hi & 31];
    rand_hi >>= 5;
  }

  for (int i = 0; i < 10; i++) out_str[i] = time_str[i];
  for (int i = 0; i < 8; i++) out_str[10 + i] = rand_hi_part[i];
  for (int i = 0; i < 8; i++) out_str[18 + i] = rand_lo_part[i];
  out_str[26] = '\0';
}
