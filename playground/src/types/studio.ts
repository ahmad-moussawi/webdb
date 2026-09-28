export interface EditorTab {
  id: string;
  title: string;
  code: string;
}

export interface TableColumnMeta {
  name: string;
  type: number | string;
  flags?: number | { primaryKey?: boolean; notNull?: boolean; autoInc?: boolean };
}

export interface TableMeta {
  name: string;
  rootPageId: number;
  colCatalogPageId: number;
  rowCountEstimate: number;
  columns?: TableColumnMeta[];
}

export interface ExplainOutput {
  plan?: unknown;
  assembly?: string;
  bytecodeSize?: number;
  instructions?: unknown[];
}

export interface TypeTagMeta {
  short: string;
  label: string;
}

export type ThemeMode = 'auto' | 'dark' | 'light';
export type VfsType = 'memory' | 'idb';
export type ResultTabType = 'results' | 'structure' | 'bytecode' | 'console' | 'pages' | 'pool';
export type RowInspectorMode = 'fields' | 'json';

export interface SeedingProgress {
  visible: boolean;
  title: string;
  step: string;
  current: number;
  total: number;
}
