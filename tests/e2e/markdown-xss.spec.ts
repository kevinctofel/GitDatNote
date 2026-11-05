import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Drives the real application to render `markdown` through its actual
 * Markdown pipeline (`marked` → real `DOMPurify` → `MarkdownPreview`) and
 * returns the rendered `<article>` so tests can assert on the live browser
 * DOM. DOMPurify is never mocked — it is the real browser sanitizer.
 *
 * Setup (task 2.7):
 * - The session probe is answered with an empty 404, the app's genuine
 *   "no GitHub session" signal, which reveals the explicitly labeled sample
 *   preview affordance. No GitHub credentials, no live repository, and no
 *   production route or authentication bypass are involved.
 * - A dev-only override hook (exposed only in dev mode) feeds `markdown` to
 *   the preview's `MarkdownPreview`. In production builds the hook does not
 *   exist and the preview renders its fixed safe fixture, so malicious
 *   payloads can never appear as real user content.
 */
async function renderMarkdownInApp(page: Page, markdown: string): Promise<Locator> {
  // Answer the session probe with the app's real signed-out signal (404,
  // empty body so the client maps it to status 404 and lands disconnected).
  await page.route(/\/api\/session/, (route) =>
    route.fulfill({ status: 404, body: "" }),
  );

  // Sentinel that any injected <script>, event handler, or javascript: link
  // could flip if the sanitizer failed.
  await page.addInitScript(() => {
    (globalThis as { __xssTriggered: boolean }).__xssTriggered = false;
  });

  await page.goto("/");

  // Wait for the disconnected affordance that offers the sample preview.
  const previewButton = page.getByRole("button", {
    name: /preview the connected layout/i,
  });
  await previewButton.waitFor({ state: "visible" });

  // Feed the payload to the preview via the dev-only hook (dev mode only).
  await page.evaluate((md: string) => {
    (globalThis as { __setDevPreviewMarkdown: (m: string) => void })
      .__setDevPreviewMarkdown(md);
  }, markdown);

  // Open the preview to render ConnectedView with the fixture repositories.
  await previewButton.click();
  await page.locator(".preview-banner").waitFor({ state: "visible" });

  // Select the first fixture repository to reveal the content area, which
  // renders the Markdown through the real pipeline into the browser DOM.
  const select = page.locator("select");
  await select.waitFor({ state: "visible" });
  await select.selectOption({ index: 1 });

  const article = page.locator(".markdown-preview");
  await article.waitFor({ state: "visible" });
  return article;
}

/** Read the execution sentinel installed by `addInitScript`. */
function xssTriggered(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (globalThis as { __xssTriggered: boolean }).__xssTriggered,
  );
}

test.describe("Markdown XSS regression (foundation task 2.7)", () => {
  test("strips raw <script> elements", async ({ page }) => {
    const article = await renderMarkdownInApp(
      page,
      "hello <script>window.__xssTriggered = true</script> world",
    );
    await expect(article.locator("script")).toHaveCount(0);
    await expect(article).toContainText("hello");
    expect(await xssTriggered(page)).toBe(false);
  });

  test("neutralizes onerror event handlers", async ({ page }) => {
    const article = await renderMarkdownInApp(
      page,
      'safe text <img src="missing-image" onerror="window.__xssTriggered = true">',
    );
    const onerror = await article
      .locator("img")
      .first()
      .getAttribute("onerror")
      .catch(() => null);
    expect(onerror).toBeNull();
    // Give any (leaked) handler time to fire before asserting no execution.
    await page.waitForTimeout(200);
    expect(await xssTriggered(page)).toBe(false);
  });

  test("neutralizes onload event handlers", async ({ page }) => {
    const article = await renderMarkdownInApp(
      page,
      '<svg onload="window.__xssTriggered = true"><circle r="1"></circle></svg>',
    );
    const onload = await article
      .locator("svg")
      .first()
      .getAttribute("onload")
      .catch(() => null);
    expect(onload).toBeNull();
    await page.waitForTimeout(200);
    expect(await xssTriggered(page)).toBe(false);
  });

  test("neutralizes javascript: link schemes", async ({ page }) => {
    // Space-free destination so `marked` actually parses it as a link; the
    // real DOMPurify must then neutralize the javascript: scheme.
    const article = await renderMarkdownInApp(
      page,
      "[click me](javascript:alert(1))",
    );
    // Core security property: no anchor in the rendered DOM carries a
    // javascript: href. DOMPurify may drop the anchor entirely or keep it
    // with a neutralized href, so assert the scheme is gone, not a count.
    const hrefs: Array<string | null> = await article
      .locator("a")
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")));
    for (const href of hrefs) {
      expect(href ?? "").not.toMatch(/^javascript:/i);
    }
    await page.waitForTimeout(200);
    expect(await xssTriggered(page)).toBe(false);
  });

  test("strips raw <iframe> elements", async ({ page }) => {
    const article = await renderMarkdownInApp(
      page,
      'before <iframe src="javascript:window.__xssTriggered = true"></iframe> after',
    );
    await expect(article.locator("iframe")).toHaveCount(0);
    await expect(article).toContainText("before");
    expect(await xssTriggered(page)).toBe(false);
  });

  test("strips raw <object> elements", async ({ page }) => {
    const article = await renderMarkdownInApp(
      page,
      '<object data="javascript:window.__xssTriggered = true"></object>',
    );
    await expect(article.locator("object")).toHaveCount(0);
    expect(await xssTriggered(page)).toBe(false);
  });

  test("still renders a heading", async ({ page }) => {
    const article = await renderMarkdownInApp(page, "# Heading one");
    const h1 = article.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText("Heading one");
  });

  test("still renders a safe link", async ({ page }) => {
    const article = await renderMarkdownInApp(page, "[GitHub](https://github.com)");
    const a = article.locator("a");
    await expect(a).toHaveCount(1);
    await expect(a).toHaveAttribute("href", "https://github.com");
    await expect(a).toContainText("GitHub");
  });

  test("still renders emphasis", async ({ page }) => {
    const article = await renderMarkdownInApp(page, "**bold** and *italic*");
    await expect(article.locator("strong")).toHaveText("bold");
    await expect(article.locator("em")).toHaveText("italic");
  });

  test("still renders a list", async ({ page }) => {
    const article = await renderMarkdownInApp(page, "- one\n- two");
    const items = article.locator("ul > li");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveText("one");
  });
});
