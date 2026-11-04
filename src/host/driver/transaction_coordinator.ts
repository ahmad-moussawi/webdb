import { IVfsAdapter } from '../storage/vfs.js';
import { Io } from '../storage/io.js';
import { BufferPoolDriver } from './buffer_pool_driver.js';
import { recoverFromWal } from './crash_recovery.js';
import {
  decodeWalFileHeader,
  encodeWalFileHeader,
  encodeWalFrame,
  validateWalFrame,
} from '../storage/wal_codec.js';
import {
  HEADER_OFFSET_CHANGE_COUNTER,
  HEADER_OFFSET_SCHEMA_VERSION,
  HEADER_OFFSET_TOTAL_PAGES,
  WAL_FRAME_HEADER_SIZE,
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
 * Enforces the Exclusive Transaction Lease across asynchronous JavaScript microtask boundaries
 * and across concurrent browser tabs via the Web Locks API (navigator.locks).
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

  private crossTabLockName?: string;
  private onSyncCrossTab?: () => Promise<void>;
  private releaseWebLock: (() => void) | null = null;

  constructor(crossTabLockName?: string, onSyncCrossTab?: () => Promise<void>) {
    this.crossTabLockName = crossTabLockName;
    this.onSyncCrossTab = onSyncCrossTab;
  }

  hasWebLocks(): boolean {
    return (
      !!this.crossTabLockName &&
      typeof navigator !== 'undefined' &&
      typeof navigator?.locks?.request === 'function'
    );
  }

  private async acquireWebLock(): Promise<void> {
    if (!this.hasWebLocks() || this.releaseWebLock) return;
    await new Promise<void>((resolveAcquired) => {
      navigator.locks
        .request(this.crossTabLockName!, { mode: 'exclusive' }, () => {
          return new Promise<void>((resolveRelease) => {
            this.releaseWebLock = resolveRelease;
            resolveAcquired();
          });
        })
        .catch(() => {
          resolveAcquired();
        });
    });
  }

  private releaseCurrentWebLock(): void {
    if (this.releaseWebLock) {
      const rel = this.releaseWebLock;
      this.releaseWebLock = null;
      rel();
    }
  }

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

    // If an exclusive transaction lease is active, there are pending transaction waiters,
    // or (in cross-tab Web Locks mode) another non-tx task is currently holding the lock,
    // queue the external task in FIFO order.
    if (
      this.activeLease ||
      this.leaseWaiters.length > 0 ||
      (this.hasWebLocks() && this.inFlightNonTxCount > 0)
    ) {
      return new Promise<T>((resolve, reject) => {
        this.queue.push(async () => {
          this.inFlightNonTxCount++;
          try {
            if (this.hasWebLocks() && this.inFlightNonTxCount === 1) {
              await this.acquireWebLock();
              if (this.onSyncCrossTab) {
                await this.onSyncCrossTab();
              }
            }
            const res = await task();
            resolve(res);
          } catch (err) {
            reject(err);
          } finally {
            this.inFlightNonTxCount--;
            if (this.inFlightNonTxCount === 0 && !this.activeLease) {
              this.releaseCurrentWebLock();
            }
            this.drain();
          }
        });
      });
    }

    // Fast-path: no active lease or waiters; run immediately
    this.inFlightNonTxCount++;
    try {
      if (this.hasWebLocks() && this.inFlightNonTxCount === 1) {
        await this.acquireWebLock();
        if (this.onSyncCrossTab) {
          await this.onSyncCrossTab();
        }
      }
      return await task();
    } finally {
      this.inFlightNonTxCount--;
      if (this.inFlightNonTxCount === 0 && !this.activeLease) {
        this.releaseCurrentWebLock();
      }
      this.drain();
    }
  }

  /**
   * Acquires the Exclusive Transaction Lease.
   * Blocks until all in-flight non-transactional operations finish and acquires the cross-tab Web Lock.
   */
  async acquireExclusiveLease(): Promise<TransactionLease> {
    if (!this.activeLease && this.inFlightNonTxCount === 0 && this.queue.length === 0) {
      const lease: TransactionLease = {
        leaseId: this.nextLeaseId++,
        txId: this.nextTxId++,
        createdAt: Date.now(),
      };
      this.activeLease = lease;
      await this.acquireWebLock();
      return lease;
    }

    return new Promise<TransactionLease>((resolve) => {
      this.leaseWaiters.push({
        resolve: async (lease) => {
          await this.acquireWebLock();
          resolve(lease);
        },
      });
      this.drain();
    });
  }

  /**
   * Releases the Exclusive Transaction Lease, releases the cross-tab Web Lock, and drains pending operations.
   */
  releaseExclusiveLease(leaseId: number): void {
    if (!this.activeLease || this.activeLease.leaseId !== leaseId) {
      return;
    }
    this.activeLease = null;
    this.releaseCurrentWebLock();
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
    while (
      this.queue.length > 0 &&
      !this.activeLease &&
      this.leaseWaiters.length === 0 &&
      (!this.hasWebLocks() || this.inFlightNonTxCount === 0)
    ) {
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
  private queue: ExclusiveLeaseQueue;

  private activeLease: TransactionLease | null = null;
  private snapshotFrameCount = 0;
  private snapshotWalFrameSeq = 0;
  private slotSnapshots = new Map<number, { pageId: number; dirty: boolean; data: Uint8Array }>();
  private pinCountsSnapshot: Uint32Array | null = null;
  private spilledPages = new Map<number, Uint8Array>();
  private committedWalPages = new Map<number, Uint8Array>();
  private walFrameSeq = 0;
  private txCommitCount = 0;
  private checkpointSeq = 0;

  // Cross-tab state tracking
  private instanceSalt = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  private expectedWalFrameCount = 0;
  private lastDiskChangeCounter = 0;
  private lastDiskSchemaVersion = 0;
  private onCrossTabInvalidated?: () => Promise<void>;

  // Inactivity idle checkpoint timer (5 seconds)
  private idleTimer: any = null;
  private isClosed = false;

  constructor(
    vfs: IVfsAdapter,
    pool: BufferPoolDriver,
    io: Io,
    crossTabLockName?: string,
  ) {
    this.vfs = vfs;
    this.pool = pool;
    this.io = io;
    this.queue = new ExclusiveLeaseQueue(
      crossTabLockName,
      () => this.syncCrossTabState(),
    );
  }

  setOnCrossTabInvalidated(cb: () => Promise<void>): void {
    this.onCrossTabInvalidated = cb;
  }

  recordDiskPage1State(): void {
    const view = this.pool.getSlotDataView(0);
    this.lastDiskChangeCounter = view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
    this.lastDiskSchemaVersion = view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
  }

  private async reloadFromDisk(
    diskPage1: Uint8Array,
    diskChangeCounter: number,
    diskSchemaVersion: number,
  ): Promise<void> {
    this.pool.getPageBytesInSlot(0).set(diskPage1);
    this.pool.clearDirty(0);
    this.lastDiskChangeCounter = diskChangeCounter;
    this.lastDiskSchemaVersion = diskSchemaVersion;

    for (let slot = 1; slot < this.pool.slotCount; slot++) {
      this.pool.unassignSlot(slot);
      this.pool.clearDirty(slot);
      this.pool.pin_counts[slot] = 0;
    }
    this.pool.pin_counts[0] = 1;

    if (this.onCrossTabInvalidated) {
      await this.onCrossTabInvalidated();
    }
  }

  async syncCrossTabState(force: boolean = false): Promise<void> {
    if (!force && !this.queue.hasWebLocks()) return;

    const walFrameCount = await this.vfs.getWalFrameCount();
    let walTouchedByOtherTab = false;

    if (walFrameCount > 0) {
      const headerBytes = await this.vfs.readWalHeader();
      let headerSalt = 0;
      if (headerBytes) {
        try {
          headerSalt = decodeWalFileHeader(headerBytes, true).salt1;
        } catch {
          headerSalt = 0;
        }
      }
      if (headerSalt !== this.instanceSalt || walFrameCount !== this.expectedWalFrameCount) {
        walTouchedByOtherTab = true;
        await recoverFromWal(this.vfs);
        this.committedWalPages.clear();
        this.walFrameSeq = 0;
        this.txCommitCount = 0;
        this.expectedWalFrameCount = 0;
      }
    } else if (this.expectedWalFrameCount > 0) {
      walTouchedByOtherTab = true;
      this.committedWalPages.clear();
      this.walFrameSeq = 0;
      this.txCommitCount = 0;
      this.expectedWalFrameCount = 0;
    }

    const [diskPage1] = await this.vfs.readPages([1]);
    if (diskPage1) {
      const diskView = new DataView(diskPage1.buffer, diskPage1.byteOffset, diskPage1.byteLength);
      const diskChangeCounter = diskView.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
      const diskSchemaVersion = diskView.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);

      if (
        walTouchedByOtherTab ||
        diskChangeCounter !== this.lastDiskChangeCounter ||
        diskSchemaVersion !== this.lastDiskSchemaVersion
      ) {
        await this.reloadFromDisk(diskPage1, diskChangeCounter, diskSchemaVersion);
      }
    }
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
    return this.spilledPages.has(pageId) || this.committedWalPages.has(pageId);
  }

  getSpilledPage(pageId: number): Uint8Array | null {
    const data = this.spilledPages.get(pageId) ?? this.committedWalPages.get(pageId);
    return data ? new Uint8Array(data) : null;
  }

  onDirectPageWrite(pageId: number, data: Uint8Array): void {
    if (this.committedWalPages.has(pageId)) {
      this.committedWalPages.set(pageId, new Uint8Array(data));
    }
    if (pageId === 1) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.lastDiskChangeCounter = view.getUint32(HEADER_OFFSET_CHANGE_COUNTER, true);
      this.lastDiskSchemaVersion = view.getUint32(HEADER_OFFSET_SCHEMA_VERSION, true);
    }
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

    this.io.stampSlotChecksum(slotIdx, pageId);

    const slotBytes = this.pool.getPageBytesInSlot(slotIdx);
    const pageCopy = new Uint8Array(WAL_PAGE_SIZE);
    pageCopy.set(slotBytes);

    this.spilledPages.set(pageId, pageCopy);

    const dbSizePages = this.pool.getSlotDataView(0).getUint32(HEADER_OFFSET_TOTAL_PAGES, true);

    // Append FRAME_TX_UNCOMMITTED frame to WAL
    const frame = encodeWalFrame(
      {
        frameType: WAL_FRAME_TYPE_TX_UNCOMMITTED,
        flags: 0,
        txId: this.activeLease.txId,
        pageId,
        dbSizePages,
        frameSeq: ++this.walFrameSeq,
      },
      pageCopy,
    );

    await this.vfs.appendWalFrames([frame]);
    this.expectedWalFrameCount = await this.vfs.getWalFrameCount();
  }

  /**
   * Captures a point-in-time snapshot of the buffer pool, spilled pages, and WAL frame count.
   * Used both at transaction BEGIN and for nested savepoints.
   */
  async captureSavepoint(): Promise<{
    frameCount: number;
    slotSnapshots: Map<number, { pageId: number; dirty: boolean; data: Uint8Array }>;
    pinCounts: Uint32Array;
    spilledPages: Map<number, Uint8Array>;
    walFrameSeq: number;
  }> {
    const frameCount = await this.vfs.getWalFrameCount();
    const slotSnapshots = new Map<number, { pageId: number; dirty: boolean; data: Uint8Array }>();
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      const pageId = this.pool.getAssignedPage(slot);
      if (pageId > 0) {
        const dirty = this.pool.isDirty(slot);
        const data = new Uint8Array(this.pool.getPageBytesInSlot(slot));
        slotSnapshots.set(slot, { pageId, dirty, data });
      }
    }
    const pinCounts = new Uint32Array(this.pool.pin_counts);
    const spilledPages = new Map<number, Uint8Array>();
    for (const [k, v] of this.spilledPages.entries()) {
      spilledPages.set(k, new Uint8Array(v));
    }
    return {
      frameCount,
      slotSnapshots,
      pinCounts,
      spilledPages,
      walFrameSeq: this.walFrameSeq,
    };
  }

  /**
   * Restores buffer pool slots, pin counts, spilled pages, and truncates WAL back to a savepoint.
   */
  async restoreSavepoint(savepoint: {
    frameCount: number;
    slotSnapshots: Map<number, { pageId: number; dirty: boolean; data: Uint8Array }>;
    pinCounts: Uint32Array;
    spilledPages: Map<number, Uint8Array>;
    walFrameSeq: number;
  }): Promise<void> {
    // Pass 1: Unassign all non-zero slots first to avoid page-to-slot collision if a page moved slots
    for (let slot = 1; slot < this.pool.slotCount; slot++) {
      this.pool.unassignSlot(slot);
      this.pool.clearDirty(slot);
    }

    // Pass 2: Restore slot assignments, page data, and dirty flags
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      const snap = savepoint.slotSnapshots.get(slot);
      if (snap) {
        this.pool.assignSlot(slot, snap.pageId);
        this.pool.getPageBytesInSlot(slot).set(snap.data);
        if (snap.dirty) {
          this.pool.markDirty(slot);
        } else {
          this.pool.clearDirty(slot);
        }
      }
    }

    // Pass 3: Restore pin counts
    this.pool.pin_counts.set(savepoint.pinCounts);

    // Restore spilled pages & WAL length
    this.spilledPages.clear();
    for (const [k, v] of savepoint.spilledPages.entries()) {
      this.spilledPages.set(k, new Uint8Array(v));
    }
    this.walFrameSeq = savepoint.walFrameSeq;
    await this.vfs.truncateWal(savepoint.frameCount);
    this.expectedWalFrameCount = savepoint.frameCount;
  }

  /**
   * Begins an explicit transaction:
   * 1. Acquires exclusive lease on the async queue (and cross-tab Web Lock).
   * 2. Synchronizes cross-tab storage state if another tab modified .db / .wal.
   * 3. Snapshots resident buffer pool slots and current WAL frame count.
   * 4. Pauses idle checkpoint timer.
   */
  async begin(): Promise<TransactionLease> {
    const lease = await this.queue.acquireExclusiveLease();
    this.activeLease = lease;
    this.pauseIdleTimer();

    try {
      await this.syncCrossTabState();

      // Ensure WAL header is initialized with this instance's salt
      const currentFrames = await this.vfs.getWalFrameCount();
      const existingHeader = await this.vfs.readWalHeader();
      let headerValid = false;
      if (existingHeader && currentFrames > 0) {
        try {
          const decoded = decodeWalFileHeader(existingHeader, true);
          headerValid = decoded.salt1 === this.instanceSalt;
        } catch {
          headerValid = false;
        }
      }
      if (!headerValid) {
        await this.vfs.writeWalHeader(
          encodeWalFileHeader({
            checkpointSeq: this.checkpointSeq,
            salt1: this.instanceSalt,
          }),
        );
      }

      this.spilledPages.clear();
      const snap = await this.captureSavepoint();
      this.snapshotFrameCount = snap.frameCount;
      this.snapshotWalFrameSeq = snap.walFrameSeq;
      this.slotSnapshots = snap.slotSnapshots;
      this.pinCountsSnapshot = snap.pinCounts;

      return lease;
    } catch (err) {
      this.activeLease = null;
      this.queue.releaseExclusiveLease(lease.leaseId);
      throw err;
    }
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
    const dbSizePages = this.pool.getSlotDataView(0).getUint32(HEADER_OFFSET_TOTAL_PAGES, true);

    // Promote any spilled pages from this transaction into committedWalPages first
    for (const [pageId, data] of this.spilledPages.entries()) {
      this.committedWalPages.set(pageId, data);
    }

    // Append all resident dirty pages to WAL as FRAME_PAGE_DATA frames
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      if (this.pool.isDirty(slot)) {
        const pageId = this.pool.getAssignedPage(slot);
        if (pageId > 0) {
          this.io.stampSlotChecksum(slot, pageId);

          const pageBytes = this.pool.getPageBytesInSlot(slot);
          const pageCopy = new Uint8Array(WAL_PAGE_SIZE);
          pageCopy.set(pageBytes);

          this.committedWalPages.set(pageId, pageCopy);
          this.pool.clearDirty(slot);

          framesToAppend.push(
            encodeWalFrame(
              {
                frameType: WAL_FRAME_TYPE_PAGE_DATA,
                flags: 0,
                txId,
                pageId,
                dbSizePages,
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
        dbSizePages,
        frameSeq: ++this.walFrameSeq,
      }),
    );

    // Durably write WAL frames
    await this.vfs.appendWalFrames(framesToAppend);
    await this.vfs.flushWal?.();
    const currentFrames = await this.vfs.getWalFrameCount();
    this.expectedWalFrameCount = currentFrames;

    // Cleanup active transaction state
    this.activeLease = null;
    this.spilledPages.clear();
    this.slotSnapshots.clear();
    this.pinCountsSnapshot = null;
    this.txCommitCount++;

    // Release lease to unblock queued external operations
    this.queue.releaseExclusiveLease(leaseId);
    this.scheduleIdleTimer();

    // Check passive checkpoint size trigger (> 256 frames or 100 txs)
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

    await this.restoreSavepoint({
      frameCount: this.snapshotFrameCount,
      slotSnapshots: this.slotSnapshots,
      pinCounts: this.pinCountsSnapshot ?? new Uint32Array(this.pool.pin_counts),
      spilledPages: new Map(),
      walFrameSeq: this.snapshotWalFrameSeq,
    });

    this.activeLease = null;
    this.spilledPages.clear();
    this.slotSnapshots.clear();
    this.pinCountsSnapshot = null;

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

  async executeCheckpoint(): Promise<{ pagesWritten: number }> {
    const frameCount = await this.vfs.getWalFrameCount();

    // 1. Scan WAL frames chronologically
    const walIndex = new Map<number, Uint8Array>();
    if (frameCount > 0) {
      const rawFrames = await this.vfs.readWalFrames(0, frameCount);
      const txGroups = new Map<number, Array<{ pageId: number; data: Uint8Array }>>();
      const committedTxs = new Set<number>();

      for (const frameBytes of rawFrames) {
        const validation = validateWalFrame(frameBytes);
        if (!validation.valid || !validation.header) {
          break;
        }
        const { frameType, txId, pageId } = validation.header;

        if (!txGroups.has(txId)) txGroups.set(txId, []);

        if (frameType === WAL_FRAME_TYPE_TX_COMMIT) {
          committedTxs.add(txId);
        } else if (
          frameType === WAL_FRAME_TYPE_PAGE_DATA ||
          frameType === WAL_FRAME_TYPE_TX_UNCOMMITTED
        ) {
          const pageData = new Uint8Array(
            frameBytes.buffer,
            frameBytes.byteOffset + WAL_FRAME_HEADER_SIZE,
            WAL_PAGE_SIZE,
          );
          const copy = new Uint8Array(WAL_PAGE_SIZE);
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

    for (const [pageId, data] of this.committedWalPages.entries()) {
      walIndex.set(pageId, data);
    }

    // 2. Inspect resident dirty slots in memory (memory_override)
    const memoryOverride = new Map<number, { slotIdx: number; data: Uint8Array }>();
    for (let slot = 0; slot < this.pool.slotCount; slot++) {
      if (this.pool.isDirty(slot)) {
        const pageId = this.pool.getAssignedPage(slot);
        if (pageId > 0) {
          this.io.stampSlotChecksum(slot, pageId);
          const pageData = this.pool.getPageBytesInSlot(slot);
          const copy = new Uint8Array(WAL_PAGE_SIZE);
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
    await this.vfs.flush?.();

    // 5. Strictly AFTER flush succeeds, reset WAL to 0 and clear in-memory WAL page cache
    await this.vfs.truncateWal(0);
    this.committedWalPages.clear();

    // Increment checkpoint counter and re-write clean WAL file header
    this.checkpointSeq++;
    this.walFrameSeq = 0;
    this.txCommitCount = 0;
    this.expectedWalFrameCount = 0;
    this.recordDiskPage1State();
    await this.vfs.writeWalHeader(
      encodeWalFileHeader({
        checkpointSeq: this.checkpointSeq,
        salt1: this.instanceSalt,
      }),
    );

    return { pagesWritten: pagesToWrite.length };
  }

  async resetWalAfterImport(): Promise<void> {
    this.spilledPages.clear();
    this.committedWalPages.clear();
    await this.vfs.truncateWal(0);
    this.checkpointSeq++;
    this.walFrameSeq = 0;
    this.txCommitCount = 0;
    this.expectedWalFrameCount = 0;
    this.recordDiskPage1State();
    await this.vfs.writeWalHeader(
      encodeWalFileHeader({
        checkpointSeq: this.checkpointSeq,
        salt1: this.instanceSalt,
      }),
    );
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
