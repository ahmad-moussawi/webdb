import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-test",
  webServer: {
    command: "npx --no-install serve . -l 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4173",
  },
});