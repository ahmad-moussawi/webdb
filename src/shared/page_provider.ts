/**
 * Shared Page Provider Interface
 *
 * Provides an abstraction for dynamic page allocation and buffer access
 * during table creation and catalog mutations across Host and Core.
 */

export interface IPageProvider {
  allocateNewPage(): number;
  getPageBytes(pageId: number): Uint8Array;
  markPageDirty(pageId: number): void;
}
