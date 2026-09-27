import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../contract";
import { resolveWithinWorkspace } from "./paths";

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", ".venv", "__pycache__"]);
const MAX_SCANNED = 20_000;
const MAX_DEPTH = 12;

/** `*` matches within a path segment, `**` across segments; no wildcard = substring of the name. */
export function matcherFor(pattern: string): (relativePath: string, name: string) => boolean {
  const p = pattern.trim().toLowerCase();
  if (!/[*?]/.test(p)) return (_rel, name) => name.toLowerCase().includes(p);
  const regex = new RegExp(
    `^${p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*")}$`,
  );
  const matchName = !p.includes("/");
  return (rel, name) => regex.test(matchName ? name.toLowerCase() : rel.toLowerCase());
}

const FindInput = z.object({
  pattern: z.string().min(1).describe('Name fragment (e.g. "readme") or glob (e.g. "*.md", "src/**/*.ts")'),
  directory: z.string().min(1).default(".").describe("Directory to search, relative to the workspace root"),
  maxResults: z.number().int().min(1).max(500).default(100),
});
const FindOutput = z.object({
  directory: z.string(),
  matches: z.array(z.string()),
  truncated: z.boolean(),
  scanned: z.number().int(),
});

export const findFilesTool: Tool<typeof FindInput, typeof FindOutput> = {
  id: "filesystem.find_files",
  name: "Find files",
  description:
    "Search the project workspace for files by name or glob. Returns paths relative to the searched directory. Skips .git, node_modules and build output.",
  version: "1.0.0",
  category: "FILESYSTEM",
  riskLevel: "LOW",
  requiresWorkspace: true,
  inputSchema: FindInput,
  outputSchema: FindOutput,
  permissions: [{ capability: "fs.list", riskLevel: "LOW", rationale: "Reveals file names in the workspace" }],

  async availability() {
    return { status: "AVAILABLE" };
  },

  async plan(input, env) {
    const path = await resolveWithinWorkspace(input.directory, env.workspaceRoots);
    return [{ capability: "fs.list", resource: { path }, description: `Search ${path} for "${input.pattern}"` }];
  },

  async execute(input, ctx) {
    const base = await resolveWithinWorkspace(input.directory, ctx.workspaceRoots);
    const matches: string[] = [];
    const matches_ = matcherFor(input.pattern);
    let scanned = 0;
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || truncated || ctx.signal.aborted) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED) {
          truncated = true;
          return;
        }
        const full = join(dir, entry.name);
        const rel = relative(base, full).split(sep).join("/");
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.isSymbolicLink()) await walk(full, depth + 1);
        } else if (entry.isFile() && matches_(rel, entry.name)) {
          matches.push(rel);
          if (matches.length >= input.maxResults) {
            truncated = true;
            return;
          }
        }
      }
    };
    await walk(base, 0);
    matches.sort();
    return { directory: base, matches, truncated, scanned: Math.min(scanned, MAX_SCANNED) };
  },
};
