import {
  PAGE_SIZE,
  SLOTS_BASE_OFFSET,
  PAGE_HEADER_OFFSET_CHECKSUM,
  HEADER_OFFSET_PAGE_CHECKSUM,
} from "../../constants.ts";
import { IVfsAdapter } from "./vfs.ts";
import { computePageChecksum, computePage1Checksum } from "./crc32.ts";
import { CorruptPageError } from "../../types/index.ts";
import { read_u32, write_u32 } from "../../shared/c_runtime.ts";

export interface IoOptions {
  vfs: IVfsAdapter;
  memory: WebAssembly.Memory | ArrayBuffer;
  slotsBaseOffset?: number;
}

/**
 * Pure Block I/O layer for WebDB.
 *
 * Responsibilities:
 * - Reads/writes raw 4KB page blocks between IVfsAdapter and shared linear memory.
 * - Computes and verifies CRC32 checksums.
 * - Coalesces in-flight reads and flushes.
 * - Resolves PAGE_FAULT requests issued by the C Engine state machine.
 *
 * DOES NOT:
 * - Perform eviction candidate selection or Clock sweeps (handled in C Core).
 * - Maintain page-to-slot tables, pin counts, or reference bits (handled in C Core).
 * - Hold any reference to C-layer classes.
 */
export class Io {
  readonly vfs: IVfsAdapter;
  readonly buffer: ArrayBuffer;
  readonly uint8: Uint8Array;
  readonly view: DataView;
  readonly slotsBaseOffset: number;

  private in_flight_flushes = new Map<number, Promise<void>>();
  private in_flight_reads = new Map<number, Promise<Uint8Array | null>>();
  private page_write_generations = new Map<number, number>();
  private coordinator: {
    isInTransaction(): boolean;
    spillUncommittedSlot(slotIdx: number, pageId: number): Promise<void>;
    hasSpilledPage(pageId: number): boolean;
    getSpilledPage(pageId: number): Uint8Array | null;
    onDirectPageWrite(pageId: number, data: Uint8Array): void;
    hasCommittedWalPage(pageId: number): boolean;
    commitDirectPagesViaWal(
      pages: Array<{ pageId: number; data: Uint8Array }>,
    ): Promise<void>;
  } | null = null;

  setTransactionCoordinator(coordinator: any): void {
    this.coordinator = coordinator;
  }

  /**
   * True when an autocommit flush of these pages must go through the WAL: at least one of them
   * still has an older committed image in the WAL.
   */
  shouldWriteThroughWal(pageIds: number[]): boolean {
    const c = this.coordinator;
    return !!c && !c.isInTransaction() && pageIds.some((id) => c.hasCommittedWalPage(id));
  }

  /**
   * Waits until a full synchronous check finds no in-flight flushes for any pageId in the batch.
   * Ensures no earlier page in the batch gained a new in-flight flush while waiting on a later page.
   */
  private async awaitBatchInFlightFlushes(pageIds: number[]): Promise<void> {
    let pending: Promise<void>[];
    do {
      pending = [];
      for (const pageId of pageIds) {
        const inflight = this.in_flight_flushes.get(pageId);
        if (inflight) {
          pending.push(inflight);
        }
      }
      if (pending.length > 0) {
        await Promise.all(pending);
      }
    } while (pending.length > 0);
  }

  private bumpPageWriteGen(pageId: number): void {
    this.page_write_generations.set(
      pageId,
      (this.page_write_generations.get(pageId) ?? 0) + 1,
    );
    this.in_flight_reads.delete(pageId);
  }

  /** Atomically logs several slots to the WAL as one committed mini-transaction. */
  async writeSlotsViaWal(slots: Array<{ slotIdx: number; pageId: number }>): Promise<void> {
    if (slots.length === 0) return;
    const pageIds: number[] = [];
    for (const { pageId } of slots) {
      if (pageId <= 0) {
        throw new Error(
          `Invalid page ID: ${pageId}. Page IDs must be positive integers.`,
        );
      }
      pageIds.push(pageId);
    }
    await this.awaitBatchInFlightFlushes(pageIds);

    const pages = slots.map(({ slotIdx, pageId }) => {
      this.stampSlotChecksum(slotIdx, pageId);
      const offset = this.slotsBaseOffset + slotIdx * PAGE_SIZE;
      return { pageId, data: this.uint8.slice(offset, offset + PAGE_SIZE) };
    });

    const wal_promise = this.coordinator!.commitDirectPagesViaWal(pages);
    for (const { pageId } of pages) {
      this.bumpPageWriteGen(pageId);
      this.in_flight_flushes.set(pageId, wal_promise);
    }
    try {
      await wal_promise;
    } finally {
      for (const { pageId } of pages) {
        if (this.in_flight_flushes.get(pageId) === wal_promise) {
          this.in_flight_flushes.delete(pageId);
        }
      }
    }
  }

