import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// Relative on purpose: Vite bundles relative imports of the config, while a workspace
// package would be handed to Node unbundled (its TypeScript sources are not runnable).
import { tokenStylesheet } from "../../packages/design-system/src/css";

/**
 * Design tokens as a build-time stylesheet (`virtual:morrow-tokens.css`).
 *
 * Tokens are defined in TypeScript (packages/design-system) and must reach the page
 * as static CSS: Tauri adds a nonce to the production CSP, which makes the browser
 * ignore 'unsafe-inline', so a <style> element created at runtime is blocked and
 * the app renders without tokens. Bundled CSS is served as 'self' and always applies.
 */
function morrowTokens(): Plugin {
  const id = "virtual:morrow-tokens.css";
  const resolved = `\0${id}`;
  return {
    name: "morrow-tokens",
    resolveId: (source) => (source === id ? resolved : null),
    load: (source) => (source === resolved ? tokenStylesheet() : null),
  };
}

// Tauri expects a fixed dev port and serves the built files from ../dist.
export default defineConfig({
  plugins: [morrowTokens(), react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
