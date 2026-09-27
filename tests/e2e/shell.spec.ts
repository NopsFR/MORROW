import { expect, test } from "@playwright/test";

test.describe("MORROW shell outside the desktop runtime", () => {
  test("boots honestly and settles into the quiet workspace", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "MORROW" })).toBeVisible();
    // Every subsystem reports unavailable instead of faking readiness.
    await expect(page.getByText("READY · DEGRADED")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("navigation", { name: "MORROW" })).toBeVisible({ timeout: 10_000 });
    const field = page.getByRole("textbox", { name: "Objective" });
    await expect(field).toHaveAttribute("placeholder", "Tell MORROW what you want to accomplish...");
    await expect(field).toBeDisabled();
    await expect(page.getByText("Agent runtime not connected")).toBeVisible();
    await expect(page.getByText("Native layer unavailable").first()).toBeVisible();

    // No greeting copy, no fabricated activity.
    await expect(page.getByText(/how can i help|welcome|hello/i)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Tasks" })).toHaveCount(0);
  });

  test("navigates between sections, each explaining missing data", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "MORROW" });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    for (const section of ["PROJECTS", "MEMORY", "TOOLS", "MODELS", "SYSTEM"]) {
      await nav.getByRole("button", { name: new RegExp(section) }).click();
      await expect(nav.getByRole("button", { name: new RegExp(section) })).toHaveAttribute("aria-current", "page");
    }
    await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
    await nav.getByRole("button", { name: /TOOLS/ }).click();
    await expect(page.getByText("Runtime not connected").first()).toBeVisible();
  });

  test("uses MORROW design tokens and typography", async ({ page }) => {
    await page.goto("/");
    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        background: root.getPropertyValue("--m-color-background").trim(),
        accent: root.getPropertyValue("--m-color-accent").trim(),
        bodyFont: getComputedStyle(document.body).fontFamily,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(tokens.background).toBe("#0d0e10");
    expect(tokens.accent).toBe("#c9b58a");
    expect(tokens.bodyFont).toContain("IBM Plex Sans");
    expect(tokens.bodyBg).not.toBe("rgb(0, 0, 0)");
  });

  test("respects reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const drift = await page.locator(".env__fog--far").evaluate((el) => getComputedStyle(el).animationName);
    expect(drift).toBe("none");
  });
});