  isInTransaction(): boolean {
    return this.coordinator ? this.coordinator.isInTransaction() : false;
  }

  /**
   * Computes and writes the page-level CRC32 checksum into the slot header in linear memory.
   */
  stampSlotChecksum(slotIdx: number, pageId: number): void {
    const slot_offset = this.slotsBaseOffset + slotIdx * PAGE_SIZE;
    const page_bytes = this.uint8.subarray(
      slot_offset,
      slot_offset + PAGE_SIZE,
    );

    if (pageId === 1) {
      const chk = computePage1Checksum(page_bytes);
      write_u32(this.view, slot_offset + HEADER_OFFSET_PAGE_CHECKSUM, chk);
    } else {
      const chk = computePageChecksum(page_bytes);
      write_u32(this.view, slot_offset + PAGE_HEADER_OFFSET_CHECKSUM, chk);
    }
  }

  constructor(options: IoOptions) {
    if (!options.vfs) {
      throw new Error("Io requires a valid IVfsAdapter instance");
    }

    if (!options.memory) {
      throw new Error(
        "Io requires a valid memory buffer or WebAssembly.Memory",
      );
    }

    this.vfs = options.vfs;

    this.buffer =
      options.memory instanceof WebAssembly.Memory
        ? options.memory.buffer
        : options.memory;

    this.uint8 = new Uint8Array(this.buffer);
    this.view = new DataView(this.buffer);
    this.slotsBaseOffset = options.slotsBaseOffset ?? SLOTS_BASE_OFFSET;
  }

  /**
   * Checks whether `pageId` currently has an uncommitted spill or uncheckpointed WAL image.
   */
  hasSpilledOrCommittedPage(pageId: number): boolean {
    return !!this.coordinator && this.coordinator.hasSpilledPage(pageId);
  }

  hasInFlightFlush(pageId: number): boolean {
    return this.in_flight_flushes.has(pageId);
  }

  hasInFlightRead(pageId: number): boolean {
    return this.in_flight_reads.has(pageId);
  }

  private validateDiskPage(
    pageId: number,
    disk_page: Uint8Array | null,
  ): Uint8Array | null {
    if (!disk_page) {
      return null;
    }

    if (disk_page.byteLength !== PAGE_SIZE) {
      throw new CorruptPageError(
        pageId,
        `Unexpected page byte length: ${disk_page.byteLength}, expected ${PAGE_SIZE}`,
      );
    }

    // Verify CRC32 checksum
    const checksum_offset =
      pageId === 1
        ? HEADER_OFFSET_PAGE_CHECKSUM
        : PAGE_HEADER_OFFSET_CHECKSUM;

    const stored_checksum = read_u32(
      new DataView(disk_page.buffer, disk_page.byteOffset, disk_page.byteLength),
      checksum_offset,
    );

    if (stored_checksum !== 0) {
      const computed =
        pageId === 1
          ? computePage1Checksum(disk_page)
          : computePageChecksum(disk_page);

      if (computed !== stored_checksum) {
        throw new CorruptPageError(pageId, stored_checksum, computed);
      }
    }

    return disk_page;
  }

