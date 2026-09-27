import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SKIP = new Set(["node_modules", ".git", "target", "dist", "runtime", "gen", "icons", "test-results", "playwright-report"]);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(json|ts|tsx|mjs|css|md|rs|toml|sql)$/.test(name)) out.push(full);
  }
  return out;
}

describe("repository hygiene", () => {
  it("has no UTF-8 byte-order marks (they break JSON and PostCSS config loading)", () => {
    const withBom = files(ROOT).filter((f) => readFileSync(f).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
    expect(withBom).toEqual([]);
  });
});
