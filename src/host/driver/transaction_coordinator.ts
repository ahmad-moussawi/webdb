import { IVfsAdapter } from '../storage/vfs.js';
import { Io } from '../storage/io.js';
import { BufferPoolDriver } from './buffer_pool_driver.js';
import {
  encodeWalFileHeader,
  encodeWalFrame,
} from '../storage/wal_codec.js';
import {
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
  WAL_FRAME_TYPE_TX_UNCOMMITTED,
  WAL_PAGE_SIZE,
} from '../../constants.js';

export interface TransactionLease {
  readonly leaseId: number;
  readonly txId: number;
  readonly createdAt: number;
}

/**
 * Enforces the Exclusive Transaction Lease across asynchronous JavaScript microtask boundaries.
 * While an exclusive lease is held by an active transaction, all external queries, mutations,
 * and checkpoint requests are strictly enqueued in FIFO order.
 */
export class ExclusiveLeaseQueue {
  private activeLease: TransactionLease | null = null;
  private inFlightNonTxCount = 0;
  private queue: Array<() => Promise<void>> = [];
  private leaseWaiters: Array<{ resolve: (lease: TransactionLease) => void }> = [];
  private nextLeaseId = 1;
  private nextTxId = 1;

  get isLeased(): boolean {
    return this.activeLease !== null;
  }

  get currentLease(): TransactionLease | null {
    return this.activeLease;
  }

  /**
   * Enqueues or dispatches a task through the FIFO coordinator.
   * If task belongs to the active lease, it executes immediately without queuing.
   */
  async enqueue<T>(task: () => Promise<T>, leaseId?: number): Promise<T> {
    // If this call belongs to the active transaction lease, dispatch immediately!
    if (this.activeLease && leaseId === this.activeLease.leaseId) {
      return task();
    }

    // If an exclusive transaction lease is active or there are pending transaction waiters,
    // queue the external task in FIFO order until the lease is released.
    if (this.activeLease || this.leaseWaiters.length > 0) {
      return new Promise<T>((resolve, reject) => {
        this.queue.push(async () => {
          this.inFlightNonTxCount++;
          try {
            const res = await task();
            resolve(res);
          } catch (err) {
            reject(err);
          } finally {
            this.inFlightNonTxCount--;
            this.drain();
          }
        });
      });
    }

    // Fast-path: no active lease or waiters; run immediately
    this.inFlightNonTxCount++;
    try {
      return await task();
    } finally {
      this.inFlightNonTxCount--;
      this.drain();
    }
  }

  /**
   * Acquires the Exclusive Transaction Lease.
   * Blocks until all in-flight non-transactional operations finish.
   */
  async acquireExclusiveLease(): Promise<TransactionLease> {
    if (!this.activeLease && this.inFlightNonTxCount === 0 && this.queue.length === 0) {
      const lease: TransactionLease = {
        leaseId: this.nextLeaseId++,
        txId: this.nextTxId++,
        createdAt: Date.now(),
      };
      this.activeLease = lease;
      return lease;
    }

    return new Promise<TransactionLease>((resolve) => {
      this.leaseWaiters.push({
        resolve: (lease) => resolve(lease),
      });
      this.drain();
    });
  }

  /**
   * Releases the Exclusive Transaction Lease and drains pending operations in FIFO order.
   */
  releaseExclusiveLease(leaseId: number): void {
    if (!this.activeLease || this.activeLease.leaseId !== leaseId) {
      return;
    }
    this.activeLease = null;
    this.drain();
  }

  private drain(): void {
    if (this.activeLease) {
      return;
    }

    // If there is a transaction waiter waiting to acquire the lease:
    if (this.leaseWaiters.length > 0) {
      // Must wait until all current in-flight non-tx queries finish
      if (this.inFlightNonTxCount === 0) {
        const waiter = this.leaseWaiters.shift()!;
        const lease: TransactionLease = {
          leaseId: this.nextLeaseId++,
          txId: this.nextTxId++,
          createdAt: Date.now(),
        };
        this.activeLease = lease;
        waiter.resolve(lease);
      }
      return;
    }

    // Drain queued external non-transaction tasks
    while (this.queue.length > 0 && !this.activeLease && this.leaseWaiters.length === 0) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        nextTask();
      }
    }
  }
}