  /**
   * Reads a page from VFS directly into slotIdx in linear memory.
   * Validates CRC32 checksum. If page does not exist in storage, zeroes the slot.
   */
  async readSlot(slotIdx: number, pageId: number): Promise<void> {
    if (!Number.isInteger(pageId) || pageId <= 0) {
      throw new Error(
        `Invalid page ID: ${pageId}. Page IDs must be positive integers.`,
      );
    }

    const slot_offset = this.slotsBaseOffset + slotIdx * PAGE_SIZE;

    while (true) {
      // Await any in-flight flush before checking spilled/WAL state or reading VFS
      while (this.in_flight_flushes.has(pageId)) {
        await this.in_flight_flushes.get(pageId);
      }

      if (this.coordinator && this.coordinator.hasSpilledPage(pageId)) {
        const spilled = this.coordinator.getSpilledPage(pageId)!;
        this.uint8.set(spilled, slot_offset);
        return;
      }

      const genAtStart = this.page_write_generations.get(pageId) ?? 0;

      // Coalesce in-flight reads for the same pageId, validating & copying bytes into caller's slotIdx
      const in_flight_read = this.in_flight_reads.get(pageId);

      if (in_flight_read) {
        const raw_page = await in_flight_read;
        if ((this.page_write_generations.get(pageId) ?? 0) !== genAtStart) {
          continue;
        }
        const disk_page = this.validateDiskPage(pageId, raw_page);
        if (disk_page) {
          this.uint8.set(disk_page, slot_offset);
        } else {
          this.uint8.fill(0, slot_offset, slot_offset + PAGE_SIZE);
        }
        return;
      }

      const read_promise = (async (): Promise<Uint8Array | null> => {
        const [disk_page] = await this.vfs.readPages([pageId]);
        return disk_page ?? null;
      })();

      this.in_flight_reads.set(pageId, read_promise);

      try {
        const raw_page = await read_promise;
        if ((this.page_write_generations.get(pageId) ?? 0) !== genAtStart) {
          continue;
        }
        const disk_page = this.validateDiskPage(pageId, raw_page);
        if (disk_page) {
          this.uint8.set(disk_page, slot_offset);
        } else {
          this.uint8.fill(0, slot_offset, slot_offset + PAGE_SIZE);
        }
        return;
      } finally {
        if (this.in_flight_reads.get(pageId) === read_promise) {
          this.in_flight_reads.delete(pageId);
        }
      }
    }
  }

