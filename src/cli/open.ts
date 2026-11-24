import { stat } from "node:fs/promises";
import { DEFAULT_SLOT_COUNT, MAX_SLOT_COUNT, PAGE_SIZE } from "../constants.js";
import { InvalidDatabaseError } from "../types/index.js";
import { WebDB } from "../host/api/webdb.js";
import { NodeFsStorage } from "../host/storage/node_fs.js";
import { ReadOnlyOverlayVfs } from "../host/storage/read_only_overlay.js";
import { WasmEngine } from "../core/wasm/entry.js";
import { JsEngine } from "../core/js/entry.js";
import type { WebDbCoreEngine } from "../core/js/vm_host.js";

export type CoreMode = "wasm" | "js";
export { ReadOnlyOverlayVfs };

export function createEngine(core: CoreMode): WebDbCoreEngine {
  return core === "js" ? new JsEngine() : new WasmEngine();
}

/**
 * Verifies that `filePath` exists and is a regular file, returning its size (which may be 0).
 */
export async function statDbFile(filePath: string): Promise<{ size: number }> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    return { size: info.size };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      throw new Error(`Database file not found: ${filePath}`);
    }
    throw err;
  }
}

export async function assertDbFileExists(
  filePath: string,
): Promise<{ size: number }> {
  const { size } = await statDbFile(filePath);
  if (size === 0) {
    throw new Error(`Database file is empty (0 bytes): ${filePath}`);
  }
  return { size };
}

export async function getOptionalFileSize(
  filePath: string,
): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export interface OpenedReadOnlyDb {
  db: WebDB;
  storage: NodeFsStorage;
  overlay: ReadOnlyOverlayVfs;
  dbFileSize: number;
  walFileSize: number | null;
  walFramesOnDisk: number;
  slotCount: number;
  close(): Promise<void>;
}

/**
 * Opens an existing WebDB file strictly read-only.
 * Any pending committed WAL frames are replayed in memory via `ReadOnlyOverlayVfs`
 * without modifying `.db` or `.wal` on disk.
 */
export async function openReadOnlyDb(
  filePath: string,
  core: CoreMode = "wasm",
): Promise<OpenedReadOnlyDb> {
  const { size: dbFileSize } = await assertDbFileExists(filePath);
  const candidateSlotCounts = [DEFAULT_SLOT_COUNT, 4096, 16384, MAX_SLOT_COUNT];

  for (let i = 0; i < candidateSlotCounts.length; i++) {
    const slotCount = candidateSlotCounts[i];
    const storage = new NodeFsStorage(filePath, { readOnly: true });
    let closed = false;
    try {
      const walFileSize = await getOptionalFileSize(storage.walPath);
      const walFramesOnDisk = await storage.getWalFrameCount();

      if (dbFileSize < PAGE_SIZE && walFramesOnDisk === 0) {
        throw new Error(
          `Invalid database file (${dbFileSize} bytes): file is smaller than a single ${PAGE_SIZE}-byte page (${filePath})`,
        );
      }

      const overlay = new ReadOnlyOverlayVfs(storage);
      const db = await WebDB.open({
        storage: overlay,
        engine: createEngine(core),
        slotCount,
        crossTabSync: false,
      });
      return {
        db,
        storage,
        overlay,
        dbFileSize,
        walFileSize,
        walFramesOnDisk,
        slotCount,
        close: async () => {
          await db.close();
        },
      };
    } catch (err) {
      await storage.close().catch(() => {});
      closed = true;
      const isPoolCapacityError =
        err instanceof InvalidDatabaseError &&
        /exceed buffer pool capacity/i.test(err.message);
      if (isPoolCapacityError && i < candidateSlotCounts.length - 1) {
        continue;
      }
      throw err;
    } finally {
      if (!closed) {
        // Ownership transferred to returned `OpenedReadOnlyDb`
      }
    }
  }
  throw new Error(`Failed to open database: ${filePath}`);
}
