/**
 * Path containment for grant constraints. Inputs must already be absolute and
 * resolved (no `..` segments) — the tool runtime resolves paths before asking.
 */
export function normalizePathForComparison(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  // Windows drive paths are case-insensitive.
  if (/^[a-zA-Z]:(\/|$)/.test(p)) p = p.toLowerCase();
  return p;
}

export function isPathWithin(path: string, prefix: string): boolean {
  const p = normalizePathForComparison(path);
  const root = normalizePathForComparison(prefix);
  if (p.split("/").includes("..")) return false;
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}