  /**
   * Batches a demand page read together with speculative read-ahead pages in a single
   * `vfs.readPages()` call. Demand-page corruption throws `CorruptPageError`; corrupt or
   * missing speculative pages are silently omitted from the returned map.
   */
  async readPagesBatch(
    pageIds: number[],
    demandPageId: number,
  ): Promise<Map<number, Uint8Array | null>> {
    if (!Number.isInteger(demandPageId) || demandPageId <= 0) {
      throw new Error(
        `Invalid page ID: ${demandPageId}. Page IDs must be positive integers.`,
      );
    }

    while (this.in_flight_flushes.has(demandPageId)) {
      await this.in_flight_flushes.get(demandPageId);
    }

    const result = new Map<number, Uint8Array | null>();
    if (this.hasSpilledOrCommittedPage(demandPageId)) {
      result.set(demandPageId, this.coordinator!.getSpilledPage(demandPageId)!);
    }

    const existingDemandGen = this.page_write_generations.get(demandPageId) ?? 0;
    const existingDemandRead = !result.has(demandPageId)
      ? this.in_flight_reads.get(demandPageId)
      : undefined;

    const vfsFetchIds: number[] = [];
    const seen = new Set<number>();
    for (const p of pageIds) {
      if (
        Number.isInteger(p) &&
        p > 0 &&
        !seen.has(p) &&
        !this.in_flight_reads.has(p) &&
        !this.in_flight_flushes.has(p) &&
        !(p === demandPageId && result.has(demandPageId))
      ) {
        seen.add(p);
        vfsFetchIds.push(p);
      }
    }

    // Trim leading/trailing spilled pages while keeping any interior spilled gaps intact
    // so contiguous ascending ranges preserve IdbStorage's IDBKeyRange fast-path.
    while (
      vfsFetchIds.length > 0 &&
      this.hasSpilledOrCommittedPage(vfsFetchIds[vfsFetchIds.length - 1])
    ) {
      vfsFetchIds.pop();
    }
    while (
      vfsFetchIds.length > 0 &&
      this.hasSpilledOrCommittedPage(vfsFetchIds[0])
    ) {
      vfsFetchIds.shift();
    }

    let rawDemand: Uint8Array | null = null;
    let hasRawDemand = false;
    const startWriteGen = new Map<number, number>();

    if (vfsFetchIds.length > 0) {
      for (const p of vfsFetchIds) {
        startWriteGen.set(p, this.page_write_generations.get(p) ?? 0);
      }

      const registered = new Map<number, Promise<Uint8Array | null>>();
      const batchReadPromise = this.vfs.readPages(vfsFetchIds);
      for (let i = 0; i < vfsFetchIds.length; i++) {
        const p = vfsFetchIds[i];
        if (!this.hasSpilledOrCommittedPage(p)) {
          const idx = i;
          const pPromise = batchReadPromise.then((arr) => arr[idx] ?? null);
          pPromise.catch(() => {});
          this.in_flight_reads.set(p, pPromise);
          registered.set(p, pPromise);
        }
      }

      let rawPages: Array<Uint8Array | null>;
      try {
        rawPages = await batchReadPromise;
      } finally {
        for (const [p, pPromise] of registered.entries()) {
          if (this.in_flight_reads.get(p) === pPromise) {
            this.in_flight_reads.delete(p);
          }
        }
      }

      for (let i = 0; i < vfsFetchIds.length; i++) {
        const p = vfsFetchIds[i];
        const raw = rawPages[i] ?? null;
        if (p === demandPageId) {
          rawDemand = raw;
          hasRawDemand = true;
          continue;
        }
        if (
          this.hasSpilledOrCommittedPage(p) ||
          this.in_flight_flushes.has(p) ||
          (this.page_write_generations.get(p) ?? 0) !== (startWriteGen.get(p) ?? 0)
        ) {
          continue;
        }
        try {
          const validated = this.validateDiskPage(p, raw);
          if (validated) {
            result.set(p, validated);
          }
        } catch {
          // Never fail a demand read because a speculative page was corrupt on disk
        }
      }
    }

    if (!result.has(demandPageId)) {
      const demandWriteGenChanged = hasRawDemand
        ? (this.page_write_generations.get(demandPageId) ?? 0) !==
          (startWriteGen.get(demandPageId) ?? 0)
        : existingDemandRead !== undefined &&
          (this.page_write_generations.get(demandPageId) ?? 0) !==
            existingDemandGen;

      if (demandWriteGenChanged) {
        while (this.in_flight_flushes.has(demandPageId)) {
          await this.in_flight_flushes.get(demandPageId);
        }
      }

      if (this.hasSpilledOrCommittedPage(demandPageId)) {
        result.set(
          demandPageId,
          this.coordinator!.getSpilledPage(demandPageId)!,
        );
      } else if (hasRawDemand && !demandWriteGenChanged) {
        result.set(
          demandPageId,
          this.validateDiskPage(demandPageId, rawDemand),
        );
      } else if (existingDemandRead && !demandWriteGenChanged) {
        const raw = await existingDemandRead;
        if (
          (this.page_write_generations.get(demandPageId) ?? 0) !==
          existingDemandGen
        ) {
          while (this.in_flight_flushes.has(demandPageId)) {
            await this.in_flight_flushes.get(demandPageId);
          }
          if (this.hasSpilledOrCommittedPage(demandPageId)) {
            result.set(
              demandPageId,
              this.coordinator!.getSpilledPage(demandPageId)!,
            );
          } else {
            const [freshRaw] = await this.vfs.readPages([demandPageId]);
            result.set(
              demandPageId,
              this.validateDiskPage(demandPageId, freshRaw ?? null),
            );
          }
        } else {
          result.set(
            demandPageId,
            this.validateDiskPage(demandPageId, raw ?? null),
          );
        }
      } else {
        const [raw] = await this.vfs.readPages([demandPageId]);
        result.set(
          demandPageId,
          this.validateDiskPage(demandPageId, raw ?? null),
        );
      }
    }

    return result;
  }

