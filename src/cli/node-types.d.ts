declare module 'node:fs/promises' {
  export interface FileHandle {
    read(
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    write(
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    stat(): Promise<{ size: number; isFile(): boolean }>;
    truncate(len?: number): Promise<void>;
    datasync(): Promise<void>;
    close(): Promise<void>;
  }

  export function open(path: string, flags?: string | number): Promise<FileHandle>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function stat(path: string): Promise<{ size: number; isFile(): boolean }>;
  export function writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}

declare module 'node:path' {
  export function basename(path: string, suffix?: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};
