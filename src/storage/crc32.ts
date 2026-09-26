/**
 * CRC32 IEEE 802.3 standard implementation (polynomial 0xEDB88320).
 * Used for page-level integrity checks, WAL frame verification, and torn-write detection.
 */

const CRC_TABLE = new Uint32Array(256);

// Precompute CRC32 lookup table
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Computes CRC32 checksum across a Uint8Array slice.
 */
export function crc32(data: Uint8Array, start: number = 0, length: number = data.byteLength - start): number {
  let crc = 0xffffffff;
  const end = start + length;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Computes the CRC32 checksum of a 4KB page.
 * In WebDB slotted pages, bytes 12..15 store the checksum itself, so they are treated as 0 during computation.
 */
export function computePageChecksum(pageBytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < 4096; i++) {
    // Treat bytes 12..15 as zeroed
    const byte = (i >= 12 && i <= 15) ? 0 : pageBytes[i];
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Computes the CRC32 checksum of Page 1.
 * Bytes 28..31 store Page 1's checksum, so they are treated as 0 during computation.
 */
export function computePage1Checksum(pageBytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < 4096; i++) {
    // Treat bytes 28..31 as zeroed
    const byte = (i >= 28 && i <= 31) ? 0 : pageBytes[i];
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
