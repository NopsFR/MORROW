import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MorrowError } from "@morrow/shared";
import type { Tool } from "../contract";
import { resolveNewPathWithinWorkspace } from "./paths";

const MAX_WRITE_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".csv": "text/csv",
};

const WriteInput = z.object({
  path: z.string().min(1).describe("File path, absolute or relative to the workspace root"),
  content: z.string().describe("Complete UTF-8 text content of the file"),
  overwrite: z.boolean().default(false).describe("Replace the file if it already exists"),
});
const WriteOutput = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  sha256: z.string(),
  created: z.boolean(),
  artifactId: z.string(),
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export const writeTextFileTool: Tool<typeof WriteInput, typeof WriteOutput> = {
  id: "filesystem.write_text_file",
  name: "Write text file",
  description:
    "Create a UTF-8 text file inside the project workspace (up to 1 MiB). Replacing an existing file requires overwrite: true and is higher risk.",
  version: "1.0.0",
  category: "FILESYSTEM",
  riskLevel: "MEDIUM",
  requiresWorkspace: true,
  inputSchema: WriteInput,
  outputSchema: WriteOutput,
  permissions: [
    { capability: "fs.write", riskLevel: "MEDIUM", rationale: "Creates files in the workspace" },
  ],

  async availability() {
    return { status: "AVAILABLE" };
  },

  async plan(input, env) {
    if (Buffer.byteLength(input.content, "utf8") > MAX_WRITE_BYTES) {
      throw new MorrowError("CONTENT_TOO_LARGE", "Content exceeds 1 MiB");
    }
    const path = await resolveNewPathWithinWorkspace(input.path, env.workspaceRoots);
    const present = await exists(path);
    if (present && !input.overwrite) {
      throw new MorrowError("FILE_EXISTS", `${input.path} already exists; set overwrite to replace it`);
    }
    return [
      present
        ? { capability: "fs.write", riskLevel: "HIGH", resource: { path }, description: `Overwrite ${path}` }
        : { capability: "fs.write", resource: { path }, description: `Create ${path}` },
    ];
  },

  async execute(input, ctx) {
    const path = await resolveNewPathWithinWorkspace(input.path, ctx.workspaceRoots);
    const created = !(await exists(path));
    const data = Buffer.from(input.content, "utf8");
    try {
      // "wx" refuses to clobber a file that appeared after planning.
      await writeFile(path, data, { flag: input.overwrite ? "w" : "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MorrowError("FILE_EXISTS", `${input.path} already exists`);
      }
      throw error;
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    const artifact = ctx.recordArtifact({
      kind: "FILE",
      title: basename(path),
      uri: pathToFileURL(path).href,
      mimeType: MIME[extname(path).toLowerCase()] ?? "text/plain",
      contentHash: sha256,
      sizeBytes: data.byteLength,
    });
    return { path, bytesWritten: data.byteLength, sha256, created, artifactId: artifact.id };
  },
};