  /**
   * Writes a page from slotIdx in linear memory to VFS.
   * Computes CRC32 checksum and writes into slot header before saving snapshot.
   */
  async writeSlot(slotIdx: number, pageId: number): Promise<void> {
    if (pageId <= 0) {
      throw new Error(
        `Invalid page ID: ${pageId}. Page IDs must be positive integers.`,
      );
    }

    while (this.in_flight_flushes.has(pageId)) {
      await this.in_flight_flushes.get(pageId);
    }

    const slot_offset = this.slotsBaseOffset + slotIdx * PAGE_SIZE;
    const page_bytes = this.uint8.subarray(
      slot_offset,
      slot_offset + PAGE_SIZE,
    );

    this.stampSlotChecksum(slotIdx, pageId);

    const write_snapshot = page_bytes.slice();

    // Autocommit write of a page whose older image is still in the WAL: log the new image to
    // the WAL too, otherwise crash recovery would replay the stale WAL frame over it.
    if (
      this.coordinator &&
      !this.coordinator.isInTransaction() &&
      this.coordinator.hasCommittedWalPage(pageId)
    ) {
      this.bumpPageWriteGen(pageId);
      const wal_promise = this.coordinator.commitDirectPagesViaWal([
        { pageId, data: write_snapshot },
      ]);
      this.in_flight_flushes.set(pageId, wal_promise);
      try {
        await wal_promise;
      } finally {
        if (this.in_flight_flushes.get(pageId) === wal_promise) {
          this.in_flight_flushes.delete(pageId);
        }
      }
      return;
    }

    this.bumpPageWriteGen(pageId);
    const write_promise = this.vfs.writePages([
      { pageId, data: write_snapshot },
    ]);
    this.in_flight_flushes.set(pageId, write_promise);
    try {
      await write_promise;
      if (this.coordinator) {
        this.coordinator.onDirectPageWrite(pageId, write_snapshot);
      }
    } finally {
      if (this.in_flight_flushes.get(pageId) === write_promise) {
        this.in_flight_flushes.delete(pageId);
      }
    }
  }

  /**
   * Batches multiple dirty slots into a single `vfs.writePages()` call.
   * Preserves checksum stamping, in-flight flush serialization, and coordinator notification.
   */
  async writeSlots(
    slots: Array<{ slotIdx: number; pageId: number }>,
  ): Promise<void> {
    if (slots.length === 0) return;
    if (slots.length === 1) {
      await this.writeSlot(slots[0].slotIdx, slots[0].pageId);
      return;
    }

    if (this.shouldWriteThroughWal(slots.map((s) => s.pageId))) {
      await this.writeSlotsViaWal(slots);
      return;
    }

    const pageIds: number[] = [];
    for (const { pageId } of slots) {
      if (pageId <= 0) {
        throw new Error(
          `Invalid page ID: ${pageId}. Page IDs must be positive integers.`,
        );
      }
      pageIds.push(pageId);
    }
    await this.awaitBatchInFlightFlushes(pageIds);

    const pages: Array<{ pageId: number; data: Uint8Array }> = [];
    for (const { slotIdx, pageId } of slots) {
      const slot_offset = this.slotsBaseOffset + slotIdx * PAGE_SIZE;
      const page_bytes = this.uint8.subarray(
        slot_offset,
        slot_offset + PAGE_SIZE,
      );
      this.stampSlotChecksum(slotIdx, pageId);
      const write_snapshot = page_bytes.slice();
      pages.push({ pageId, data: write_snapshot });
    }

    pages.sort((a, b) => a.pageId - b.pageId);

    for (const { pageId } of pages) {
      this.bumpPageWriteGen(pageId);
    }
    const write_promise = this.vfs.writePages(pages);
    for (const { pageId } of pages) {
      this.in_flight_flushes.set(pageId, write_promise);
    }
    try {
      await write_promise;
      if (this.coordinator) {
        for (const { pageId, data } of pages) {
          this.coordinator.onDirectPageWrite(pageId, data);
        }
      }
    } finally {
      for (const { pageId } of pages) {
        if (this.in_flight_flushes.get(pageId) === write_promise) {
          this.in_flight_flushes.delete(pageId);
        }
      }
    }
  }

  /**
   * Spills a slot to the WAL if an active transaction is open, otherwise writes it to VFS.
   */
  async spillOrWriteSlot(slotIdx: number, pageId: number): Promise<void> {
    if (this.coordinator && this.coordinator.isInTransaction()) {
      this.bumpPageWriteGen(pageId);
      await this.coordinator.spillUncommittedSlot(slotIdx, pageId);
    } else {
      await this.writeSlot(slotIdx, pageId);
    }
  }

  /**
   * Resolves a PAGE_FAULT yielded by the C Engine state machine.
   * If flushPageId > 0, writes the victim dirty block to VFS.
   * Reads faultPageId from VFS directly into targetSlot memory.
   */
  async resolvePageFault(
    targetSlot: number,
    faultPageId: number,
    flushPageId: number,
  ): Promise<void> {
    if (flushPageId > 0) {
      await this.spillOrWriteSlot(targetSlot, flushPageId);
    }

    await this.readSlot(targetSlot, faultPageId);
  }

  /**
   * Durably flushes pending VFS adapter writes.
   */
  async flush(): Promise<void> {
    await this.vfs.flush?.();
  }
}
