import type { Observation } from "@morrow/schemas";

/**
 * Direct evidence is text MORROW can find in an observation it recorded. A verdict may
 * quote an observation; the quote counts only if it is really there. This is how a
 * model's statement ("the version is 2.4.1") stays traceable to what a tool returned.
 *
 * Matching ignores presentation, never content. The model sees observation data as
 * JSON, so it may quote it escaped (`version = \"2.4.1\"`), unescaped
 * (`version = "2.4.1"`), or with JSON structure around unescaped text. Escape sequences
 * may be decoded (both readings are tried), and only letters, digits, `.` and `-` are
 * compared — in order, contiguous.
 * Punctuation, quotes, brackets and spacing do not decide whether a fact is present;
 * every letter and digit of the excerpt must still be there, so "2.4.2" or "241" never
 * match "2.4.1".
 */

const MIN_SIGNIFICANT = 3;

/** Decode the escapes a JSON rendering adds (a model copying it may or may not keep them). */
function decode(text: string): string {
  return text.replace(/\\(["\\/nrt])/g, (_, c: string) => (c === "n" || c === "r" || c === "t" ? " " : c));
}

/** The content of a text, without presentation: lowercase letters, digits, "." and "-". */
function significant(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}.-]+/gu, "");
}

/**
 * Both readings of a text, raw and decoded. Decoding alone would be wrong for a Windows
 * path quoted without escapes (`C:\new` is not a newline), so both are compared.
 */
function readings(text: string): string[] {
  return [...new Set([significant(text), significant(decode(text))])];
}

function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) {
    out.push(k);
    leaves(v, out);
  }
  return out;
}

/** String and number values of observation data (no keys). */
function values(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) values(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) values(v, out);
  return out;
}

/**
 * The texts an excerpt may be found in: the observation's data as the model saw it
 * (JSON, escapes decoded), its values as written, and its summary.
 */
function haystacks(observation: Observation): string[] {
  return [
    ...readings(JSON.stringify(observation.data)),
    significant(leaves(observation.data).join(" ")),
    // Values in order, without keys: how prompts render some observations (e.g. a failed
    // call as "CODE: message"), so a quote of that rendering is a quote of real content.
    significant(values(observation.data).join(" ")),
    significant(observation.summary),
  ];
}

function contains(hay: readonly string[], excerpt: string): boolean {
  const needles = readings(excerpt).filter((n) => n.replace(/[.-]/g, "").length >= MIN_SIGNIFICANT);
  return needles.length > 0 && needles.some((n) => hay.some((h) => h.includes(n)));
}

/** Whether `excerpt` appears in the observation (ignoring presentation, see above). */
export function excerptInObservation(excerpt: string, observation: Observation): boolean {
  return contains(haystacks(observation), excerpt);
}

/** Whether `excerpt` appears in a plain text, such as the composed answer or the objective. */
export function excerptInText(excerpt: string, text: string): boolean {
  return contains(readings(text), excerpt);
}

/**
 * How a finding (a few words of the answer) relates to the objective and the evidence, word
 * by word and regardless of order or phrasing: a word that is neither the user's own nor in
 * the evidence is `missing`; `inEvidence` are the words found in what the tools returned.
 * Words with fewer than three letters or digits carry no content and are ignored.
 */
export function traceFinding(finding: string, objective: string, observations: readonly Observation[]) {
  const objectiveText = readings(objective);
  // Only what the tool returned: values, not JSON keys (structure) or MORROW's summary (metadata).
  const hay = observations.flatMap((o) => values(o.data)).flatMap((v) => readings(v));
  const content = finding
    .split(/\s+/)
    .map((w) => ({ word: w, sig: significant(decode(w)).replace(/^[.-]+|[.-]+$/g, "") }))
    .filter((w) => w.sig.replace(/[.-]/g, "").length >= MIN_SIGNIFICANT);
  const found = (w: { sig: string }) => hay.some((h) => h.includes(w.sig));
  const missing = content.filter((w) => !found(w) && !objectiveText.some((t) => t.includes(w.sig)));
  return { inEvidence: content.filter(found).map((w) => w.word), missing: missing.map((w) => w.word) };
}
