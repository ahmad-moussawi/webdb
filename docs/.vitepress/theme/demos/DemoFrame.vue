<script setup lang="ts">
/**
 * Shared chrome for every live demo: opens a WebDB database on IndexedDB, runs the demo's
 * idempotent setup, renders the demo app with the `db`, and shows source / reset / activity.
 */
import { computed, markRaw, onMounted, onUnmounted, ref, shallowRef, type Component } from 'vue';
import { withBase } from 'vitepress';
import { WebDB, type TableChangeEvent } from '@ahmadmoussawi/webdb';
import { DEMOS, sourceUrl, type DemoId } from './registry';
import './demo.css';

/** `full`: render as a standalone page (no docs chrome) instead of inside the documentation. */
const props = defineProps<{ demo: DemoId; full?: boolean }>();
const meta = DEMOS[props.demo];
/** `?embed=1`: rendered inside an iframe (e.g. the multi-tab demo), so drop the chrome that wastes space. */
const embed = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('embed');

const db = shallowRef<WebDB | null>(null);
const App = shallowRef<Component | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const lastChange = ref<{ tables: string; origin: string; n: number } | null>(null);
const resetting = ref(false);

let resetFn: ((db: WebDB) => Promise<void>) | null = null;
let unsubscribe: (() => void) | null = null;
let changes = 0;

const source = computed(() => sourceUrl(meta.sourcePath));
const docsUrl = computed(() => withBase(`/demos/${props.demo}`));

async function withSetupLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return task();
  return locks.request(`webdb_demo_setup_${name}`, { mode: 'exclusive' }, task) as Promise<T>;
}

onMounted(async () => {
  try {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available in this browser, so the demo cannot persist data.');
    }
    const mod = await meta.load();
    // Two tabs (or frames) may load at the same instant on a brand-new database: serialise
    // "open + create tables + seed" across them so the seed data is only inserted once.
    const instance = await withSetupLock(meta.dbName, async () => {
      const db = await WebDB.open({ name: meta.dbName, storage: 'idb' });
      await mod.setup(db);
      return db;
    });
    unsubscribe = instance.subscribe('*', (ev: TableChangeEvent) => {
      changes++;
      lastChange.value = {
        tables: ev.tables.join(', ') || '—',
        origin: ev.crossTab ? 'another tab' : 'this tab',
        n: changes,
      };
    });
    resetFn = mod.reset;
    App.value = markRaw(mod.App);
    db.value = markRaw(instance);
    status.value = 'ready';
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err);
    status.value = 'error';
  }
});

onUnmounted(() => {
  unsubscribe?.();
  const instance = db.value;
  if (instance) void instance.close().catch(() => {});
});

async function reset() {
  if (!db.value || !resetFn || resetting.value) return;
  resetting.value = true;
  try {
    await resetFn(db.value);
  } finally {
    resetting.value = false;
  }
}
</script>

<template>
  <section :class="['wd-frame', { 'wd-full': full, 'wd-embed': embed }]" :aria-label="`${meta.title} live demo`">
    <header class="wd-header">
      <div class="wd-title">
        <a v-if="full" class="wd-back" :href="docsUrl" title="Back to the documentation page">← Docs</a>
        {{ meta.title }}
        <span class="wd-badge wd-badge-live"><i class="wd-pulse" />LIVE</span>
      </div>
      <div class="wd-actions">
        <span class="wd-badge" title="Data is stored in your browser's IndexedDB">
          IndexedDB · {{ meta.dbName }}
        </span>
        <button class="wd-btn" type="button" :disabled="status !== 'ready' || resetting" @click="reset">
          {{ resetting ? 'Resetting…' : 'Reset data' }}
        </button>
        <a class="wd-btn wd-btn-primary" :href="source" target="_blank" rel="noopener noreferrer">
          View source on GitHub ↗
        </a>
      </div>
    </header>

    <p class="wd-persist" role="note">
      <strong>🔒 Your data stays in your browser.</strong>
      It is saved in IndexedDB on this device: no API, no server, no account. Add or change something, then
      <strong>refresh the page</strong> and it is still here.
    </p>

    <div class="wd-body">
      <div v-if="status === 'loading'" class="wd-state">Opening IndexedDB…</div>
      <div v-else-if="status === 'error'" class="wd-state wd-state-error">{{ error }}</div>
      <component :is="App" v-else-if="App && db" :db="db" />
    </div>

    <footer class="wd-footer">
      <span class="wd-tip">💡 Open this page in a second tab: changes sync between tabs in real time.</span>
      <span v-if="lastChange" class="wd-activity" aria-live="polite">
        change #{{ lastChange.n }} · <code>{{ lastChange.tables }}</code> · from {{ lastChange.origin }}
      </span>
    </footer>
  </section>
</template>
