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

  it("never uses pure black as the foundation", () => {
    expect(color.background.toLowerCase()).not.toBe("#000000");
    expect(color.backgroundDeep.toLowerCase()).not.toBe("#000000");
  });

  it("emits CSS variables and a reduced-motion override", () => {
    const vars = cssVariables();
    expect(vars["--m-color-text-primary"]).toBe(color.textPrimary);
    expect(vars["--m-motion-medium-duration"]).toBe("280ms");
    expect(tokenStylesheet()).toContain("prefers-reduced-motion: reduce");
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
      "opacity var(--m-motion-short-duration, 160ms) cubic-bezier(0.2, 0, 0, 1)",
    );
  });

  it("defines ambient behaviour for each MORROW state; only FAILED destabilises", () => {
    for (const s of AMBIENT_STATES) expect(ambient[s]).toBeDefined();
    expect(AMBIENT_STATES.filter((s) => ambient[s].instability > 0)).toEqual(["FAILED"]);
    expect(ambient.EXECUTING.flow).toBeGreaterThan(ambient.IDLE.flow);
    expect(ambient.PLANNING.convergence).toBeGreaterThan(ambient.IDLE.convergence);
    expect(ambient.WAITING.illumination).toBeLessThan(ambient.IDLE.illumination);
  });
});
