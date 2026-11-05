/**
 * Central binary & bundle size metrics for WebDB documentation and landing page.
 * Update these values in one place whenever build sizes change.
 */
export const SIZE_METRICS = {
  /** Gzipped WebAssembly core size */
  wasmGzip: "~19 KB",
  /** Uncompressed / raw WebAssembly core size */
  wasmRaw: "~51 KB",
  /** Total gzipped npm bundle size ceiling */
  totalBundle: "<100 KB",
  /** Framework live-query adapter subpath size */
  adapterSubpath: "< 1 KB",
} as const;
