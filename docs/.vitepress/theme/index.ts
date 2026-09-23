import DefaultTheme from 'vitepress/theme';
import LandingPage from './components/LandingPage.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: any }) {
    app.component('LandingPage', LandingPage);
  },
};
