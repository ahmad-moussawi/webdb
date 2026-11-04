import { describe, it, expect } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import {
  InvalidDatabaseError,
  CorruptPageError,
  UnsupportedFormatVersionError,
  UniqueConstraintViolationError,
  TableNotFoundError,
} from '../src/types/index.js';
import {
  compressGzip,
  decompressIfNeeded,
  isGzipBytes,
  deriveDbNameFromSource,
  isRemoteDbParam,
  buildShareablePlaygroundUrl,
} from '../playground/src/utils/binaryLoader.js';

describe('Binary Database Export & Import (tests/binary_export_import.test.ts)', () => {
  it('1. Round-trip exportBinary() and importBinary() preserves tables, all data types, indexes, and autoInc sequences', async () => {
    const srcDb = await WebDB.open({ name: 'src_export_db', storage: 'memory' });

    await srcDb.createTable('users', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'email', type: 'TEXT', notNull: true },
      { name: 'points', type: 'INT64' },
      { name: 'score', type: 'FLOAT64' },
      { name: 'avatar', type: 'BLOB' },
    ]);
    await srcDb.createIndex('users', 'email', { unique: true });

    await srcDb.createTable('audit_logs', [
      { name: 'log_id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'user_id', type: 'INT32' },
      { name: 'action', type: 'TEXT' },
    ]);
    await srcDb.createIndex('audit_logs', ['user_id', 'action'], {
      name: 'idx_audit_user_action',
    });

    await srcDb.insertMany('users', [
      {
        email: 'alice@example.com',
        points: 900000000000n,
        score: 98.75,
        avatar: new Uint8Array([1, 2, 3, 4]),
      },
      {
        email: 'bob@example.com',
        points: null,
        score: 72.5,
        avatar: null,
      },
    ]);

    // Also perform an ALTER TABLE mutation before exporting
    await srcDb.addColumn(
      'users',
      { name: 'tier', type: 'TEXT', notNull: true },
      { defaultValue: 'gold' },
    );

    // Perform an uncheckpointed transaction before exporting to verify exportBinary checkpoints/materializes WAL
    await srcDb.transaction(async (tx) => {
      await tx.insertMany('audit_logs', [
        { user_id: 1, action: 'login' },
        { user_id: 2, action: 'upgrade' },
      ]);
    });

    const binaryImage = await srcDb.exportBinary();
    expect(binaryImage.byteLength).toBeGreaterThanOrEqual(4096 * 5);
    expect(binaryImage.byteLength % 4096).toBe(0);

    // Import into a brand new database via WebDB.open({ initialData })
    const destDb = await WebDB.open({
      name: 'dest_import_db',
      storage: 'memory',
      initialData: binaryImage,
    });

    const users = await destDb.from('users').orderBy('id', 'asc').toArray();
    expect(users).toEqual([
      {
        id: 1,
        email: 'alice@example.com',
        points: 900000000000n,
        score: 98.75,
        avatar: new Uint8Array([1, 2, 3, 4]),
        tier: 'gold',
      },
      {
        id: 2,
        email: 'bob@example.com',
        points: null,
        score: 72.5,
        avatar: null,
        tier: 'gold',
      },
    ]);

    // Verify unique index on 'email' and auto-increment continuity in imported DB
    await expect(
      destDb.insert('users', {
        email: 'alice@example.com',
        points: 1n,
        score: 1.0,
        avatar: null,
        tier: 'silver',
      }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    await destDb.insert('users', {
      email: 'charlie@example.com',
      points: 50n,
      score: 88.0,
      avatar: new Uint8Array([9, 9]),
      tier: 'platinum',
    });
    const charlie = await destDb
      .from('users')
      .where('email', '=', 'charlie@example.com')
      .first();
    expect(charlie?.id).toBe(3);

    // Verify second table and composite index survived import
    const logs = await destDb
      .from('audit_logs')
      .where('user_id', '=', 2)
      .toArray();
    expect(logs).toEqual([{ log_id: 2, user_id: 2, action: 'upgrade' }]);

    await srcDb.close();
    await destDb.close();
  });

  it('2. importBinary() cleanly replaces an already-populated database with active tables and WAL frames', async () => {
    const sourceDb = await WebDB.open({ name: 'source_clean', storage: 'memory' });
    await sourceDb.createTable('countries', [
      { name: 'code', type: 'TEXT', primaryKey: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await sourceDb.insertMany('countries', [
      { code: 'US', name: 'United States' },
      { code: 'JP', name: 'Japan' },
    ]);
    const exportedBytes = await sourceDb.exportBinary();
    await sourceDb.close();

    // Target DB has completely different tables, pinned catalog pages, and uncommitted/committed WAL state
    const targetDb = await WebDB.open({ name: 'target_dirty', storage: 'memory' });
    await targetDb.createTable('legacy_items', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'title', type: 'TEXT' },
    ]);
    await targetDb.transaction(async (tx) => {
      for (let i = 1; i <= 50; i++) {
        await tx.insert('legacy_items', { id: i, title: `Item #${i}` });
      }
    });

    // Replace targetDb with exportedBytes
    await targetDb.importBinary(exportedBytes);

    // Old table is gone
    await expect(targetDb.getTable('legacy_items')).rejects.toThrow(TableNotFoundError);

    // New table is immediately queryable and writable
    const countries = await targetDb.from('countries').orderBy('code', 'asc').toArray();
    expect(countries).toEqual([
      { code: 'JP', name: 'Japan' },
      { code: 'US', name: 'United States' },
    ]);

    await targetDb.insert('countries', { code: 'DE', name: 'Germany' });
    expect(await targetDb.from('countries').toArray()).toHaveLength(3);

    await targetDb.close();
  });

  it('3. Rejects malformed, truncated, or CRC32-corrupted binary images without mutating existing database state', async () => {
    const db = await WebDB.open({ name: 'test_import_validation', storage: 'memory' });
    await db.createTable('safe_data', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'val', type: 'TEXT' },
    ]);
    await db.insert('safe_data', { id: 1, val: 'untouched' });

    const validImage = await db.exportBinary();

    // 1. Empty or non-multiple of 4096 bytes
    await expect(db.importBinary(new Uint8Array(0))).rejects.toThrow(
      InvalidDatabaseError,
    );
    await expect(db.importBinary(new Uint8Array(5000))).rejects.toThrow(
      InvalidDatabaseError,
    );

    // 2. Corrupt magic bytes on Page 1
    const badMagic = validImage.slice();
    badMagic[0] = 0x00;
    await expect(db.importBinary(badMagic)).rejects.toThrow(InvalidDatabaseError);

    // 3. Unsupported future min_read_version on Page 1
    const futureVersion = validImage.slice();
    new DataView(futureVersion.buffer).setUint16(10, 99, true); // HEADER_OFFSET_MIN_READ_VERSION = 10
    await expect(db.importBinary(futureVersion)).rejects.toThrow(
      UnsupportedFormatVersionError,
    );

    // 4. Corrupt Page 1 CRC32 checksum
    const badPage1Crc = validImage.slice();
    badPage1Crc[105] ^= 0xff;
    await expect(db.importBinary(badPage1Crc)).rejects.toThrow(CorruptPageError);

    // 5. Truncated image (totalPages in Page 1 header doesn't match byteLength / 4096)
    const truncated = validImage.slice(0, 4096); // Only Page 1, missing pages 2..N
    await expect(db.importBinary(truncated)).rejects.toThrow(InvalidDatabaseError);

    // 6. Corrupt data page (Page 2) CRC32 checksum
    const badPage2Crc = validImage.slice();
    badPage2Crc[4096 + 20] ^= 0xff;
    await expect(db.importBinary(badPage2Crc)).rejects.toThrow(CorruptPageError);

    // 7. Reject importBinary inside an active transaction
    await expect(
      db.transaction(async (tx) => {
        await tx.importBinary(validImage);
      }),
    ).rejects.toThrow(/Cannot import binary database while a transaction is active/);

    // Verify existing database state remained 100% intact after all rejected imports
    const rows = await db.from('safe_data').toArray();
    expect(rows).toEqual([{ id: 1, val: 'untouched' }]);

    await db.close();
  });

  it('4. Gzip compression (.webdb.gz) round-trip and Studio remote URL helpers', async () => {
    const srcDb = await WebDB.open({ name: 'gz_source', storage: 'memory' });
    await srcDb.createTable('products', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'title', type: 'TEXT' },
    ]);
    await srcDb.insertMany('products', [
      { id: 1, title: 'Mechanical Keyboard' },
      { id: 2, title: 'Ultrawide Monitor' },
    ]);

    const rawBytes = await srcDb.exportBinary();
    await srcDb.close();

    // Compress to .webdb.gz
    const gzBytes = await compressGzip(rawBytes);
    expect(isGzipBytes(gzBytes)).toBe(true);
    expect(gzBytes.byteLength).toBeLessThan(rawBytes.byteLength);

    // Decompress .webdb.gz and open in WebDB
    const decompressed = await decompressIfNeeded(gzBytes);
    expect(decompressed.wasCompressed).toBe(true);
    expect(decompressed.bytes.byteLength).toBe(rawBytes.byteLength);

    // Passing uncompressed bytes to decompressIfNeeded is a no-op
    const passthrough = await decompressIfNeeded(rawBytes);
    expect(passthrough.wasCompressed).toBe(false);
    expect(passthrough.bytes.byteLength).toBe(rawBytes.byteLength);

    const importedDb = await WebDB.open({
      name: 'gz_restored',
      storage: 'memory',
      initialData: decompressed.bytes,
    });
    const rows = await importedDb.from('products').orderBy('id', 'asc').toArray();
    expect(rows).toEqual([
      { id: 1, title: 'Mechanical Keyboard' },
      { id: 2, title: 'Ultrawide Monitor' },
    ]);
    await importedDb.close();

    // Verify URL helpers
    expect(isRemoteDbParam('https://example.com/files/db.webdb.gz')).toBe(true);
    expect(isRemoteDbParam('https://example.com/files/db.webdb')).toBe(true);
    expect(isRemoteDbParam('/assets/sample.webdb.gz')).toBe(true);
    expect(isRemoteDbParam('ecommerce_db')).toBe(false);

    expect(deriveDbNameFromSource('https://example.com/files/db.webdb.gz')).toBe('db');
    expect(deriveDbNameFromSource('my-store-2026.webdb.gz')).toBe('my_store_2026');

    expect(
      buildShareablePlaygroundUrl({
        remoteUrl: 'https://example.com/files/db.webdb.gz',
        core: 'wasm',
        storage: 'memory',
      }),
    ).toBe(
      'https://ahmad-moussawi.github.io/webdb/playground/?core=wasm&db=https://example.com/files/db.webdb.gz&storage=memory',
    );
  });
});

