import { expect, test } from "@playwright/test";
import { color } from "../../packages/design-system/src/tokens";

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

  test("navigates between sections and every settings page, each explaining missing data", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "MORROW" });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    for (const section of ["PROJECTS", "MEMORY", "SETTINGS"]) {
      await nav.getByRole("button", { name: new RegExp(section, "i") }).click();
      await expect(nav.getByRole("button", { name: new RegExp(section, "i") })).toHaveAttribute("aria-current", "page");
    }
    const settings = page.getByRole("navigation", { name: "Settings" });
    for (const pageName of ["Models", "Permissions", "Capabilities", "System"]) {
      await settings.getByRole("button", { name: new RegExp(pageName) }).click();
      await expect(settings.getByRole("button", { name: new RegExp(pageName) })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: pageName, exact: true })).toBeVisible();
      await expect(page.locator("header.presence-bar")).toContainText(pageName);
    }
    await settings.getByRole("button", { name: /Capabilities/ }).click();
    await expect(page.getByText("Runtime not connected").first()).toBeVisible();
    // There is no account, appearance or device page: MORROW has no such settings.
    await expect(settings.getByRole("button")).toHaveCount(4);
  });

  test("Ctrl+K goes to the objective from anywhere, and creates nothing", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "MORROW" });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    await nav.getByRole("button", { name: /memory/i }).click();
    await page.keyboard.press("Control+k");
    await expect(nav.getByRole("button", { name: /workspace/i })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("textbox", { name: "Objective" })).toBeVisible();
  });

  test("the authentication design preview (development only) accepts nothing and says so", async ({ page }) => {
    await page.goto("/#preview/auth");
    await expect(page.getByText("Design preview — not connected.")).toBeVisible({ timeout: 10_000 });
    for (const provider of ["Google", "Discord"]) {
      await expect(page.getByRole("button", { name: new RegExp(`Continue with ${provider}`) })).toBeDisabled();
    }
    await expect(page.getByLabel("Email")).toBeDisabled();
    await expect(page.getByLabel("Password")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: "Two-factor" }).click();
    await expect(page.getByRole("heading", { name: "Two-factor verification" })).toBeVisible();
    await page.getByRole("radio", { name: "Devices" }).click();
    await expect(page.getByText("No sessions")).toBeVisible();
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
    expect(tokens.background).toBe(color.background);
    expect(tokens.accent).toBe(color.accent);
    expect(tokens.bodyFont).toContain("IBM Plex Sans");
    expect(tokens.bodyBg).not.toBe("rgb(0, 0, 0)");
  });

  test("respects reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    for (const layer of [".env__fog--far", ".env__smoke", ".env__fog--near"]) {
      const drift = await page.locator(layer).evaluate((el) => getComputedStyle(el).animationName);
      expect(drift, layer).toBe("none");
    }
  });

  test("the presence bar reports real state and every rail section is reachable by keyboard", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "MORROW" });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    const bar = page.locator("header.presence-bar");
    await expect(bar).toContainText("Workspace");
    await expect(bar).toContainText("Native layer unavailable");
    // Nothing to show, so no history toggle and no decisions count.
    await expect(page.getByRole("button", { name: "Task history" })).toHaveCount(0);
    await expect(bar.getByText("Decisions")).toHaveCount(0);

    const workspace = nav.getByRole("button", { name: /workspace/i });
    await workspace.focus();
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("button", { name: /projects/i })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(nav.getByRole("button", { name: /projects/i })).toHaveAttribute("aria-current", "page");
    await expect(bar).toContainText("Projects");
    // The keyboard focus ring is drawn on the item's icon tile.
    const outline = await nav.getByRole("button", { name: /projects/i }).evaluate((el) => getComputedStyle(el.querySelector(".rail__icon")!).outlineStyle);
    expect(outline).not.toBe("none");
  });
});
