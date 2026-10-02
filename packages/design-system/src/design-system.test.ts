import { describe, expect, it } from "vitest";
import { AMBIENT_STATES, MOTION_CATEGORIES, ambient, color, cssVariables, motion, tokenStylesheet, transition } from "./index";

describe("design tokens", () => {
  it("defines every required semantic colour", () => {
    for (const key of [
      "background", "backgroundDeep", "surface", "surfaceRaised", "surfaceInset", "border", "borderSubtle",
      "textPrimary", "textSecondary", "textMuted", "textDisabled", "accent", "success", "warning", "error", "info",
    ]) {
      expect(color).toHaveProperty(key);
    }
  });

  it("keeps the two lights distinct: brass is identity, teal is the live signal", () => {
    expect(color.accent).toBe("#c9b58a");
    expect(color.signal).not.toBe(color.accent);
    expect(color.signal).not.toBe(color.success);
  });

  it("never uses pure black as the foundation", () => {
    expect(color.background.toLowerCase()).not.toBe("#000000");
    expect(color.backgroundDeep.toLowerCase()).not.toBe("#000000");
  });

  it("emits CSS variables and a reduced-motion override", () => {
    const vars = cssVariables();
    expect(vars["--m-color-text-primary"]).toBe(color.textPrimary);
    expect(vars["--m-motion-medium-duration"]).toBe("320ms");
    expect(tokenStylesheet()).toContain("prefers-reduced-motion: reduce");
  });

  it("emits the material, depth and size foundation", () => {
    const vars = cssVariables();
    for (const name of [
      "--m-color-glass", "--m-color-glass-raised", "--m-color-hairline", "--m-elevation-e2", "--m-blur-panel",
      "--m-size-control", "--m-size-icon", "--m-layout-rail-width", "--m-layout-bar-height", "--m-radius-lg", "--m-layer-overlay",
      "--m-color-glass-hero", "--m-color-signal", "--m-elevation-hero", "--m-elevation-glow-signal", "--m-blur-hero", "--m-radius-hero",
      "--m-type-hero-size", "--m-layout-hero-width",
    ]) {
      expect(vars[name], name).toBeTruthy();
    }
  });

  it("keeps glass restrained: translucent, never close to opaque", () => {
    for (const key of ["glass", "glassRaised", "glassDeep", "glassHero", "glassChip"] as const) {
      const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(color[key])?.[1]);
      expect(alpha, key).toBeGreaterThan(0.4);
      expect(alpha, key).toBeLessThan(0.8);
    }
  });
});

describe("motion", () => {
  it("has the six semantic categories, ordered by duration", () => {
    expect(MOTION_CATEGORIES).toEqual(["INSTANT", "FAST", "SHORT", "MEDIUM", "LONG", "AMBIENT"]);
    const durations = MOTION_CATEGORIES.map((c) => motion[c].durationMs);
    expect([...durations].sort((a, b) => a - b)).toEqual(durations);
  });

  it("builds transitions from categories via overridable variables", () => {
    expect(transition(["opacity"], "SHORT")).toBe(
      "opacity var(--m-motion-short-duration, 180ms) cubic-bezier(0.2, 0, 0, 1)",
    );
  });

  it("defines ambient behaviour for each MORROW state; only FAILED destabilises", () => {
    for (const s of AMBIENT_STATES) expect(ambient[s]).toBeDefined();
    expect(AMBIENT_STATES.filter((s) => ambient[s].instability > 0)).toEqual(["FAILED"]);
    expect(ambient.EXECUTING.flow).toBeGreaterThan(ambient.IDLE.flow);
    expect(ambient.PLANNING.convergence).toBeGreaterThan(ambient.IDLE.convergence);
    expect(ambient.WAITING.illumination).toBeLessThan(ambient.IDLE.illumination);
  });

  it("lights the teal signal only for activity that is really happening", () => {
    const lit = AMBIENT_STATES.filter((s) => ambient[s].signal >= 0.5);
    expect(lit).toEqual(["PLANNING", "EXECUTING", "VERIFYING"]);
    for (const quiet of ["IDLE", "WAITING", "FAILED"] as const) expect(ambient[quiet].signal).toBe(0);
  });
});
