import { defineConfig } from "@playwright/test";

/**
 * UI tests run the frontend in a browser, outside the Tauri shell. That is a
 * real, supported state: the UI must say the native layer is unavailable rather
 * than pretend. Uses the system's installed Microsoft Edge (Chromium) channel.
 *
 * Two projects:
 * - `dev`: the Vite dev server, for behaviour.
 * - `production`: the production build (`vite build`, served by `vite preview`) under the
 *   desktop app's real Content-Security-Policy, which the dev server does not apply. This
 *   is what the shipped app renders; it caught tokens that never reached the release UI.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    channel: "msedge",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "dev", testIgnore: /production\.spec/, use: { baseURL: "http://localhost:1421" } },
    { name: "production", testMatch: /production\.spec/, use: { baseURL: "http://localhost:1422" } },
  ],
  webServer: [
    {
      command: "pnpm --filter @morrow/desktop exec vite --port 1421 --strictPort",
      url: "http://localhost:1421",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @morrow/desktop exec vite build && pnpm --filter @morrow/desktop exec vite preview --port 1422 --strictPort",
      url: "http://localhost:1422",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
