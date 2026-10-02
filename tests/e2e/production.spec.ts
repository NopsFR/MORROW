import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The production build under the desktop app's real Content-Security-Policy.
 *
 * Tauri adds a nonce to `script-src` and `style-src` in production and puts it on the
 * page's own tags. With a nonce present, browsers ignore 'unsafe-inline', so anything
 * the app injects at runtime (a <style> element, say) is blocked. This test does the
 * same: the policy is read from tauri.conf.json, a nonce is added to it and to the
 * built HTML's tags, and the page must still be fully styled and violation-free.
 */
const NONCE = "e2e-nonce";
const conf = JSON.parse(readFileSync(new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const policy = (conf.app.security.csp as string)
  .split(";")
  .map((d) => d.trim())
  .map((d) => (/^(script-src|style-src)\b/.test(d) ? `${d} 'nonce-${NONCE}'` : d))
  .join("; ");

async function underProductionCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${NONCE}"`);
    await route.fulfill({ response, body: html, headers: { ...response.headers(), "content-security-policy": policy } });
  });
  return violations;
}

test("the production build is styled by MORROW's tokens under the desktop CSP", async ({ page }) => {
  const violations = await underProductionCsp(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "MORROW" })).toBeVisible();

  const applied = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      background: root.getPropertyValue("--m-color-background").trim(),
      accent: root.getPropertyValue("--m-color-accent").trim(),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(applied.background).toBe("#0d0e10");
  expect(applied.accent).toBe("#c9b58a");
  expect(applied.bodyFont).toContain("IBM Plex Sans");
  expect(violations).toEqual([]);
});
