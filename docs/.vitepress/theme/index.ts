import DefaultTheme from 'vitepress/theme';
import LandingPage from './components/LandingPage.vue';
import { SIZE_METRICS } from './constants';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: any }) {
    app.config.globalProperties.$sizes = SIZE_METRICS;
    app.component('LandingPage', LandingPage);
  },
};
