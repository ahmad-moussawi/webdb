import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { MemoryVfsAdapter } from '../src/host/storage/memory.js';
import {
  encodeWalFileHeader,
  encodeWalFrame,
} from '../src/host/storage/wal_codec.js';
import {
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
  WAL_PAGE_SIZE,
} from '../src/constants.js';
import { computePageChecksum, computePage1Checksum } from '../src/host/storage/crc32.js';

describe('Phase 4: Transactions, ACID Rollback & WAL Checkpointing', () => {
  let vfs: MemoryVfsAdapter;
  let db: WebDB;

  beforeEach(async () => {
    vfs = new MemoryVfsAdapter();
    db = await WebDB.open({ vfs });
  });

  describe('1. Atomic Rollback & Isolation', () => {
    it('rolls back all rows when an error is thrown inside a multi-row transaction', async () => {
      await db.createTable('users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'name', type: 'TEXT' },
        { name: 'score', type: 'INT32' },
      ]);

      // Seed 1 committed user
      await db.insert('users', { id: 1, name: 'Alice', score: 100 });

      // Transaction that inserts 50 rows then throws
      await expect(
        db.transaction(async (tx) => {
          for (let i = 2; i <= 51; i++) {
            await tx.insert('users', { id: i, name: `User_${i}`, score: i * 10 });
          }
          throw new Error('Forced transaction failure midway');
        }),
      ).rejects.toThrow('Forced transaction failure midway');

      // Assert only Alice remains (0 of the 50 inserted rows exist)
      const rows = await db.from('users').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, name: 'Alice', score: 100 });
    });

    it('enforces exclusive transaction lease: external queries are blocked until commit', async () => {
      await db.createTable('accounts', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'balance', type: 'INT32' },
      ]);

      await db.insert('accounts', { id: 1, balance: 100 });

      let outsideQueryResolved = false;
      let outsideQueryResults: any = null;

      await db.transaction(async (tx) => {
        await tx.insert('accounts', { id: 2, balance: 200 });

        // Dispatch an external query from db (not tx)
        // This query must be blocked in the FIFO lease queue
        db.from('accounts').toArray().then((res) => {
          outsideQueryResolved = true;
          outsideQueryResults = res;
        });

        // Small microtask yield: verify external query is still blocked
        await new Promise((r) => setTimeout(r, 20));
        expect(outsideQueryResolved).toBe(false);

        await tx.insert('accounts', { id: 3, balance: 300 });
        // Exiting callback will commit the transaction
      });

      // After transaction commits and lease is released, external query finishes
      await new Promise((r) => setTimeout(r, 20));
      expect(outsideQueryResolved).toBe(true);
      expect(outsideQueryResults).toHaveLength(3);
    });

    it('prevents mid-transaction checkpoint from executing until transaction completes', async () => {
      await db.createTable('metrics', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'val', type: 'INT32' },
      ]);

      let checkpointFinished = false;

      await db.transaction(async (tx) => {
        await tx.insert('metrics', { id: 1, val: 50 });

        // Trigger checkpoint while in transaction
        db.checkpoint().then(() => {
          checkpointFinished = true;
        });

        // Yield to verify checkpoint has NOT completed yet
        await new Promise((r) => setTimeout(r, 20));
        expect(checkpointFinished).toBe(false);

        await tx.insert('metrics', { id: 2, val: 100 });
      });

      // After commit, checkpoint proceeds
      await new Promise((r) => setTimeout(r, 20));
      expect(checkpointFinished).toBe(true);

      const rows = await db.from('metrics').toArray();
      expect(rows).toHaveLength(2);
    });
  });

  describe('2. Deduplicated Checkpoint Verification', () => {
    it('modifies the same table in multiple transactions and syncs latest page state on checkpoint', async () => {
      await db.createTable('counters', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'count', type: 'INT32' },
      ]);

      // Execute 5 separate transactions mutating the same rows
      for (let i = 1; i <= 5; i++) {
        await db.transaction(async (tx) => {
          await tx.insert('counters', { id: i, count: i * 10 });
        });
      }

      // Checkpoint merges WAL and buffer pool
      const result = await db.checkpoint();
      expect(result.pagesWritten).toBeGreaterThan(0);

      // WAL should now be truncated to 0 frames
      const walFrameCount = await vfs.getWalFrameCount();
      expect(walFrameCount).toBe(0);

      // Main database file contains all rows
      const rows = await db.from('counters').toArray();
      expect(rows).toHaveLength(5);
      expect(rows[4]).toMatchObject({ id: 5, count: 50 });
    });
  });

  describe('3. Crash Recovery Simulation', () => {
    it('replays committed transactions and discards uncommitted transactions on startup', async () => {
      await db.createTable('ledger', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'note', type: 'TEXT' },
      ]);

      // Commit 1 row and checkpoint to establish base DB
      await db.insert('ledger', { id: 1, note: 'Genesis' });
      await db.checkpoint();

      // Read root page for ledger table to get its pageId
      const table = await db.getTable('ledger');
      const rootPageId = table.rootPageId;

      // Close current db cleanly
      await db.close();

      // Now manually construct a WAL on the VFS:
      // Tx 1: committed (adds page with note 'CommittedTx1')
      // Tx 2: uncommitted (abrupt crash before FRAME_TX_COMMIT)
      const walHeader = encodeWalFileHeader({ checkpointSeq: 1 });
      await vfs.writeWalHeader(walHeader);

      // Fetch base page data from vfs
      const pageData = await vfs.readPage(rootPageId);
      expect(pageData).not.toBeNull();

      const pageCopyTx1 = new Uint8Array(pageData!);
      // Modify page slightly for Tx 1
      pageCopyTx1[100] = 0xAA;
      const chk1 = computePageChecksum(pageCopyTx1);
      new DataView(pageCopyTx1.buffer, pageCopyTx1.byteOffset).setUint32(12, chk1, true);

      const frame1_data = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 1,
          pageId: rootPageId,
          dbSizePages: 2,
          frameSeq: 1,
        },
        pageCopyTx1,
      );

      const frame1_commit = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 1,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 2,
      });

      // Tx 2: mutated page but NO commit marker
      const pageCopyTx2 = new Uint8Array(pageData!);
      pageCopyTx2[100] = 0xFF; // uncommitted modification
      const chk2 = computePageChecksum(pageCopyTx2);
      new DataView(pageCopyTx2.buffer, pageCopyTx2.byteOffset).setUint32(12, chk2, true);

      const frame2_data = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 2,
          pageId: rootPageId,
          dbSizePages: 2,
          frameSeq: 3,
        },
        pageCopyTx2,
      );

      await vfs.appendWalFrames([frame1_data, frame1_commit, frame2_data]);
      expect(await vfs.getWalFrameCount()).toBe(3);

      // Re-open WebDB -> triggers recoverFromWal()
      const recoveredDb = await WebDB.open({ vfs });

      // Assert WAL was replayed and truncated to 0
      expect(await vfs.getWalFrameCount()).toBe(0);

      // Verify that page in storage has Tx 1 data (0xAA) and NOT Tx 2 uncommitted data (0xFF)
      const diskPage = await vfs.readPage(rootPageId);
      expect(diskPage![100]).toBe(0xAA);

      await recoveredDb.close();
    });

    it('heals a torn master page (Page 1) on startup from intact committed WAL frame', async () => {
      await db.createTable('secrets', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'secret', type: 'TEXT' },
      ]);
      await db.insert('secrets', { id: 1, secret: 'top_secret' });
      await db.checkpoint();

      // Read intact Page 1
      const intactPage1 = await vfs.readPage(1);
      expect(intactPage1).not.toBeNull();

      await db.close();

      // Simulate a crash during checkpoint write:
      // Page 1 on disk is corrupted / torn
      const corruptedPage1 = new Uint8Array(intactPage1!);
      corruptedPage1[0] = 0x00; // destroy magic
      corruptedPage1[28] = 0x00; // corrupt checksum
      await vfs.writePage(1, corruptedPage1);

      // But WAL contains the intact committed Page 1
      const walHeader = encodeWalFileHeader({ checkpointSeq: 1 });
      await vfs.writeWalHeader(walHeader);

      const framePage1 = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 10,
          pageId: 1,
          dbSizePages: 2,
          frameSeq: 1,
        },
        intactPage1!,
      );

      const frameCommit = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 10,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 2,
      });

      await vfs.appendWalFrames([framePage1, frameCommit]);

      // Re-open database -> startup recovery must heal Page 1 before validating it
      const recoveredDb = await WebDB.open({ vfs });

      // Assert database opened successfully and table is queryable
      const rows = await recoveredDb.from('secrets').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, secret: 'top_secret' });

      // Disk Page 1 has been restored with valid checksum
      const restoredPage1 = await vfs.readPage(1);
      expect(computePage1Checksum(restoredPage1!)).toBe(
        new DataView(restoredPage1!.buffer, restoredPage1!.byteOffset).getUint32(28, true),
      );

      await recoveredDb.close();
    });

    it('handles truncated tail frames cleanly without crashing', async () => {
      await db.createTable('logs', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'msg', type: 'TEXT' },
      ]);
      await db.insert('logs', { id: 1, msg: 'Entry 1' });
      await db.checkpoint();
      await db.close();

      // Write committed Tx 1
      const walHeader = encodeWalFileHeader({ checkpointSeq: 1 });
      await vfs.writeWalHeader(walHeader);

      const frameCommit = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 1,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 1,
      });

      // Followed by a partially-written 3rd frame (truncated at 1500 bytes instead of 4128)
      const partialFrame = new Uint8Array(1500);

      await vfs.appendWalFrames([frameCommit, partialFrame]);

      // Re-open DB: should not crash, must recover committed Tx 1 and discard partial frame
      const recoveredDb = await WebDB.open({ vfs });
      const rows = await recoveredDb.from('logs').toArray();
      expect(rows).toHaveLength(1);

      await recoveredDb.close();
    });

    it('rejects torn WAL frames with bit rot and prevents database corruption', async () => {
      await db.createTable('items', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'val', type: 'TEXT' },
      ]);
      await db.insert('items', { id: 1, val: 'Original' });
      await db.checkpoint();

      const table = await db.getTable('items');
      await db.close();

      // WAL has 1 frame with bit rot (CRC32 mismatch)
      const walHeader = encodeWalFileHeader({ checkpointSeq: 1 });
      await vfs.writeWalHeader(walHeader);

      const pageBytes = new Uint8Array(WAL_PAGE_SIZE);
      const frame = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 1,
          pageId: table.rootPageId,
          dbSizePages: 2,
          frameSeq: 1,
        },
        pageBytes,
      );

      // Flip 1 bit in frame
      frame[40] ^= 0x01;

      const commitFrame = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 1,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 2,
      });

      await vfs.appendWalFrames([frame, commitFrame]);

      // Recovery should stop before the torn frame and avoid corrupting the database
      const recoveredDb = await WebDB.open({ vfs });
      const rows = await recoveredDb.from('items').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, val: 'Original' });

      await recoveredDb.close();
    });

    it('preserves valid page CRC32 checksums across transaction commit, checkpoint, and reopen', async () => {
      await db.createTable('orders', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'customer', type: 'TEXT' },
      ]);
      await db.insert('orders', { id: 1, customer: 'Initial' });

      await db.transaction(async (tx) => {
        await tx.insert('orders', { id: 2, customer: 'InTx_1' });
        await tx.insert('orders', { id: 3, customer: 'InTx_2' });
        await tx.createIndex('orders', 'customer', { unique: true });
      });

      await db.close();

      // Reopen from VFS and read both table and index pages from disk (validating CRC32 checksums)
      const reopened = await WebDB.open({ vfs });
      const rows = await reopened.from('orders').where('customer', '=', 'InTx_2').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 3, customer: 'InTx_2' });

      const allRows = await reopened.from('orders').orderBy('id', 'asc').toArray();
      expect(allRows).toHaveLength(3);
      await reopened.close();
    });

    it('handles uncommitted cache spilling (FRAME_TX_UNCOMMITTED) under tight buffer pool pressure for both rollback and commit', async () => {
      await db.close();

      // Open with a very small buffer pool (8 slots) so inserting many large rows forces evictions mid-transaction
      const smallVfs = new MemoryVfsAdapter();
      const smallDb = await WebDB.open({ vfs: smallVfs, slotCount: 8 });
      await smallDb.createTable('big_logs', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'payload', type: 'TEXT' },
      ]);

      const largeText = 'X'.repeat(500); // ~7-8 rows per 4KB page

      // 1. Test ROLLBACK after spilling many pages beyond the 8-slot pool
      await expect(
        smallDb.transaction(async (tx) => {
          for (let i = 1; i <= 80; i++) {
            await tx.insert('big_logs', { id: i, payload: `${i}_${largeText}` });
          }
          throw new Error('Abort after cache spill');
        }),
      ).rejects.toThrow('Abort after cache spill');

      expect(await smallVfs.getWalFrameCount()).toBe(0);
      expect(await smallDb.from('big_logs').toArray()).toHaveLength(0);

      // 2. Test COMMIT after spilling many pages beyond the 8-slot pool
      await smallDb.transaction(async (tx) => {
        for (let i = 1; i <= 80; i++) {
          await tx.insert('big_logs', { id: i, payload: `${i}_${largeText}` });
        }
      });

      // Immediately query all 80 rows before checkpointing (reads both resident and spilled WAL pages)
      const beforeCp = await smallDb.from('big_logs').toArray();
      expect(beforeCp).toHaveLength(80);

      // Close (triggers checkpoint) and reopen from disk
      await smallDb.close();
      const reopened = await WebDB.open({ vfs: smallVfs, slotCount: 16 });
      const afterReopen = await reopened.from('big_logs').toArray();
      expect(afterReopen).toHaveLength(80);
      await reopened.close();
    });

    it('atomically rolls back DDL operations (dropTable / createTable) without corrupting disk pages', async () => {
      await db.createTable('preserved', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'tag', type: 'TEXT' },
      ]);
      await db.insert('preserved', { id: 1, tag: 'keep_me_1' });
      await db.insert('preserved', { id: 2, tag: 'keep_me_2' });
      await db.checkpoint();

      await expect(
        db.transaction(async (tx) => {
          await tx.dropTable('preserved');
          await tx.createTable('ephemeral', [{ name: 'id', type: 'INT32' }]);
          await tx.insert('ephemeral', { id: 99 });
          throw new Error('Cancel DDL migration');
        }),
      ).rejects.toThrow('Cancel DDL migration');

      // Preserved table and rows must still exist in memory
      const rows = await db.from('preserved').orderBy('id', 'asc').toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: 1, tag: 'keep_me_1' });

      // And must remain intact on disk after close & reopen
      await db.close();
      const reopened = await WebDB.open({ vfs });
      const diskRows = await reopened.from('preserved').orderBy('id', 'asc').toArray();
      expect(diskRows).toHaveLength(2);
      await reopened.close();
    });

    it('supports nested tx.transaction() savepoints that roll back independently when caught', async () => {
      await db.createTable('steps', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'label', type: 'TEXT' },
      ]);

      await db.transaction(async (tx) => {
        await tx.insert('steps', { id: 1, label: 'outer_before' });

        try {
          await tx.transaction(async (nestedTx) => {
            await nestedTx.insert('steps', { id: 2, label: 'inner_aborted' });
            throw new Error('Inner savepoint failed');
          });
        } catch {
          // Outer transaction catches inner error and continues
        }

        await tx.insert('steps', { id: 3, label: 'outer_after' });
      });

      const rows = await db.from('steps').orderBy('id', 'asc').toArray();
      expect(rows).toEqual([
        { id: 1, label: 'outer_before' },
        { id: 3, label: 'outer_after' },
      ]);
    });

    it('enforces statement-level atomicity on insertMany when a mid-batch constraint fails', async () => {
      await db.createTable('unique_users', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'email', type: 'TEXT' },
      ]);
      await db.createIndex('unique_users', 'email', { unique: true });
      await db.insert('unique_users', { id: 1, email: 'existing@test.com' });

      await expect(
        db.insertMany('unique_users', [
          { id: 2, email: 'new1@test.com' },
          { id: 3, email: 'new2@test.com' },
          { id: 4, email: 'existing@test.com' }, // duplicate on 3rd item in batch!
        ]),
      ).rejects.toThrow();

      // Neither id 2 nor id 3 should have been partially inserted
      const rows = await db.from('unique_users').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, email: 'existing@test.com' });
    });
  });
});
