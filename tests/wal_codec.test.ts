import { describe, it, expect } from 'vitest';
import {
  encodeWalFileHeader,
  decodeWalFileHeader,
  encodeWalFrame,
  decodeWalFrame,
  validateWalFrame,
} from '../src/host/storage/wal_codec.js';
import {
  WAL_FILE_HEADER_SIZE,
  WAL_FRAME_SIZE,
  WAL_PAGE_SIZE,
  WAL_CURRENT_VERSION,
  WAL_FRAME_MAGIC,
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
} from '../src/constants.js';
import { CorruptWalHeaderError, CorruptWalFrameError } from '../src/types/index.js';

describe('WAL Binary Codec & Integrity Tests', () => {
  describe('1. WAL File Header (32 bytes)', () => {
    it('encodes and decodes a default WAL file header with valid CRC32', () => {
      const headerBytes = encodeWalFileHeader();
      expect(headerBytes.byteLength).toBe(WAL_FILE_HEADER_SIZE);

      const decoded = decodeWalFileHeader(headerBytes);
      expect(decoded.walVersion).toBe(WAL_CURRENT_VERSION);
      expect(decoded.pageSize).toBe(WAL_PAGE_SIZE);
      expect(decoded.checkpointSeq).toBe(0);
      expect(decoded.checksum).toBeGreaterThan(0);
    });

    it('preserves custom checkpoint sequence and salt fields', () => {
      const headerBytes = encodeWalFileHeader({
        checkpointSeq: 42,
        salt1: 0x12345678,
        salt2: 0x9abcdef0,
      });

      const decoded = decodeWalFileHeader(headerBytes);
      expect(decoded.checkpointSeq).toBe(42);
      expect(decoded.salt1).toBe(0x12345678);
      expect(decoded.salt2).toBe(0x9abcdef0);
    });

    it('rejects truncated WAL file headers', () => {
      const truncated = new Uint8Array(20);
      expect(() => decodeWalFileHeader(truncated)).toThrow(CorruptWalHeaderError);
    });

    it('rejects invalid magic identifier', () => {
      const headerBytes = encodeWalFileHeader();
      headerBytes[0] = 0x58; // 'X' instead of 'W'
      expect(() => decodeWalFileHeader(headerBytes)).toThrow(CorruptWalHeaderError);
    });

    it('detects single-bit corruption in header via CRC32 mismatch', () => {
      const headerBytes = encodeWalFileHeader({ checkpointSeq: 100 });
      // Corrupt a byte in checkpointSeq
      headerBytes[12] ^= 0x01;
      expect(() => decodeWalFileHeader(headerBytes)).toThrow(CorruptWalHeaderError);
    });
  });

  describe('2. WAL Frame (4128 bytes: 32B header + 4096B page payload)', () => {
    it('encodes and decodes a PAGE_DATA frame with exact payload', () => {
      const pageData = new Uint8Array(WAL_PAGE_SIZE);
      for (let i = 0; i < WAL_PAGE_SIZE; i++) {
        pageData[i] = i % 256;
      }

      const frameBytes = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 101,
          pageId: 5,
          dbSizePages: 10,
          frameSeq: 1,
        },
        pageData,
      );

      expect(frameBytes.byteLength).toBe(WAL_FRAME_SIZE);

      const { header, pageData: decodedPage } = decodeWalFrame(frameBytes);
      expect(header.magic).toBe(WAL_FRAME_MAGIC);
      expect(header.frameType).toBe(WAL_FRAME_TYPE_PAGE_DATA);
      expect(header.txId).toBe(101);
      expect(header.pageId).toBe(5);
      expect(header.dbSizePages).toBe(10);
      expect(header.frameSeq).toBe(1);

      expect(decodedPage).toEqual(pageData);
    });

    it('encodes and decodes a TX_COMMIT marker frame', () => {
      const frameBytes = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 101,
        pageId: 0,
        dbSizePages: 10,
        frameSeq: 2,
      });

      const { header } = decodeWalFrame(frameBytes);
      expect(header.frameType).toBe(WAL_FRAME_TYPE_TX_COMMIT);
      expect(header.txId).toBe(101);
    });

    it('detects bit-rot in frame payload via CRC32', () => {
      const pageData = new Uint8Array(WAL_PAGE_SIZE);
      pageData[100] = 42;

      const frameBytes = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 1,
          pageId: 2,
          dbSizePages: 5,
          frameSeq: 1,
        },
        pageData,
      );

      // Flip 1 bit in payload
      frameBytes[32 + 100] ^= 0x01;

      expect(() => decodeWalFrame(frameBytes)).toThrow(CorruptWalFrameError);

      const validation = validateWalFrame(frameBytes);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('checksum_mismatch');
    });

    it('detects truncated frame and halts cleanly without throwing in validateWalFrame', () => {
      const truncated = new Uint8Array(2048);
      const validation = validateWalFrame(truncated);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('truncated');

      expect(() => decodeWalFrame(truncated)).toThrow(CorruptWalFrameError);
    });

    it('detects invalid frame magic', () => {
      const frameBytes = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_PAGE_DATA,
        flags: 0,
        txId: 1,
        pageId: 2,
        dbSizePages: 2,
        frameSeq: 1,
      });

      // Corrupt magic
      frameBytes[0] = 0x00;

      const validation = validateWalFrame(frameBytes);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('magic_mismatch');

      expect(() => decodeWalFrame(frameBytes)).toThrow(CorruptWalFrameError);
    });
  });
});