/**
 * TransactionCoordinator orchestrates:
 * 1. Exclusive Transaction Lease & FIFO async dispatch.
 * 2. Write-Ahead Log (WAL) frame generation & durability flush on COMMIT.
 * 3. Cache spilling of uncommitted pages under memory pressure (FRAME_TX_UNCOMMITTED).
 * 4. Zero-mutation rollback on abort (memory restoration & WAL truncation).
 * 5. Deduplicated Monotonic Checkpointing to synchronize main storage.
 */
export class TransactionCoordinator {
  private vfs: IVfsAdapter;
  private pool: BufferPoolDriver;
  private io: Io;
  private queue = new ExclusiveLeaseQueue();

  private activeLease: TransactionLease | null = null;
  private snapshotFrameCount = 0;
  private slotSnapshots = new Map<number, { pageId: number; dirty: boolean; data: Uint8Array }>();
  private spilledPages = new Map<number, Uint8Array>();
  private walFrameSeq = 0;
  private txCommitCount = 0;
  private checkpointSeq = 0;

  // Inactivity idle checkpoint timer (5 seconds)
  private idleTimer: any = null;
  private isClosed = false;

  constructor(vfs: IVfsAdapter, pool: BufferPoolDriver, io: Io) {
    this.vfs = vfs;
    this.pool = pool;
    this.io = io;
  }

  get leaseQueue(): ExclusiveLeaseQueue {
    return this.queue;
  }

  isInTransaction(): boolean {
    return this.activeLease !== null;
  }

  getActiveLeaseId(): number | null {
    return this.activeLease ? this.activeLease.leaseId : null;
  }

  getActiveTxId(): number | null {
    return this.activeLease ? this.activeLease.txId : null;
  }

  hasSpilledPage(pageId: number): boolean {
    return this.spilledPages.has(pageId);
  }

  getSpilledPage(pageId: number): Uint8Array | null {
    const data = this.spilledPages.get(pageId);
    return data ? new Uint8Array(data) : null;
  }

  /**
   * Spills an uncommitted dirty slot to the WAL under cache eviction pressure.
   * Frame type is set to FRAME_TX_UNCOMMITTED (0x0003).
   */
  async spillUncommittedSlot(slotIdx: number, pageId: number): Promise<void> {
    if (!this.activeLease) {
      // Not in transaction; normal write directly to storage
      await this.io.writeSlot(slotIdx, pageId);
      return;
    }

    const slotBytes = this.pool.getPageBytesInSlot(slotIdx);
    const pageCopy = new Uint8Array(WAL_PAGE_SIZE);
    pageCopy.set(slotBytes);

    this.spilledPages.set(pageId, pageCopy);

    // Append FRAME_TX_UNCOMMITTED frame to WAL
    const frame = encodeWalFrame(
      {
        frameType: WAL_FRAME_TYPE_TX_UNCOMMITTED,
        flags: 0,
        txId: this.activeLease.txId,
        pageId,
        dbSizePages: 0,
        frameSeq: ++this.walFrameSeq,
      },
      pageCopy,
    );

    await this.vfs.appendWalFrames([frame]);
  }

  /**
   * Begins an explicit transaction:
   * 1. Acquires exclusive lease on the async queue.
   * 2. Snapshots resident buffer pool slots and current WAL frame count.
   * 3. Pauses idle checkpoint timer.
   */
  async begin(): Promise<TransactionLease> {
    const lease = await this.queue.acquireExclusiveLease();
    this.activeLease = lease;
    this.pauseIdleTimer();

    // Ensure WAL header is initialized
    const existingHeader = await this.vfs.readWalHeader();
    if (!existingHeader) {
      await this.vfs.writeWalHeader(
        encodeWalFileHeader({
          checkpointSeq: this.checkpointSeq,
        }),
      );
    }

    this.snapshotFrameCount = await this.vfs.getWalFrameCount();
    this.spilledPages.clear();
    this.slotSnapshots.clear();

    // Snapshot all resident slots in the buffer pool
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      const pageId = this.pool.getAssignedPage(slot);
      if (pageId > 0) {
        const dirty = this.pool.isDirty(slot);
        const data = new Uint8Array(this.pool.getPageBytesInSlot(slot));
        this.slotSnapshots.set(slot, { pageId, dirty, data });
      }
    }

