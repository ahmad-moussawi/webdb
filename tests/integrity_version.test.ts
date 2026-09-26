import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/webdb.js';
import {
  CorruptPageError,
  UnsupportedFormatVersionError,
} from '../src/types.js';
import { MemoryVfsAdapter } from '../src/storage/memory.js';
import { BufferPool } from '../src/engine/buffer_pool.js';
import { computePageChecksum, computePage1Checksum } from '../src/storage/crc32.js';

describe('Test Suite 5: Checksum Verification & Version Handshake (tests/integrity_version.test.ts)', () => {
  it('1. CRC32 Checksum Validation on Read: Bit flip in storage throws CorruptPageError', async () => {
    const vfs = new MemoryVfsAdapter();
    const pool = new BufferPool({ vfs, slotCount: 32 });

    // Allocate and flush page 2
    const slot = await pool.acquirePage(2);
    const view = pool.getSlotDataView(slot);
    view.setUint8(0, 0x0D);
    view.setUint16(2, 5, true); // cell_count = 5
    pool.markDirty(slot);
    await pool.flushSlot(slot);

    // Tamper with page 2 in VFS storage: flip 1 byte
    const storedPage = await vfs.readPage(2);
    expect(storedPage).not.toBeNull();
    storedPage![100] ^= 0x01; // Bit flip!
    await vfs.writePage(2, storedPage!);

    // Create a new BufferPool to force reading from VFS
    const newPool = new BufferPool({ vfs, slotCount: 32 });

    // Acquiring corrupted page must throw CorruptPageError
    await expect(newPool.acquirePage(2)).rejects.toThrow(CorruptPageError);
  });

  it('2. Page 1 Checksum Verification: Tampering with metadata throws CorruptPageError', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_p1_integrity', vfs });
    await db.createTable('users', [{ name: 'id', type: 'INT32' }]);
    await db.close();

    // Tamper with Page 1 in VFS (e.g. byte 120 in TableDescriptor area)
    const page1Bytes = await vfs.readPage(1);
    expect(page1Bytes).not.toBeNull();
    page1Bytes![120] ^= 0xAA; // Tamper
    await vfs.writePage(1, page1Bytes!);

    // Reopen with corrupted Page 1 must throw CorruptPageError
    await expect(
      WebDB.open({ name: 'test_p1_integrity', vfs })
    ).rejects.toThrow(CorruptPageError);
  });

  it('3. Engine Version Rejection: min_read_version = 99 throws UnsupportedFormatVersionError', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_future_version', vfs });
    await db.close();

    // Modify Page 1 header in VFS: min_read_version = 99 (bytes 10..11)
    const page1Bytes = await vfs.readPage(1);
    const view = new DataView(page1Bytes!.buffer, page1Bytes!.byteOffset);
    view.setUint16(10, 99, true); // min_read_version = 99
    // Zero out checksum and recompute so checksum validation passes and version check triggers
    view.setUint32(28, 0, true);
    const checksum = computePage1Checksum(page1Bytes!);
    view.setUint32(28, checksum, true);
    await vfs.writePage(1, page1Bytes!);

    // Reopen must throw UnsupportedFormatVersionError
    await expect(
      WebDB.open({ name: 'test_future_version', vfs })
    ).rejects.toThrow(UnsupportedFormatVersionError);
  });

  it('4. Backward-Compatible Version Acceptance: file_format_version = 2 with min_read_version = 1 opens successfully', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: 'test_compat_version', vfs });
    await db.createTable('posts', [{ name: 'id', type: 'INT32' }]);
    await db.close();

    // Modify Page 1 header: file_format_version = 2 (bytes 8..9), min_read_version = 1 (bytes 10..11)
    const page1Bytes = await vfs.readPage(1);
    const view = new DataView(page1Bytes!.buffer, page1Bytes!.byteOffset);
    view.setUint16(8, 2, true); // file_format_version = 2
    view.setUint16(10, 1, true); // min_read_version = 1
    // Update checksum for modified header
    view.setUint32(28, 0, true);
    const checksum = computePage1Checksum(page1Bytes!);
    view.setUint32(28, checksum, true);
    await vfs.writePage(1, page1Bytes!);

    // Reopen must succeed
    const db2 = await WebDB.open({ name: 'test_compat_version', vfs });
    const posts = await db2.getTable('posts');
    expect(posts.name).toBe('posts');
    await db2.close();
  });
});
