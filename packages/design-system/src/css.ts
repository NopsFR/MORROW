import { blur, color, elevation, font, layer, layout, radius, size, space, type } from "./tokens";
import { MOTION_CATEGORIES, motion } from "./motion";

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/\./g, "_").toLowerCase();

/** All tokens as CSS custom properties (`--m-color-text-primary`, ...). */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(color)) vars[`--m-color-${kebab(k)}`] = v;
  vars["--m-font-sans"] = font.sans;
  vars["--m-font-mono"] = font.mono;
  for (const [k, t] of Object.entries(type)) {
    const name = kebab(k);
    vars[`--m-type-${name}-size`] = t.size;
    vars[`--m-type-${name}-line`] = t.line;
    vars[`--m-type-${name}-weight`] = String(t.weight);
    vars[`--m-type-${name}-tracking`] = t.tracking;
    vars[`--m-type-${name}-family`] = `var(--m-font-${t.family})`;
  }
  for (const [k, v] of Object.entries(space)) vars[`--m-space-${kebab(String(k))}`] = v;
  for (const [k, v] of Object.entries(radius)) vars[`--m-radius-${k}`] = v;
  for (const [k, v] of Object.entries(elevation)) vars[`--m-elevation-${k}`] = v;
  for (const [k, v] of Object.entries(blur)) vars[`--m-blur-${k}`] = v;
  for (const [k, v] of Object.entries(size)) vars[`--m-size-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(layout)) vars[`--m-layout-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(layer)) vars[`--m-layer-${k}`] = String(v);
  for (const c of MOTION_CATEGORIES) {
    vars[`--m-motion-${c.toLowerCase()}-duration`] = `${motion[c].durationMs}ms`;
    vars[`--m-motion-${c.toLowerCase()}-easing`] = motion[c].easing;
  }
  return vars;
}

/** Stylesheet text: tokens on :root, plus the reduced-motion override. */
export function tokenStylesheet(): string {
  const body = Object.entries(cssVariables())
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const reduced = MOTION_CATEGORIES.filter((c) => c !== "INSTANT")
    .map((c) => `    --m-motion-${c.toLowerCase()}-duration: ${c === "FAST" || c === "SHORT" ? "1ms" : "0ms"};`)
    .join("\n");
  return `:root {\n${body}\n}\n@media (prefers-reduced-motion: reduce) {\n  :root {\n${reduced}\n    --m-reduced-motion: 1;\n  }\n}\n`;
}

// There is deliberately no runtime installer: a <style> element created at runtime is
// blocked by the desktop app's production CSP (nonce present → 'unsafe-inline' ignored).
// The desktop build turns `tokenStylesheet()` into static CSS (virtual:morrow-tokens.css).
