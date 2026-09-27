#!/usr/bin/env node
/**
 * Reset MORROW's local development state so the next launch is a clean first launch.
 *
 * Removes:
 *   - the app data directory (database: projects, tasks, events, memory, grants…)
 *   - the app's WebView data directory
 *   - temporary directories created by the live checks (morrow-live-*, morrow-ws-*)
 *
 * Does NOT touch: the repository, automated test fixtures (tests create and delete
 * their own temp directories), Ollama or its models, or the assembled bundled runtime.
 *
 * Usage: node scripts/reset-dev-state.mjs            (dry run: lists what would be removed)
 *        node scripts/reset-dev-state.mjs --yes      (removes it)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const IDENTIFIER = "app.morrow.desktop";
const apply = process.argv.includes("--yes");

function appDirs() {
  switch (platform()) {
    case "win32":
      return [
        join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), IDENTIFIER),
        join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), IDENTIFIER),
      ];
    case "darwin":
      return [
        join(homedir(), "Library", "Application Support", IDENTIFIER),
        join(homedir(), "Library", "Caches", IDENTIFIER),
        join(homedir(), "Library", "WebKit", IDENTIFIER),
      ];
    default:
      return [
        join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), IDENTIFIER),
        join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), IDENTIFIER),
      ];
  }
}

function appIsRunning() {
  try {
    if (platform() === "win32") {
      return execFileSync("tasklist", ["/FI", "IMAGENAME eq morrow-desktop.exe"], { encoding: "utf8" }).includes("morrow-desktop.exe");
    }
    execFileSync("pgrep", ["-f", "morrow-desktop"]);
    return true;
  } catch {
    return false;
  }
}

const temp = tmpdir();
const targets = [
  ...appDirs(),
  ...readdirSync(temp)
    .filter((name) => /^morrow-(live|ws|runtime-verify)-/.test(name))
    .map((name) => join(temp, name)),
].filter((p) => existsSync(p));

if (targets.length === 0) {
  console.log("Nothing to reset: MORROW has no local state.");
  process.exit(0);
}
if (apply && appIsRunning()) {
  console.error("MORROW is running. Quit it before resetting (its database is open).");
  process.exit(1);
}
console.log(apply ? "Removing:" : "Would remove (dry run; pass --yes to apply):");
for (const target of targets) {
  console.log(`  ${target}`);
  if (apply) rmSync(target, { recursive: true, force: true });
}
if (apply) console.log("Done. The next launch starts from a clean state.");
