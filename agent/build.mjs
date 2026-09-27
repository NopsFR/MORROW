// Bundles the agent runtime into a single ESM file the native layer can spawn with Node.
// better-sqlite3 stays external: it is a native addon resolved from agent/node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/host/main.ts"],
  outfile: "dist/morrow-runtime.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["better-sqlite3"],
  banner: {
    js: "import { createRequire as __morrowCreateRequire } from 'node:module'; const require = __morrowCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
