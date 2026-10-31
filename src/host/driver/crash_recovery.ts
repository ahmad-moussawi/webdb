import { IVfsAdapter } from '../storage/vfs.js';
import {
  decodeWalFileHeader,
  validateWalFrame,
} from '../storage/wal_codec.js';
import {
  WAL_FRAME_HEADER_SIZE,
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
  WAL_FRAME_TYPE_TX_UNCOMMITTED,
} from '../../constants.js';

export interface RecoveryResult {
  frameCount: number;
  committedTxCount: number;
  abortedTxCount: number;
  replayedPageCount: number;
}

/**
 * Executes startup crash recovery against the VFS Write-Ahead Log.
 *
 * Algorithm (Phase 4 Specification - Section 6):
 * 1. Checks if WAL has frames. If empty, startup completes immediately.
 * 2. Validates 32-byte WAL file header. Throws CorruptWalHeaderError on corruption.
 * 3. Reads frames sequentially. Detects truncated tails and stops cleanly at first
 *    corrupt or torn frame (CRC32 mismatch or magic mismatch).
 * 4. Groups frames by tx_id and identifies which transactions reached durable FRAME_TX_COMMIT.
 * 5. Discards uncommitted transaction groups.
 * 6. Deduplicates committed frames (latest page version per page_id) and applies them
 *    to the main database file via vfs.writePages(...).
 * 7. Flushes the main storage durably via vfs.flush().
 * 8. Truncates the WAL to 0 via vfs.truncateWal(0).
 */
export async function recoverFromWal(vfs: IVfsAdapter): Promise<RecoveryResult> {
  const frameCount = await vfs.getWalFrameCount();
  if (frameCount === 0) {
    return {
      frameCount: 0,
      committedTxCount: 0,
      abortedTxCount: 0,
      replayedPageCount: 0,
    };
  }

  // Step 1: Validate WAL file header
  const headerBytes = await vfs.readWalHeader();
  if (!headerBytes) {
    // If frames exist but header is missing, reset WAL to 0
    await vfs.truncateWal(0);
    return {
      frameCount: 0,
      committedTxCount: 0,
      abortedTxCount: 0,
      replayedPageCount: 0,
    };
  }

  // decodeWalFileHeader verifies magic "WEBWAL" and CRC32.
  // If a crash occurred while initializing the 32-byte WAL header itself, discard the invalid WAL.
  try {
    decodeWalFileHeader(headerBytes, true);
  } catch (err) {
    await vfs.truncateWal(0);
    return {
      frameCount: 0,
      committedTxCount: 0,
      abortedTxCount: 0,
      replayedPageCount: 0,
    };
  }

  // Step 2: Linear frame iteration & validation
  const rawFrames = await vfs.readWalFrames(0, frameCount);
  
  // Group frames by tx_id in chronological order
  const txGroups = new Map<number, Array<{ pageId: number; data: Uint8Array; frameType: number }>>();
  const committedTxIds = new Set<number>();
  let validFramesProcessed = 0;

  for (const frameBytes of rawFrames) {
    const validation = validateWalFrame(frameBytes);
    if (!validation.valid || !validation.header) {
      // Truncated tail or torn write detected; halt scanning immediately.
      // Trailing incomplete bytes or corrupted frames are discarded.
      break;
    }

    const { header } = validation;
    if (header.frameSeq !== validFramesProcessed + 1) {
      // Out-of-sequence or stale frame from a prior checkpoint cycle; stop scanning immediately.
      break;
    }
    validFramesProcessed++;

    if (!txGroups.has(header.txId)) {
      txGroups.set(header.txId, []);
    }

    if (header.frameType === WAL_FRAME_TYPE_TX_COMMIT) {
      committedTxIds.add(header.txId);
    } else if (
      header.frameType === WAL_FRAME_TYPE_PAGE_DATA ||
      header.frameType === WAL_FRAME_TYPE_TX_UNCOMMITTED
    ) {
      const pageData = new Uint8Array(
        frameBytes.buffer,
        frameBytes.byteOffset + WAL_FRAME_HEADER_SIZE,
        4096,
      );
      // Copy page data so it is independent of frame buffer
      const pageCopy = new Uint8Array(4096);
      pageCopy.set(pageData);

      txGroups.get(header.txId)!.push({
        pageId: header.pageId,
        data: pageCopy,
        frameType: header.frameType,
      });
    }
  }

  // Step 3 & 4: Transaction commit filter & Deduplicated Apply
  // Collect latest committed bytes per page_id
  const latestPages = new Map<number, Uint8Array>();
  let committedTxCount = 0;
  let abortedTxCount = 0;

  for (const [txId, frames] of txGroups.entries()) {
    if (committedTxIds.has(txId)) {
      committedTxCount++;
      for (const frame of frames) {
        if (frame.pageId > 0) {
          latestPages.set(frame.pageId, frame.data);
        }
      }
    } else {
      abortedTxCount++;
    }
  }

  // Step 4: Apply committed pages to main storage
  if (latestPages.size > 0) {
    const pagesToWrite: Array<{ pageId: number; data: Uint8Array }> = [];
    for (const [pageId, data] of latestPages.entries()) {
      pagesToWrite.push({ pageId, data });
    }
    // Sort pages in ascending pageId order for sequential write locality
    pagesToWrite.sort((a, b) => a.pageId - b.pageId);
    await vfs.writePages(pagesToWrite);
  }

  // Step 5: Flush main storage and truncate WAL
  await vfs.flush();
  await vfs.truncateWal(0);

  return {
    frameCount: validFramesProcessed,
    committedTxCount,
    abortedTxCount,
    replayedPageCount: latestPages.size,
  };
}
