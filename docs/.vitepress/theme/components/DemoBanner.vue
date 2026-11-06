<script setup lang="ts">
/** Large banner shown at the top of every demo page, linking to the standalone full-page version. */
import { withBase } from 'vitepress';

const props = defineProps<{ demo: string }>();
const href = withBase(`/demos/app/${props.demo}`);
</script>

<template>
  <a class="demo-banner" :href="href" target="_blank" rel="noopener">
    <span class="demo-banner-icon" aria-hidden="true">⛶</span>
    <span class="demo-banner-text">
      <strong class="demo-banner-title">Open this demo as a full page</strong>
      <span class="demo-banner-sub">
        Run it on its own, without the documentation around it: more room, same live data in your browser.
      </span>
    </span>
    <span class="demo-banner-cta">Open full page ↗</span>
  </a>
</template>

<style scoped>
.demo-banner {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  margin: 1.25rem 0 1.5rem;
  padding: 1.25rem 1.5rem;
  border-radius: 14px;
  background: linear-gradient(120deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
  color: #fff !important;
  text-decoration: none !important;
  box-shadow: 0 6px 20px rgba(37, 99, 235, 0.25);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.demo-banner:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 28px rgba(37, 99, 235, 0.35);
}
.demo-banner-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.2);
  font-size: 1.6rem;
}
.demo-banner-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.demo-banner-title {
  font-size: 1.2rem;
  line-height: 1.3;
}
.demo-banner-sub {
  font-size: 0.9rem;
  line-height: 1.45;
  opacity: 0.92;
}
.demo-banner-cta {
  flex: none;
  padding: 0.6rem 1.2rem;
  border-radius: 999px;
  background: #fff;
  color: var(--vp-c-brand-1);
  font-weight: 700;
  font-size: 0.95rem;
  white-space: nowrap;
}
@media (max-width: 640px) {
  .demo-banner {
    flex-wrap: wrap;
    padding: 1rem;
  }
  .demo-banner-text {
    flex-basis: calc(100% - 4.1rem);
  }
  .demo-banner-cta {
    width: 100%;
    box-sizing: border-box;
    text-align: center;
  }
}
</style>
