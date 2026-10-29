import {
  WAL_FILE_HEADER_SIZE,
  WAL_FRAME_HEADER_SIZE,
  WAL_FRAME_SIZE,
  WAL_PAGE_SIZE,
  WAL_CURRENT_VERSION,
  WAL_FRAME_MAGIC,
  WAL_HEADER_OFFSET_MAGIC,
  WAL_HEADER_OFFSET_WAL_VERSION,
  WAL_HEADER_OFFSET_PAGE_SIZE,
  WAL_HEADER_OFFSET_CHECKPOINT_SEQ,
  WAL_HEADER_OFFSET_SALT1,
  WAL_HEADER_OFFSET_SALT2,
  WAL_HEADER_OFFSET_CHECKSUM,
  WAL_HEADER_OFFSET_RESERVED,
  WAL_FRAME_OFFSET_MAGIC,
  WAL_FRAME_OFFSET_FRAME_TYPE,
  WAL_FRAME_OFFSET_FLAGS,
  WAL_FRAME_OFFSET_TX_ID,
  WAL_FRAME_OFFSET_PAGE_ID,
  WAL_FRAME_OFFSET_DB_SIZE_PAGES,
  WAL_FRAME_OFFSET_FRAME_SEQ,
  WAL_FRAME_OFFSET_CHECKSUM,
  WAL_FRAME_OFFSET_RESERVED,
} from '../../layouts/wal_format.js';
import { crc32, computeWalFrameChecksum } from './crc32.js';
import { read_u16, write_u16, read_u32, write_u32 } from '../../shared/c_runtime.js';
import { CorruptWalHeaderError, CorruptWalFrameError } from '../../types/index.js';


export const WAL_MAGIC_BYTES = new Uint8Array([0x57, 0x45, 0x42, 0x57, 0x41, 0x4c]); // "WEBWAL"

export interface WalFileHeader {
  walVersion: number;
  pageSize: number;
  checkpointSeq: number;
  salt1: number;
  salt2: number;
  checksum: number;
}

export interface WalFrameHeader {
  magic: number;
  frameType: number;
  flags: number;
  txId: number;
  pageId: number;
  dbSizePages: number;
  frameSeq: number;
  checksum: number;
}

export interface WalFrame {
  header: WalFrameHeader;
  pageData: Uint8Array;
}

/**
 * Encodes a 32-byte WAL file header.
 */
