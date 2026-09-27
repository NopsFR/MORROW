/**
 * Stable, generated entity identifiers.
 *
 * Format: `<prefix>_<ulid>` — the prefix makes an ID self-describing in logs,
 * events and audits; the ULID part is time-sortable and collision resistant.
 * IDs are never derived from display names.
 */

export const ID_PREFIXES = {
  project: "prj",
  task: "task",
  taskStep: "step",
  plan: "plan",
  event: "evt",
  observation: "obs",
  verification: "vrf",
  memory: "mem",
  memorySource: "msrc",
  memoryRelation: "mrel",
  memoryRevision: "mrev",
  artifact: "art",
  artifactRelation: "arel",
  toolExecution: "exec",
  permissionGrant: "grant",
  permissionRequest: "preq",
  model: "mdl",
  modelProvider: "prov",
  modelUsage: "usage",
  researchSource: "rsrc",
  researchEvidence: "rev",
  connector: "conn",
  mcpServer: "mcp",
  correlation: "corr",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** Branded ID type: an ID of one kind cannot be passed where another is expected. */
export type Id<K extends IdKind> = string & { readonly __id: K };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Web Crypto is available in both Node (>=19) and WebViews; typed locally to stay lib-agnostic. */
interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}
const randomSource = (globalThis as unknown as { crypto: RandomSource }).crypto;

function encodeRandom(): string {
  const bytes = new Uint8Array(16);
  randomSource.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function newId<K extends IdKind>(kind: K, now?: number): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid(now)}` as Id<K>;
}

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ULID_PATTERN}$`);
}

export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  return typeof value === "string" && idPattern(kind).test(value);
}
