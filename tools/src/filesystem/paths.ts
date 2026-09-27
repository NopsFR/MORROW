import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { MorrowError } from "@morrow/shared";
import { isPathWithin } from "@morrow/permissions";

/**
 * Resolve a user/agent-supplied path to a real absolute path inside one of the
 * workspace roots. Symlinks are resolved first, so a link pointing outside the
 * workspace is rejected rather than followed.
 */
export async function resolveWithinWorkspace(inputPath: string, roots: readonly string[]): Promise<string> {
  if (roots.length === 0) {
    throw new MorrowError(
      "NO_WORKSPACE_ROOT",
      "Filesystem access requires a project with a workspace directory",
    );
  }
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(roots[0]!, inputPath);

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new MorrowError("PATH_NOT_FOUND", `No such file or directory: ${inputPath}`);
    throw new MorrowError("PATH_UNRESOLVABLE", `Cannot resolve path: ${inputPath}`, { code });
  }

  await assertWithinRoots(real, roots, inputPath);
  return real;
}

async function assertWithinRoots(real: string, roots: readonly string[], inputPath: string): Promise<void> {
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => resolve(root))));
  if (!realRoots.some((root) => isPathWithin(real, root))) {
    throw new MorrowError("PATH_OUTSIDE_WORKSPACE", `Path is outside the workspace: ${inputPath}`);
  }
}

/**
 * Resolve a path that may not exist yet (a file about to be created). The parent
 * directory must exist and resolve inside a workspace root.
 */
export async function resolveNewPathWithinWorkspace(inputPath: string, roots: readonly string[]): Promise<string> {
  if (roots.length === 0) {
    throw new MorrowError("NO_WORKSPACE_ROOT", "Filesystem access requires a project with a workspace directory");
  }
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(roots[0]!, inputPath);
  const name = basename(candidate);
  if (!name || name === "." || name === "..") throw new MorrowError("INVALID_PATH", `Not a file path: ${inputPath}`);
  let parent: string;
  try {
    parent = await realpath(dirname(candidate));
  } catch {
    throw new MorrowError("PATH_NOT_FOUND", `Directory does not exist: ${dirname(inputPath)}`);
  }
  await assertWithinRoots(parent, roots, inputPath);
  const target = join(parent, name);
  // If the file already exists it may be a symlink; resolve it and check again.
  const existing = await realpath(target).catch(() => null);
  if (existing) await assertWithinRoots(existing, roots, inputPath);
  return existing ?? target;
}
