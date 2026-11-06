<script setup lang="ts">
/** A fake browser window (tab strip + address bar) around an iframe. The iframe is real and same-origin. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const props = defineProps<{ label: string; accent: string; src: string; title: string; height: number }>();
const frame = ref<HTMLIFrameElement | null>(null);

const address = computed(() => {
  const url = new URL(props.src, window.location.href);
  return `${url.host}${url.pathname.replace(/\.html$/, '')}`;
});
const favicon = withBase('/logo.svg');

// The app inside needs ~380px to lay out properly. In a narrow window we render the iframe at that width
// and scale it down to fit (clicks, typing and drag & drop still work through a CSS transform).
const MIN_LOGICAL_WIDTH = 380;
const view = ref<HTMLElement | null>(null);
const viewWidth = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!view.value) return;
  viewWidth.value = view.value.clientWidth;
  observer = new ResizeObserver(() => (viewWidth.value = view.value?.clientWidth ?? 0));
  observer.observe(view.value);
});
onBeforeUnmount(() => observer?.disconnect());

const logicalWidth = computed(() => Math.max(MIN_LOGICAL_WIDTH, viewWidth.value));
const scale = computed(() => (viewWidth.value > 0 ? viewWidth.value / logicalWidth.value : 1));
const frameStyle = computed(() => ({
  width: `${logicalWidth.value}px`,
  height: `${props.height / scale.value}px`,
  transform: `scale(${scale.value})`,
}));

function reload() {
  try {
    frame.value?.contentWindow?.location.reload();
  } catch {
    if (frame.value) frame.value.src = props.src;
  }
}
</script>

<template>
  <figure class="bw" :style="{ '--accent': accent }">
    <figcaption class="bw-label"><span class="bw-dot" />{{ label }}</figcaption>
    <div class="bw-window">
      <div class="bw-tabs">
        <span class="bw-lights" aria-hidden="true"><i /><i /><i /></span>
        <span class="bw-tab"><img :src="favicon" alt="" width="14" height="14" />{{ title }}</span>
        <span class="bw-plus" aria-hidden="true">+</span>
      </div>
      <div class="bw-bar">
        <button class="bw-reload" type="button" title="Reload this tab (your data persists)" aria-label="Reload this tab" @click="reload">⟳</button>
        <span class="bw-url"><span aria-hidden="true">🔒</span>{{ address }}</span>
      </div>
      <div ref="view" class="bw-view" :style="{ height: `${height}px` }">
        <iframe ref="frame" class="bw-frame" :src="src" :title="`${label}: ${title}`" :style="frameStyle" loading="eager" />
      </div>
    </div>
  </figure>
</template>

<style scoped>
.bw {
  margin: 0;
  min-width: 0;
}
.bw-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--vp-c-text-2);
}
.bw-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
}
.bw-window {
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--accent);
  border-radius: 12px;
  background: var(--vp-c-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
.bw-tabs {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem 0;
  background: var(--vp-c-bg-mute);
}
.bw-lights {
  display: flex;
  gap: 5px;
  align-self: center;
  margin-right: 0.3rem;
}
.bw-lights i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ff5f57;
}
.bw-lights i:nth-child(2) {
  background: #febc2e;
}
.bw-lights i:nth-child(3) {
  background: #28c840;
}
.bw-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 60%;
  padding: 0.35rem 0.8rem;
  border-radius: 8px 8px 0 0;
  background: var(--vp-c-bg-soft);
  font-size: 0.74rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bw-plus {
  align-self: center;
  color: var(--vp-c-text-3);
}
.bw-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
}
.bw-reload {
  flex: none;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}
.bw-reload:hover {
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-brand-1);
}
.bw-url {
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0.8rem;
  border-radius: 999px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  font-size: 0.72rem;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bw-url span {
  margin-right: 0.35rem;
}
.bw-view {
  position: relative;
  overflow: hidden;
  background: var(--vp-c-bg);
}
.bw-frame {
  display: block;
  border: 0;
  background: var(--vp-c-bg);
  transform-origin: 0 0;
}
</style>
