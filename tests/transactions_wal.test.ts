import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB } from '../src/host/api/webdb.js';
import { MemoryVfsAdapter } from '../src/host/storage/memory.js';
import { OpfsVfsAdapter } from '../src/host/storage/opfs.js';
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

    it('recovers from an abrupt uncheckpointed crash (no db.close / no checkpoint) across multiple transactions and cache spills', async () => {
      await db.close();

      const crashVfs = new MemoryVfsAdapter();
      const activeDb = await WebDB.open({ vfs: crashVfs, slotCount: 8 });

      await activeDb.createTable('events', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'code', type: 'TEXT' },
        { name: 'payload', type: 'TEXT' },
      ]);
      await activeDb.createIndex('events', 'code', { unique: true });

      const blobText = 'P'.repeat(400);

      // Tx 1: commits 30 rows (spills FRAME_TX_UNCOMMITTED + commits FRAME_PAGE_DATA)
      await activeDb.transaction(async (tx) => {
        for (let i = 1; i <= 30; i++) {
          await tx.insert('events', {
            id: i,
            code: `EVT_${i}`,
            payload: `${i}_${blobText}`,
          });
        }
      });

      // Tx 2: aborts after spilling 25 rows (tests walFrameSeq restoration after rollback)
      await expect(
        activeDb.transaction(async (tx) => {
          for (let i = 100; i <= 125; i++) {
            await tx.insert('events', {
              id: i,
              code: `ABORT_${i}`,
              payload: `${i}_${blobText}`,
            });
          }
          throw new Error('Mid-flight crash rollback');
        }),
      ).rejects.toThrow('Mid-flight crash rollback');

      // Tx 3: commits 20 more rows right after the rollback
      await activeDb.transaction(async (tx) => {
        for (let i = 31; i <= 50; i++) {
          await tx.insert('events', {
            id: i,
            code: `EVT_${i}`,
            payload: `${i}_${blobText}`,
          });
        }
      });

      // Verify WAL has uncheckpointed frames on disk
      expect(await crashVfs.getWalFrameCount()).toBeGreaterThan(0);

      // Simulate abrupt power loss: DO NOT call activeDb.close() or activeDb.checkpoint()!
      // Directly open a new WebDB instance against crashVfs to trigger recoverFromWal().
      const recoveredDb = await WebDB.open({ vfs: crashVfs, slotCount: 16 });

      // WAL must be replayed and truncated to 0
      expect(await crashVfs.getWalFrameCount()).toBe(0);

      // All 50 committed rows (from Tx 1 and Tx 3) must exist, and 0 from Tx 2
      const allRows = await recoveredDb.from('events').orderBy('id', 'asc').toArray();
      expect(allRows).toHaveLength(50);
      expect(allRows[0]).toMatchObject({ id: 1, code: 'EVT_1' });
      expect(allRows[49]).toMatchObject({ id: 50, code: 'EVT_50' });

      // Secondary B+Tree index must also be intact after WAL recovery
      const indexedRow = await recoveredDb.from('events').where('code', '=', 'EVT_42').toArray();
      expect(indexedRow).toHaveLength(1);
      expect(indexedRow[0]).toMatchObject({ id: 42, code: 'EVT_42' });

      await recoveredDb.close();
    });

    it('automatically triggers a passive checkpoint when WAL frame threshold (256 frames) or tx threshold (100 txs) is reached', async () => {
      await db.createTable('ticks', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
      ]);

      // 1. Test 256-frame threshold: each insert tx writes 4 frames (Page 1, data page, PK index page, COMMIT).
      // After 63 transactions -> 63 * 4 = 252 frames (< 256): WAL should still hold 252 frames.
      for (let i = 1; i <= 63; i++) {
        await db.transaction(async (tx) => {
          await tx.insert('ticks', { id: i });
        });
      }
      expect(await vfs.getWalFrameCount()).toBe(252);

      // 64th transaction reaches 256 frames (>= 256) and enqueues passive auto-checkpoint
      await db.transaction(async (tx) => {
        await tx.insert('ticks', { id: 64 });
      });

      // Wait briefly for the enqueued passive checkpoint task to finish
      await new Promise((r) => setTimeout(r, 20));
      expect(await vfs.getWalFrameCount()).toBe(0);

      // 2. Test 100-transaction threshold: 99 no-op commits write 99 COMMIT frames (< 256 frames)
      for (let i = 1; i <= 99; i++) {
        await db.transaction(async () => {});
      }
      expect(await vfs.getWalFrameCount()).toBe(99);

      // 100th transaction crosses txCommitCount >= 100 and triggers passive auto-checkpoint
      await db.transaction(async () => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(await vfs.getWalFrameCount()).toBe(0);

      const rows = await db.from('ticks').toArray();
      expect(rows).toHaveLength(64);
    });

    it('cleanly rolls back B+Tree secondary index splits and unique constraints on abort', async () => {
      await db.createTable('subscribers', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'email', type: 'TEXT' },
      ]);
      await db.createIndex('subscribers', 'email', { unique: true });

      for (let i = 1; i <= 5; i++) {
        await db.insert('subscribers', { id: i, email: `seed_${i}@example.com` });
      }

      // Insert 120 rows with long emails inside an aborted tx to force B+Tree index page splits
      const domain = 'long-subdomain-for-btree-split-testing.example.org';
      await expect(
        db.transaction(async (tx) => {
          for (let i = 6; i <= 125; i++) {
            await tx.insert('subscribers', {
              id: i,
              email: `tx_user_${i}_${domain}`,
            });
          }
          throw new Error('Rollback after B+Tree index splits');
        }),
      ).rejects.toThrow('Rollback after B+Tree index splits');

      // 1. Pre-existing index lookups must still work
      const seed3 = await db.from('subscribers').where('email', '=', 'seed_3@example.com').toArray();
      expect(seed3).toHaveLength(1);
      expect(seed3[0]).toMatchObject({ id: 3, email: 'seed_3@example.com' });

      // 2. Rolled-back index keys must not be found via index scan
      const ghost = await db.from('subscribers').where('email', '=', `tx_user_50_${domain}`).toArray();
      expect(ghost).toHaveLength(0);

      // 3. Re-inserting one of the rolled-back unique keys must succeed without false duplicate errors
      await db.insert('subscribers', { id: 6, email: `tx_user_50_${domain}` });
      const reinserted = await db.from('subscribers').where('email', '=', `tx_user_50_${domain}`).toArray();
      expect(reinserted).toHaveLength(1);
      expect(reinserted[0]).toMatchObject({ id: 6 });
    });

    it('serializes multiple concurrent transactions launched via Promise.all with mixed commits and aborts', async () => {
      await db.createTable('parallel_jobs', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'worker', type: 'INT32' },
        { name: 'step', type: 'INT32' },
      ]);

      // Launch 8 concurrent transactions simultaneously:
      // Even workers (0, 2, 4, 6) commit 3 rows each across async delays.
      // Odd workers (1, 3, 5, 7) insert 3 rows across async delays and then abort.
      const tasks = Array.from({ length: 8 }, (_, workerId) =>
        db.transaction(async (tx) => {
          for (let step = 1; step <= 3; step++) {
            await new Promise((r) => setTimeout(r, 2));
            await tx.insert('parallel_jobs', {
              id: workerId * 100 + step,
              worker: workerId,
              step,
            });
          }
          if (workerId % 2 === 1) {
            throw new Error(`Worker ${workerId} aborted`);
          }
          return workerId;
        }),
      );

      const results = await Promise.allSettled(tasks);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(4);
      expect(rejected).toHaveLength(4);

      const rows = await db.from('parallel_jobs').orderBy('id', 'asc').toArray();
      // 4 committed workers * 3 rows = 12 rows; 0 rows from odd workers
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect((row.worker as number) % 2).toBe(0);
      }
    });

    it('discards corrupt WAL headers and stops at out-of-sequence frameSeq frames during recovery', async () => {
      await db.createTable('audit', [
        { name: 'id', type: 'INT32', flags: { primaryKey: true } },
        { name: 'status', type: 'TEXT' },
      ]);
      await db.insert('audit', { id: 1, status: 'intact_base' });
      await db.checkpoint();

      const table = await db.getTable('audit');
      const rootPageId = table.rootPageId;
      const basePage = await vfs.readPage(rootPageId);
      await db.close();

      // Case A: Corrupt WAL file header while .db is intact (e.g. power loss while creating .wal header)
      const badHeader = new Uint8Array(32);
      badHeader[0] = 0xDE;
      badHeader[1] = 0xAD;
      await vfs.writeWalHeader(badHeader);
      await vfs.appendWalFrames([new Uint8Array(WAL_PAGE_SIZE + 32)]);

      const dbAfterBadHeader = await WebDB.open({ vfs });
      expect(await vfs.getWalFrameCount()).toBe(0);
      expect(await dbAfterBadHeader.from('audit').toArray()).toEqual([
        { id: 1, status: 'intact_base' },
      ]);
      await dbAfterBadHeader.close();

      // Case B: Valid WAL header + committed Tx 1 (frameSeq 1, 2), followed by stale Tx 2 with out-of-sequence frameSeq (99, 100)
      await vfs.writeWalHeader(encodeWalFileHeader({ checkpointSeq: 2 }));

      const pageTx1 = new Uint8Array(basePage!);
      pageTx1[100] = 0x11;
      const chk1 = computePageChecksum(pageTx1);
      new DataView(pageTx1.buffer, pageTx1.byteOffset).setUint32(12, chk1, true);

      const f1 = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 1,
          pageId: rootPageId,
          dbSizePages: 2,
          frameSeq: 1,
        },
        pageTx1,
      );
      const f2 = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 1,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 2,
      });

      const pageStaleTx2 = new Uint8Array(basePage!);
      pageStaleTx2[100] = 0x99;
      const chk2 = computePageChecksum(pageStaleTx2);
      new DataView(pageStaleTx2.buffer, pageStaleTx2.byteOffset).setUint32(12, chk2, true);

      const fStaleData = encodeWalFrame(
        {
          frameType: WAL_FRAME_TYPE_PAGE_DATA,
          flags: 0,
          txId: 2,
          pageId: rootPageId,
          dbSizePages: 2,
          frameSeq: 99, // Out of sequence!
        },
        pageStaleTx2,
      );
      const fStaleCommit = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 2,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 100,
      });

      await vfs.appendWalFrames([f1, f2, fStaleData, fStaleCommit]);

      const dbAfterStaleSeq = await WebDB.open({ vfs });
      const recoveredPage = await vfs.readPage(rootPageId);
      // Must have replayed Tx 1 (0x11) and halted before out-of-sequence Tx 2 (0x99)
      expect(recoveredPage![100]).toBe(0x11);
      await dbAfterStaleSeq.close();
    });

    it('verifies OpfsVfsAdapter WAL operations, partial truncation (frameIndex > 0), and crash recovery', async () => {
      // Create an in-memory mock of OPFS FileSystemDirectoryHandle / FileSystemFileHandle
      const files = new Map<string, Uint8Array>();
      const makeFileHandle = (name: string) => ({
        async getFile() {
          const buf = files.get(name) ?? new Uint8Array(0);
          return {
            size: buf.byteLength,
            slice(start: number, end: number) {
              const sliced = buf.slice(start, end);
              return {
                async arrayBuffer() {
                  return sliced.buffer.slice(
                    sliced.byteOffset,
                    sliced.byteOffset + sliced.byteLength,
                  );
                },
              };
            },
          };
        },
        async createWritable(opts?: { keepExistingData?: boolean }) {
          let working = opts?.keepExistingData
            ? new Uint8Array(files.get(name) ?? new Uint8Array(0))
            : new Uint8Array(0);
          let cursor = 0;
          return {
            async seek(pos: number) {
              cursor = pos;
            },
            async write(data: Uint8Array) {
              const needed = cursor + data.byteLength;
              if (needed > working.byteLength) {
                const grown = new Uint8Array(needed);
                grown.set(working);
                working = grown;
              }
              working.set(data, cursor);
              cursor += data.byteLength;
            },
            async truncate(newSize: number) {
              if (newSize <= working.byteLength) {
                working = working.slice(0, newSize);
              } else {
                const grown = new Uint8Array(newSize);
                grown.set(working);
                working = grown;
              }
            },
            async close() {
              files.set(name, working);
            },
          };
        },
      });

      const prevStorage = globalThis.navigator?.storage;
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          storage: {
            async getDirectory() {
              return {
                async getFileHandle(name: string) {
                  if (!files.has(name)) files.set(name, new Uint8Array(0));
                  return makeFileHandle(name);
                },
              };
            },
          },
        },
        configurable: true,
        writable: true,
      });

      try {
        const opfs = new OpfsVfsAdapter('test_opfs_wal');
        const opfsDb = await WebDB.open({ vfs: opfs });

        await opfsDb.createTable('opfs_items', [
          { name: 'id', type: 'INT32', flags: { primaryKey: true } },
          { name: 'name', type: 'TEXT' },
        ]);

        // Commit Tx 1
        await opfsDb.transaction(async (tx) => {
          await tx.insert('opfs_items', { id: 1, name: 'Committed_1' });
        });

        const framesAfterTx1 = await opfs.getWalFrameCount();
        expect(framesAfterTx1).toBeGreaterThan(0);

        // Append an extra dummy frame and test partial truncateWal(framesAfterTx1)
        await opfs.appendWalFrames([new Uint8Array(4128)]);
        expect(await opfs.getWalFrameCount()).toBe(framesAfterTx1 + 1);
        await opfs.truncateWal(framesAfterTx1);
        expect(await opfs.getWalFrameCount()).toBe(framesAfterTx1);

        // Simulate abrupt crash on OPFS (reopen without closing opfsDb)
        const opfsRecovered = await WebDB.open({ vfs: new OpfsVfsAdapter('test_opfs_wal') });
        const rows = await opfsRecovered.from('opfs_items').toArray();
        expect(rows).toEqual([{ id: 1, name: 'Committed_1' }]);
        await opfsRecovered.close();
      } finally {
        if (prevStorage !== undefined) {
          Object.defineProperty(globalThis, 'navigator', {
            value: { storage: prevStorage },
            configurable: true,
            writable: true,
          });
        }
      }
    });
  });
});
