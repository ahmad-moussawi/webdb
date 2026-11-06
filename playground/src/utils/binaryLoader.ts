import type { VfsType, CoreEngineMode } from '../types/studio';

export interface LoadedBinaryDb {
  bytes: Uint8Array;
  wasCompressed: boolean;
  compressedByteLength: number;
  pageCount: number;
  suggestedName: string;
}

/**
 * Checks whether a byte array starts with the gzip magic header (0x1f, 0x8b).
 */
export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Checks whether a byte array starts with the WebDB magic header ("WEBDB\0").
 */
export function hasWebDbMagicHeader(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x57 && // 'W'
    bytes[1] === 0x45 && // 'E'
    bytes[2] === 0x42 && // 'B'
    bytes[3] === 0x44 && // 'D'
    bytes[4] === 0x42 && // 'B'
    bytes[5] === 0x00 // '\0'
  );
}

/**
 * Decompresses gzip-compressed bytes using the native Compression Streams API.
 * If the bytes do not have a gzip header (e.g., uncompressed .webdb or already
 * transparently decompressed by the browser's fetch Content-Encoding), returns them as-is.
 */
export async function decompressIfNeeded(
  input: Uint8Array,
): Promise<{ bytes: Uint8Array; wasCompressed: boolean }> {
  if (!isGzipBytes(input)) {
    return { bytes: input, wasCompressed: false };
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser does not support DecompressionStream("gzip") required for .webdb.gz files.',
    );
  }

  try {
    const ds = new DecompressionStream('gzip');
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    const stream = new Blob([copy.buffer]).stream().pipeThrough(ds);
    const decompressedBuffer = await new Response(stream).arrayBuffer();
    return {
      bytes: new Uint8Array(decompressedBuffer),
      wasCompressed: true,
    };
  } catch (err: any) {
    throw new Error(
      `Failed to decompress gzip file: ${err?.message || 'corrupted gzip stream'}`,
    );
  }
}

/**
 * Compresses a Uint8Array using gzip via the native Compression Streams API.
 */
export async function compressGzip(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'This browser does not support CompressionStream("gzip").',
    );
  }
  const cs = new CompressionStream('gzip');
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(cs);
  const compressedBuffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(compressedBuffer);
}

/**
 * Validates that a decompressed byte array is a valid 4KB-aligned WebDB binary image.
 */
export function validateWebDbBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 4096 || bytes.byteLength % 4096 !== 0) {
    throw new Error(
      `Invalid database binary size (${bytes.byteLength.toLocaleString()} bytes): must be a multiple of 4,096 bytes.`,
    );
  }
  if (!hasWebDbMagicHeader(bytes)) {
    throw new Error(
      'Invalid WebDB binary header: expected "WEBDB\\0" magic bytes at offset 0.',
    );
  }
}

/**
 * Extracts a sanitized database identifier from a file name or URL.
 */
export function deriveDbNameFromSource(source: string): string {
  let fileName = source.trim();
  try {
    if (
      fileName.startsWith('http://') ||
      fileName.startsWith('https://') ||
      fileName.startsWith('/') ||
      fileName.startsWith('./')
    ) {
      const parsed = new URL(fileName, 'http://localhost');
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        fileName = decodeURIComponent(segments[segments.length - 1]);
      }
    }
  } catch {}

  const stripped = fileName
    .replace(/\.(webdb\.gz|db\.gz|bin\.gz|sqlite\.gz|webdb|db|bin|sqlite|gz)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');

  return stripped || 'remote_db';
}

/**
 * Loads, optionally decompresses (.gz), and validates a local File.
 */
export async function loadWebDbFromFile(file: File): Promise<LoadedBinaryDb> {
  const rawBuffer = await file.arrayBuffer();
  const rawBytes = new Uint8Array(rawBuffer);
  const { bytes, wasCompressed } = await decompressIfNeeded(rawBytes);
  validateWebDbBytes(bytes);

  return {
    bytes,
    wasCompressed,
    compressedByteLength: rawBytes.byteLength,
    pageCount: bytes.byteLength / 4096,
    suggestedName: deriveDbNameFromSource(file.name),
  };
}

/**
 * Fetches, optionally decompresses (.webdb.gz), and validates a remote WebDB database URL.
 */
export async function fetchRemoteWebDb(
  url: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<LoadedBinaryDb> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Remote database URL cannot be empty.');
  }

  let response: Response;
  try {
    response = await fetch(trimmedUrl);
  } catch (err: any) {
    throw new Error(
      `Network error fetching remote database (${trimmedUrl}): ${err?.message || 'check URL and CORS headers'}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch remote database: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

  let rawBytes: Uint8Array;
  if (response.body && onProgress) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        receivedLength += value.byteLength;
        onProgress(receivedLength, totalBytes || receivedLength);
      }
    }

    rawBytes = new Uint8Array(receivedLength);
    let offset = 0;
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buf = await response.arrayBuffer();
    rawBytes = new Uint8Array(buf);
    if (onProgress) {
      onProgress(rawBytes.byteLength, rawBytes.byteLength);
    }
  }

  const { bytes, wasCompressed } = await decompressIfNeeded(rawBytes);
  validateWebDbBytes(bytes);

  const isUrlGz = /\.gz($|\?)/i.test(trimmedUrl);

  return {
    bytes,
    wasCompressed: wasCompressed || isUrlGz,
    compressedByteLength: rawBytes.byteLength,
    pageCount: bytes.byteLength / 4096,
    suggestedName: deriveDbNameFromSource(trimmedUrl),
  };
}

/**
 * Checks if a `db` query parameter value represents a remote URL or file path
 * rather than a plain local database identifier.
 */
export function isRemoteDbParam(dbParam: string): boolean {
  const trimmed = dbParam.trim();
  return (
    /^https?:\/\//i.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    /\.(webdb|webdb\.gz|gz|db|bin)(\?.*)?$/i.test(trimmed)
  );
}

/**
 * Builds a shareable Studio URL that directly opens a remote database.
 */
export function buildShareablePlaygroundUrl(options: {
  remoteUrl: string;
  core: CoreEngineMode;
  storage: VfsType;
}): string {
  const base =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://webdb.dev/playground/';

  const trimmedUrl = options.remoteUrl.trim();
  // Keep clean unencoded URL when it doesn't contain query string delimiters (& or #)
  const encodedDb =
    trimmedUrl.includes('&') || trimmedUrl.includes('#') || trimmedUrl.includes(' ')
      ? encodeURIComponent(trimmedUrl)
      : trimmedUrl;

  return `${base}?core=${options.core}&db=${encodedDb}&storage=${options.storage}`;
}

