import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MorrowError } from "@morrow/shared";
import type { Tool } from "../contract";
import { resolveWithinWorkspace } from "./paths";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;

const ReadInput = z.object({
  path: z.string().min(1).describe("File path, absolute or relative to the workspace root"),
});
const ReadOutput = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean(),
});

export const readTextFileTool: Tool<typeof ReadInput, typeof ReadOutput> = {
  id: "filesystem.read_text_file",
  name: "Read text file",
  description: "Read a UTF-8 text file inside the project workspace (up to 1 MiB).",
  version: "1.0.0",
  category: "FILESYSTEM",
  riskLevel: "LOW",
  inputSchema: ReadInput,
  outputSchema: ReadOutput,
  permissions: [{ capability: "fs.read", riskLevel: "LOW", rationale: "Reads file contents from the workspace" }],

  async availability() {
    return { status: "AVAILABLE" };
  },

  async plan(input, env) {
    const path = await resolveWithinWorkspace(input.path, env.workspaceRoots);
    return [{ capability: "fs.read", resource: { path }, description: `Read ${path}` }];
  },

  async execute(input, ctx) {
    const path = await resolveWithinWorkspace(input.path, ctx.workspaceRoots);
    const info = await stat(path);
    if (!info.isFile()) throw new MorrowError("NOT_A_FILE", `${input.path} is not a regular file`);

    const length = Math.min(info.size, MAX_READ_BYTES);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      if (buffer.includes(0)) throw new MorrowError("BINARY_FILE", `${input.path} appears to be binary`);
      return {
        path,
        sizeBytes: info.size,
        content: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
        truncated: info.size > MAX_READ_BYTES,
      };
    } finally {
      await handle.close();
    }
  },
};

const ListInput = z.object({
  path: z.string().min(1).default(".").describe("Directory path, absolute or relative to the workspace root"),
});
const ListOutput = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), kind: z.enum(["file", "directory", "symlink", "other"]) })),
  truncated: z.boolean(),
});

export const listDirectoryTool: Tool<typeof ListInput, typeof ListOutput> = {
  id: "filesystem.list_directory",
  name: "List directory",
  description: "List the entries of a directory inside the project workspace.",
  version: "1.0.0",
  category: "FILESYSTEM",
  riskLevel: "LOW",
  inputSchema: ListInput,
  outputSchema: ListOutput,
  permissions: [{ capability: "fs.list", riskLevel: "LOW", rationale: "Reveals file names in the workspace" }],

  async availability() {
    return { status: "AVAILABLE" };
  },

  async plan(input, env) {
    const path = await resolveWithinWorkspace(input.path, env.workspaceRoots);
    return [{ capability: "fs.list", resource: { path }, description: `List ${path}` }];
  },

  async execute(input, ctx) {
    const path = await resolveWithinWorkspace(input.path, ctx.workspaceRoots);
    const dirents = await readdir(path, { withFileTypes: true });
    const entries = dirents.slice(0, MAX_LIST_ENTRIES).map((d) => ({
      name: d.name,
      kind: d.isFile() ? ("file" as const) : d.isDirectory() ? ("directory" as const) : d.isSymbolicLink() ? ("symlink" as const) : ("other" as const),
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: join(path), entries, truncated: dirents.length > MAX_LIST_ENTRIES };
  },
};

export const filesystemTools = [readTextFileTool, listDirectoryTool] as const;
