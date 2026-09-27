import {
  PAGE_SIZE,
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

  private in_flight_flushes = new Map<number, Promise<void>>();
  private in_flight_reads = new Map<number, Promise<void>>();

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
  }

  /**
   * Reads a page from VFS directly into slotIdx in linear memory.
   * Validates CRC32 checksum. If page does not exist in storage, zeroes the slot.
   */
  async readSlot(slotIdx: number, pageId: number): Promise<void> {
    if (pageId <= 0) {
      throw new Error(
        `Invalid page ID: ${pageId}. Page IDs must be positive integers.`,
      );
    }

    // Await any in-flight flush for this page first
    const in_flight_flush = this.in_flight_flushes.get(pageId);

    if (in_flight_flush) {
      await in_flight_flush;
    }

    // Coalesce in-flight reads for the same pageId
    const in_flight_read = this.in_flight_reads.get(pageId);

    if (in_flight_read) {
      await in_flight_read;
      return;
    }

    const read_promise = (async () => {
      const disk_page = await this.vfs.readPage(pageId);
      const slot_offset = slotIdx * PAGE_SIZE;

      if (disk_page) {
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
          new DataView(disk_page.buffer, disk_page.byteOffset),
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

        this.uint8.set(disk_page, slot_offset);
      } else {
        this.uint8.fill(0, slot_offset, slot_offset + PAGE_SIZE);
      }
    })();

    this.in_flight_reads.set(pageId, read_promise);

    try {
      await read_promise;
    } finally {
      this.in_flight_reads.delete(pageId);
    }
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

    const existing_flush = this.in_flight_flushes.get(pageId);
    if (existing_flush) {
      await existing_flush;
      return;
    }

    const slot_offset = slotIdx * PAGE_SIZE;
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

    const write_snapshot = page_bytes.slice();
    const write_promise = this.vfs.writePage(pageId, write_snapshot);
    this.in_flight_flushes.set(pageId, write_promise);
    try {
      await write_promise;
    } finally {
      this.in_flight_flushes.delete(pageId);
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
      await this.writeSlot(targetSlot, flushPageId);
    }
    await this.readSlot(targetSlot, faultPageId);
  }

  /**
   * Durably flushes pending VFS adapter writes.
   */
  async flush(): Promise<void> {
    await this.vfs.flush();
  }
}