export function encodeWalFileHeader(header: Partial<WalFileHeader> = {}): Uint8Array {
  const bytes = new Uint8Array(WAL_FILE_HEADER_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 0..5: "WEBWAL"
  bytes.set(WAL_MAGIC_BYTES, WAL_HEADER_OFFSET_MAGIC);

  // 6..7: WAL version (uint16 LE)
  write_u16(view, WAL_HEADER_OFFSET_WAL_VERSION, header.walVersion ?? WAL_CURRENT_VERSION);

  // 8..11: Page size (uint32 LE)
  write_u32(view, WAL_HEADER_OFFSET_PAGE_SIZE, header.pageSize ?? WAL_PAGE_SIZE);

  // 12..15: Monotonic checkpoint counter (uint32 LE)
  write_u32(view, WAL_HEADER_OFFSET_CHECKPOINT_SEQ, header.checkpointSeq ?? 0);

  // 16..19: Random salt1 (uint32 LE)
  const salt1 = header.salt1 ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
  write_u32(view, WAL_HEADER_OFFSET_SALT1, salt1);

  // 20..23: Random salt2 (uint32 LE)
  const salt2 = header.salt2 ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
  write_u32(view, WAL_HEADER_OFFSET_SALT2, salt2);

  // 24..27: CRC32 checksum over bytes 0..23 (uint32 LE)
  const checksum = header.checksum ?? crc32(bytes, 0, 24);
  write_u32(view, WAL_HEADER_OFFSET_CHECKSUM, checksum);

  // 28..31: Zero padding
  write_u32(view, WAL_HEADER_OFFSET_RESERVED, 0);

  return bytes;
}

/**
 * Decodes and validates a 32-byte WAL file header.
 */
export function decodeWalFileHeader(bytes: Uint8Array, verifyChecksum: boolean = true): WalFileHeader {
  if (bytes.byteLength < WAL_FILE_HEADER_SIZE) {
    throw new CorruptWalHeaderError(
      `Truncated WAL file header: expected at least ${WAL_FILE_HEADER_SIZE} bytes, received ${bytes.byteLength}`,
    );
  }

  // Verify magic
  for (let i = 0; i < 6; i++) {
    if (bytes[WAL_HEADER_OFFSET_MAGIC + i] !== WAL_MAGIC_BYTES[i]) {
      throw new CorruptWalHeaderError(
        'Invalid WAL file header magic identifier (expected "WEBWAL")',
      );
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walVersion = read_u16(view, WAL_HEADER_OFFSET_WAL_VERSION);
  const pageSize = read_u32(view, WAL_HEADER_OFFSET_PAGE_SIZE);
  const checkpointSeq = read_u32(view, WAL_HEADER_OFFSET_CHECKPOINT_SEQ);
  const salt1 = read_u32(view, WAL_HEADER_OFFSET_SALT1);
  const salt2 = read_u32(view, WAL_HEADER_OFFSET_SALT2);
  const checksum = read_u32(view, WAL_HEADER_OFFSET_CHECKSUM);

  if (verifyChecksum) {
    const computed = crc32(bytes, 0, 24);
    if (checksum !== computed) {
      throw new CorruptWalHeaderError(
        `WAL file header CRC32 checksum mismatch: stored ${checksum}, computed ${computed}`,
      );
    }
  }

  return {
    walVersion,
    pageSize,
    checkpointSeq,
    salt1,
    salt2,
    checksum,
  };
}

/**
 * Encodes a single 4,128-byte WAL frame (32-byte header + 4096-byte page payload).
 */
export function encodeWalFrame(
  header: Omit<WalFrameHeader, 'magic' | 'checksum'> & { magic?: number; checksum?: number },
  pageData?: Uint8Array,
): Uint8Array {
  const frameBytes = new Uint8Array(WAL_FRAME_SIZE);
  const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);

  // 0..3: Frame magic 0x57414C46 ('WALF', uint32 LE)
  write_u32(view, WAL_FRAME_OFFSET_MAGIC, header.magic ?? WAL_FRAME_MAGIC);

  // 4..5: Frame type (uint16 LE)
  write_u16(view, WAL_FRAME_OFFSET_FRAME_TYPE, header.frameType);

  // 6..7: Reserved flags (uint16 LE)
  write_u16(view, WAL_FRAME_OFFSET_FLAGS, header.flags ?? 0);

  // 8..11: Transaction ID (uint32 LE)
  write_u32(view, WAL_FRAME_OFFSET_TX_ID, header.txId);

  // 12..15: Page ID (uint32 LE)
  write_u32(view, WAL_FRAME_OFFSET_PAGE_ID, header.pageId);

  // 16..19: DB size in pages after commit (uint32 LE)
  write_u32(view, WAL_FRAME_OFFSET_DB_SIZE_PAGES, header.dbSizePages ?? 0);

  // 20..23: Monotonic frame sequence counter in WAL (uint32 LE)
  write_u32(view, WAL_FRAME_OFFSET_FRAME_SEQ, header.frameSeq);

  // 28..31: Zero padding
  write_u32(view, WAL_FRAME_OFFSET_RESERVED, 0);

  // 32..4127: 4096-byte page payload
  if (pageData) {
    frameBytes.set(pageData.subarray(0, WAL_PAGE_SIZE), WAL_FRAME_HEADER_SIZE);
  }

  // 24..27: CRC32 checksum over header bytes 0..23 + 4096 page bytes
  const checksum = header.checksum ?? computeWalFrameChecksum(frameBytes);
  write_u32(view, WAL_FRAME_OFFSET_CHECKSUM, checksum);

  return frameBytes;
}

/**
 * Decodes only the 32-byte header of a WAL frame without copying the 4096 page bytes.
 */
export function decodeWalFrameHeader(frameBytes: Uint8Array): WalFrameHeader {
  if (frameBytes.byteLength < WAL_FRAME_HEADER_SIZE) {
    throw new CorruptWalFrameError(
      `Truncated WAL frame header: expected at least ${WAL_FRAME_HEADER_SIZE} bytes, received ${frameBytes.byteLength}`,
    );
  }

  const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  return {
    magic: read_u32(view, WAL_FRAME_OFFSET_MAGIC),
    frameType: read_u16(view, WAL_FRAME_OFFSET_FRAME_TYPE),
    flags: read_u16(view, WAL_FRAME_OFFSET_FLAGS),
    txId: read_u32(view, WAL_FRAME_OFFSET_TX_ID),
    pageId: read_u32(view, WAL_FRAME_OFFSET_PAGE_ID),
    dbSizePages: read_u32(view, WAL_FRAME_OFFSET_DB_SIZE_PAGES),
    frameSeq: read_u32(view, WAL_FRAME_OFFSET_FRAME_SEQ),
    checksum: read_u32(view, WAL_FRAME_OFFSET_CHECKSUM),
  };
}

/**
 * Validates a candidate WAL frame without throwing, detecting truncated tails,
 * magic mismatches, and torn writes / CRC32 bit corruption.
 */
export function validateWalFrame(frameBytes: Uint8Array): {
  valid: boolean;
  reason?: 'truncated' | 'magic_mismatch' | 'checksum_mismatch';
  header?: WalFrameHeader;
} {
  if (frameBytes.byteLength < WAL_FRAME_SIZE) {
    return { valid: false, reason: 'truncated' };
  }

  const header = decodeWalFrameHeader(frameBytes);
  if (header.magic !== WAL_FRAME_MAGIC) {
    return { valid: false, reason: 'magic_mismatch', header };
  }

  const computedChecksum = computeWalFrameChecksum(frameBytes);
  if (header.checksum !== computedChecksum) {
    return { valid: false, reason: 'checksum_mismatch', header };
  }

  return { valid: true, header };
}

/**
 * Decodes and verifies a complete 4,128-byte WAL frame.
 */
export function decodeWalFrame(frameBytes: Uint8Array, verifyChecksum: boolean = true): WalFrame {
  if (frameBytes.byteLength < WAL_FRAME_SIZE) {
    throw new CorruptWalFrameError(
      `Truncated WAL frame: expected ${WAL_FRAME_SIZE} bytes, received ${frameBytes.byteLength}`,
    );
  }

  const header = decodeWalFrameHeader(frameBytes);
  if (header.magic !== WAL_FRAME_MAGIC) {
    throw new CorruptWalFrameError(
      `Invalid WAL frame magic: expected 0x${WAL_FRAME_MAGIC.toString(16)}, got 0x${header.magic.toString(16)}`,
    );
  }

  if (verifyChecksum) {
    const computed = computeWalFrameChecksum(frameBytes);
    if (header.checksum !== computed) {
      throw new CorruptWalFrameError(
        `WAL frame CRC32 checksum mismatch: stored ${header.checksum}, computed ${computed}`,
      );
    }
  }

  const pageData = frameBytes.subarray(WAL_FRAME_HEADER_SIZE, WAL_FRAME_SIZE);
  return { header, pageData };
}
