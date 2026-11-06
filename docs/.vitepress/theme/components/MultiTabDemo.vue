<script setup lang="ts">
/**
 * Two "browser windows" side by side, each an iframe of the same demo page. They are two real browsing
 * contexts of the same origin, so they share one IndexedDB database and talk through BroadcastChannel,
 * exactly like two tabs of your browser.
 */
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';
import BrowserWindow from './BrowserWindow.vue';

const props = defineProps<{ full?: boolean }>();

const demos = [
  { id: 'todo', label: 'Todo list', height: 560 },
  { id: 'kanban', label: 'Kanban board', height: 560 },
  { id: 'calendar', label: 'Calendar', height: 640 },
] as const;

const current = ref<(typeof demos)[number]['id']>('todo');
const demo = computed(() => demos.find((d) => d.id === current.value)!);
const src = computed(() => withBase(`/demos/app/${current.value}?embed=1`));
const height = computed(() => (props.full ? Math.max(demo.value.height, 640) : demo.value.height));
const docsUrl = withBase('/demos/multi-tab');
</script>

<template>
  <section class="mt" :class="{ 'mt-full': full }">
    <header v-if="full" class="mt-top">
      <a :href="docsUrl" class="mt-back">← Docs</a>
      <strong>Two tabs, one database</strong>
    </header>

    <div class="mt-picker" role="tablist" aria-label="Choose the demo shown in both windows">
      <span>Demo:</span>
      <button
        v-for="d in demos"
        :key="d.id"
        type="button"
        role="tab"
        :aria-selected="current === d.id"
        :class="['mt-pick', { active: current === d.id }]"
        @click="current = d.id"
      >
        {{ d.label }}
      </button>
    </div>

    <p class="mt-hint">
      👉 Make a change in <strong>Tab A</strong> and watch <strong>Tab B</strong> update on its own, then try the other way round.
      Press ⟳ in a window to reload it: the data is still there.
    </p>

    <div class="mt-grid">
      <BrowserWindow :key="`a-${current}`" label="Tab A" accent="#3b82f6" :src="src" :title="demo.label" :height="height" />
      <div class="mt-sync" aria-hidden="true"><span>⇄</span><small>live sync</small></div>
      <BrowserWindow :key="`b-${current}`" label="Tab B" accent="#10b981" :src="src" :title="demo.label" :height="height" />
    </div>
  </section>
</template>

<style scoped>
.mt {
  container-type: inline-size;
  margin: 1.5rem 0 2rem;
}
.mt-full {
  box-sizing: border-box;
  min-height: 100vh;
  max-width: 1500px;
  margin: 0 auto;
  padding: 1rem 1.25rem 2rem;
}
.mt-top {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 0.8rem;
}
.mt-back {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  text-decoration: none;
}
.mt-back:hover {
  color: var(--vp-c-brand-1);
}
.mt-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
}
.mt-pick {
  padding: 0.25rem 0.8rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.mt-pick.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.mt-hint {
  margin: 0.8rem 0 1rem;
  padding: 0.6rem 0.9rem;
  border-radius: 8px;
  background: var(--vp-c-brand-soft);
  font-size: 0.85rem;
  line-height: 1.5;
}
.mt-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: start;
  gap: 0.6rem;
}
.mt-sync {
  align-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--vp-c-brand-1);
  font-weight: 700;
}
.mt-sync span {
  font-size: 1.6rem;
  line-height: 1;
}
.mt-sync small {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
@container (max-width: 560px) {
  .mt-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .mt-sync {
    flex-direction: row;
    gap: 0.4rem;
    justify-content: center;
  }
  .mt-sync span {
    transform: rotate(90deg);
  }
}
</style>