    return lease;
  }

  /**
   * Commits an active transaction:
   * 1. Collects all dirty slots in memory and appends them as FRAME_PAGE_DATA frames to the WAL.
   * 2. Appends a FRAME_TX_COMMIT marker frame.
   * 3. Calls vfs.flushWal() to establish durable commit point.
   * 4. Releases the exclusive lease.
   */
  async commit(leaseId: number): Promise<void> {
    if (!this.activeLease || this.activeLease.leaseId !== leaseId) {
      return;
    }

    const txId = this.activeLease.txId;
    const framesToAppend: Uint8Array[] = [];

    // Append all resident dirty pages to WAL as FRAME_PAGE_DATA frames
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      if (this.pool.isDirty(slot)) {
        const pageId = this.pool.getAssignedPage(slot);
        if (pageId > 0) {
          const pageBytes = this.pool.getPageBytesInSlot(slot);
          const pageCopy = new Uint8Array(WAL_PAGE_SIZE);
          pageCopy.set(pageBytes);

          framesToAppend.push(
            encodeWalFrame(
              {
                frameType: WAL_FRAME_TYPE_PAGE_DATA,
                flags: 0,
                txId,
                pageId,
                dbSizePages: 0,
                frameSeq: ++this.walFrameSeq,
              },
              pageCopy,
            ),
          );
        }
      }
    }

    // Append FRAME_TX_COMMIT marker
    framesToAppend.push(
      encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId,
        pageId: 0,
        dbSizePages: 0,
        frameSeq: ++this.walFrameSeq,
      }),
    );

    // Durably write WAL frames
    await this.vfs.appendWalFrames(framesToAppend);
    await this.vfs.flushWal();

    // Cleanup active transaction state
    this.activeLease = null;
    this.spilledPages.clear();
    this.slotSnapshots.clear();
    this.txCommitCount++;

    // Release lease to unblock queued external operations
    this.queue.releaseExclusiveLease(leaseId);
    this.scheduleIdleTimer();

    // Check passive checkpoint size trigger (> 256 frames or 100 txs)
    const currentFrames = await this.vfs.getWalFrameCount();
    if (currentFrames >= 256 || this.txCommitCount >= 100) {
      // Trigger checkpoint asynchronously in queue without blocking caller
      this.queue.enqueue(() => this.executeCheckpoint());
    }
  }

  /**
   * Rolls back an active transaction:
   * 1. Restores buffer pool slots to their snapshot state at BEGIN.
   * 2. Clears spilled uncommitted page cache.
   * 3. Truncates WAL back to the initial snapshot frame count.
   * 4. Releases the exclusive lease.
   */
  async rollback(leaseId: number): Promise<void> {
    if (!this.activeLease || this.activeLease.leaseId !== leaseId) {
      return;
    }

    // Restore buffer pool slots
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      const snap = this.slotSnapshots.get(slot);
      if (snap) {
        this.pool.assignSlot(slot, snap.pageId);
        this.pool.getPageBytesInSlot(slot).set(snap.data);
        if (snap.dirty) {
          this.pool.markDirty(slot);
        } else {
          this.pool.clearDirty(slot);
        }
      } else {
        this.pool.unassignSlot(slot);
      }
    }

    // Truncate any uncommitted spilled frames back to snapshot length
    await this.vfs.truncateWal(this.snapshotFrameCount);

    this.activeLease = null;
    this.spilledPages.clear();
    this.slotSnapshots.clear();

    this.queue.releaseExclusiveLease(leaseId);
    this.scheduleIdleTimer();
  }

  /**
   * Deduplicated Monotonic Checkpoint (Section 4.3):
   * 1. Scans committed WAL frames chronologically -> wal_index.
   * 2. Inspects resident dirty slots in memory -> memory_override.
   * 3. Merges union of unique page_ids and writes to main storage via vfs.writePages().
   * 4. Calls vfs.flush() to durably sync main disk.
   * 5. Strictly AFTER vfs.flush() succeeds, truncates WAL to 0.
   */
  async checkpoint(): Promise<{ pagesWritten: number }> {
    // Checkpointing CANNOT run while a write transaction is open.
    // Enqueue through the exclusive lease queue so it waits for lease release.
    return this.queue.enqueue(() => this.executeCheckpoint());
  }

  private async executeCheckpoint(): Promise<{ pagesWritten: number }> {
    const frameCount = await this.vfs.getWalFrameCount();

    // 1. Scan WAL frames chronologically
    const walIndex = new Map<number, Uint8Array>();
    if (frameCount > 0) {
      const rawFrames = await this.vfs.readWalFrames(0, frameCount);
      const txGroups = new Map<number, Array<{ pageId: number; data: Uint8Array }>>();
      const committedTxs = new Set<number>();

      for (const frameBytes of rawFrames) {
        if (frameBytes.byteLength < 4128) break;
        const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
        const magic = view.getUint32(0, true);
        if (magic !== 0x57414c46) break;

        const frameType = view.getUint16(4, true);
        const txId = view.getUint32(8, true);
        const pageId = view.getUint32(12, true);

        if (!txGroups.has(txId)) txGroups.set(txId, []);

        if (frameType === WAL_FRAME_TYPE_TX_COMMIT) {
          committedTxs.add(txId);
        } else if (frameType === WAL_FRAME_TYPE_PAGE_DATA) {
          const pageData = new Uint8Array(frameBytes.buffer, frameBytes.byteOffset + 32, 4096);
          const copy = new Uint8Array(4096);
          copy.set(pageData);
          txGroups.get(txId)!.push({ pageId, data: copy });
        }
      }

      for (const [txId, frames] of txGroups.entries()) {
        if (committedTxs.has(txId)) {
          for (const f of frames) {
            if (f.pageId > 0) {
              walIndex.set(f.pageId, f.data);
            }
          }
        }
      }
    }

    // 2. Inspect resident dirty slots in memory (memory_override)
    const memoryOverride = new Map<number, { slotIdx: number; data: Uint8Array }>();
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      if (this.pool.isDirty(slot)) {
        const pageId = this.pool.getAssignedPage(slot);
        if (pageId > 0) {
          const pageData = this.pool.getPageBytesInSlot(slot);
          const copy = new Uint8Array(4096);
          copy.set(pageData);
          memoryOverride.set(pageId, { slotIdx: slot, data: copy });
        }
      }
    }

    // 3. Union of unique page IDs: memory overrides WAL
    const allPageIds = new Set<number>([
      ...walIndex.keys(),
      ...memoryOverride.keys(),
    ]);

    const pagesToWrite: Array<{ pageId: number; data: Uint8Array }> = [];
    for (const pageId of allPageIds) {
      if (memoryOverride.has(pageId)) {
        const { slotIdx, data } = memoryOverride.get(pageId)!;
        pagesToWrite.push({ pageId, data });
        this.pool.clearDirty(slotIdx);
      } else {
        pagesToWrite.push({ pageId, data: walIndex.get(pageId)! });
      }
    }

    if (pagesToWrite.length > 0) {
      pagesToWrite.sort((a, b) => a.pageId - b.pageId);
      await this.vfs.writePages(pagesToWrite);
    }

    // 4. Durably flush main storage
    await this.vfs.flush();

    // 5. Strictly AFTER flush succeeds, reset WAL to 0
    await this.vfs.truncateWal(0);

    // Increment checkpoint counter and re-write clean WAL file header
    this.checkpointSeq++;
    this.walFrameSeq = 0;
    this.txCommitCount = 0;
    await this.vfs.writeWalHeader(
      encodeWalFileHeader({
        checkpointSeq: this.checkpointSeq,
      }),
    );

    return { pagesWritten: pagesToWrite.length };
  }

  private scheduleIdleTimer(): void {
    if (this.isClosed) return;
    this.pauseIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.checkpoint().catch(() => {});
    }, 5000);
  }

  private pauseIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.pauseIdleTimer();
    // Execute final clean checkpoint before closing handles
    await this.checkpoint();
  }
}
