import type { Component } from 'vue';
import type { WebDB } from '@ahmadmoussawi/webdb';

export const REPO_URL = 'https://github.com/ahmad-moussawi/webdb';
export const DEMOS_SOURCE_DIR = 'docs/.vitepress/theme/demos';

export interface DemoModule {
  setup: (db: WebDB) => Promise<void>;
  reset: (db: WebDB) => Promise<void>;
  App: Component;
}

export interface DemoMeta {
  title: string;
  /** IndexedDB database name (stored as `webdb_<dbName>`). */
  dbName: string;
  /** Folder (relative to the repo root) that contains the demo's source. */
  sourcePath: string;
  load: () => Promise<DemoModule>;
}

export const DEMOS = {
  todo: {
    title: 'Todo list',
    dbName: 'demo_todo',
    sourcePath: `${DEMOS_SOURCE_DIR}/todo`,
    load: async () => {
      const [db, app] = await Promise.all([import('./todo/db'), import('./todo/TodoApp.vue')]);
      return { setup: db.setupTodoDb, reset: db.resetTodoData, App: app.default };
    },
  },
  kanban: {
    title: 'Kanban board',
    dbName: 'demo_kanban',
    sourcePath: `${DEMOS_SOURCE_DIR}/kanban`,
    load: async () => {
      const [db, app] = await Promise.all([import('./kanban/db'), import('./kanban/KanbanApp.vue')]);
      return { setup: db.setupKanbanDb, reset: db.resetKanbanData, App: app.default };
    },
  },
  calendar: {
    title: 'Calendar & appointments',
    dbName: 'demo_calendar',
    sourcePath: `${DEMOS_SOURCE_DIR}/calendar`,
    load: async () => {
      const [db, app] = await Promise.all([import('./calendar/db'), import('./calendar/CalendarApp.vue')]);
      return { setup: db.setupCalendarDb, reset: db.resetCalendarData, App: app.default };
    },
  },
  search: {
    title: 'Typo-Tolerant Search with UDFs',
    dbName: 'demo_search',
    sourcePath: `${DEMOS_SOURCE_DIR}/search`,
    load: async () => {
      const [db, app] = await Promise.all([import('./search/db'), import('./search/SearchApp.vue')]);
      return { setup: db.setupSearchDb, reset: db.resetSearchData, App: app.default };
    },
  },
} satisfies Record<string, DemoMeta>;

export type DemoId = keyof typeof DEMOS;

export function sourceUrl(path: string): string {
  return `${REPO_URL}/tree/main/${path}`;
}
