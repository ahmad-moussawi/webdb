import { defineAsyncComponent } from 'vue';
import DefaultTheme from 'vitepress/theme';
import LandingPage from './components/LandingPage.vue';
import DemoBanner from './components/DemoBanner.vue';
import MultiTabDemo from './components/MultiTabDemo.vue';
import { SIZE_METRICS } from './constants';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: any }) {
    app.config.globalProperties.$sizes = SIZE_METRICS;
    app.component('LandingPage', LandingPage);
    app.component('DemoBanner', DemoBanner);
    app.component('MultiTabDemo', MultiTabDemo);
    // Loaded on demand so the database library only ships with the demo pages
    app.component(
      'DemoFrame',
      defineAsyncComponent(() => import('./demos/DemoFrame.vue')),
    );
  },
};
