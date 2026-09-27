import { defineConfig } from "@playwright/test";

/**
 * UI tests run the frontend in a browser, outside the Tauri shell. That is a
 * real, supported state: the UI must say the native layer is unavailable rather
 * than pretend. Uses the system's installed Microsoft Edge (Chromium) channel.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:1421",
    channel: "msedge",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "pnpm --filter @morrow/desktop exec vite --port 1421 --strictPort",
    url: "http://localhost:1421",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
