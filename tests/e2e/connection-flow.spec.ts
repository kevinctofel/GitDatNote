import { test, expect, type Page } from "@playwright/test";
import { ACCENT_TOKENS } from "../../src/web/theme/tokens";
import { contrastRatio } from "../web/contrast";

/**
 * Task 5.2 — browser E2E coverage for the GitHub connection flow.
 *
 * These tests drive the real React application in a real browser. Every
 * backend response is intercepted with `page.route` and answered with a
 * deterministic fixture shaped exactly like the production API contract:
 *
 * - `GET /api/session` → 200 `{ connected: true, user, csrfToken }`
 *   (or 401/404 for the signed-out state, 5xx for a connection problem);
 * - `GET /api/repositories` → 200 `Repository[]` (owner, name, contentRoot,
 *   canRead, canWrite, private);
 * - `POST /api/auth/logout` → 204 / 403 CSRF_INVALID / 401;
 * - the OAuth start navigation (`/api/auth/github/start`) is answered with a
 *   local, labeled page so no real GitHub network call ever happens.
 *
 * No production route, authentication bypass, fake editor, or test hook is
 * added. The only hook used is the existing dev-only preview markdown hook,
 * which no other test in this file needs.
 *
 * Real layers: browser, Vite dev server, React app, real API client, real
 * routing/interception. Mocked layer: the GitHub-facing backend responses
 * (intercepted in the browser before they leave the page).
 */

/** A session-specific CSRF token in the exact wire shape (32 random bytes,
 * hex-encoded): 64 lowercase hex characters. */
const CSRF_TOKEN = "e".repeat(64);
/** A fresh token the session probe returns after a recheck. */
const CSRF_TOKEN_FRESH = "f".repeat(64);

/** The connected-session body in the exact `SessionState` contract shape.
 * The avatar intentionally points at a non-GitHub host so the safe-avatar
 * path (avatars.githubusercontent.com only) can be asserted. */
function sessionBody(csrfToken: string): unknown {
  return {
    connected: true,
    user: {
      login: "octo-tester",
      name: "Octo Tester",
      avatarUrl: "https://example.com/avatar.png",
    },
    csrfToken,
  };
}

/** A deterministic, contract-faithful repository list covering the three
 * access/visibility combinations the UI must present. */
const REPOSITORIES = [
  {
    owner: "octo-tester",
    name: "public-notes",
    contentRoot: "src/posts",
    canRead: true,
    canWrite: true,
    private: false,
  },
  {
    owner: "octo-tester",
    name: "private-journal",
    contentRoot: "Journal",
    canRead: true,
    canWrite: true,
    private: true,
  },
  {
    owner: "octo-tester",
    name: "read-only-docs",
    contentRoot: "docs",
    canRead: true,
    canWrite: false,
    private: true,
  },
];

function errorBody(code: string, message: string, retryable: boolean, status: number): unknown {
  return { code, message, retryable, status };
}

/**
 * Register a JSON route and await its installation: the route must be in
 * place before the request it intercepts is sent.
 */
async function routeJson(
  page: Page,
  pattern: RegExp,
  status: number,
  body: unknown,
): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** Assert the exact ordered option labels of a `<select>`. */
async function expectOptions(
  page: Page,
  selector: string,
  options: string[],
): Promise<void> {
  const opts = page.locator(`${selector} > option`);
  await expect(opts).toHaveCount(options.length);
  expect(await opts.allTextContents()).toEqual(options);
}

/** Route the session probe to a fixed answer and count its calls. */
async function routeSession(
  page: Page,
  calls: { count: number },
  answer: (call: number) => { status: number; body: unknown },
): Promise<void> {
  // Await route installation before any request reaches the probe.
  await page.route(/\/api\/session/, (route) => {
    calls.count += 1;
    const { status, body } = answer(calls.count);
    route.fulfill({
      status,
      contentType: "application/json",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  });
}

/** Track every request that touches the API surface. */
function trackApiRequests(page: Page): { paths: string[] } {
  const state = { paths: [] as string[] };
  page.on("request", (request) => {
    if (request.url().includes("/api/")) {
      state.paths.push(new URL(request.url()).pathname);
    }
  });
  return state;
}

/** Collect browser console messages (for the credential-leak assertions). */
function collectConsole(page: Page): { messages: string[] } {
  const state = { messages: [] as string[] };
  page.on("console", (message) => state.messages.push(message.text()));
  return state;
}

test.describe("GitHub connection flow (task 5.2, browser E2E)", () => {
  test("disconnected state shows the Connect GitHub action and starts one top-level OAuth navigation", async ({
    page,
  }) => {
    // The app's genuine signed-out signal: the session probe 404s.
    await routeJson(page, /\/api\/session/, 404, "");
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Not connected to GitHub" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /preview the connected layout/i }),
    ).toBeVisible();

    // The OAuth start is a top-level navigation the test intercepts with a
    // local labeled page (no real GitHub call). Awaited so the route is
    // installed before the navigation it intercepts.
    const startCalls = { count: 0 };
    await page.route(/\/api\/auth\/github\/start/, (route) => {
      startCalls.count += 1;
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>GitHub sign-in (intercepted)</body></html>",
      });
    });

    await page.getByRole("button", { name: "Connect GitHub" }).click();

    // Exactly one top-level navigation to the OAuth start.
    await expect(page).toHaveURL(/\/api\/auth\/github\/start$/);
    await expect(page.getByText("GitHub sign-in (intercepted)")).toBeVisible();
    expect(startCalls.count).toBe(1);
  });

  test("labeled sample preview renders fixture data with no live content requests", async ({
    page,
  }) => {
    await routeJson(page, /\/api\/session/, 404, "");
    const api = trackApiRequests(page);
    await page.goto("/");

    const previewButton = page.getByRole("button", {
      name: /preview the connected layout/i,
    });
    await previewButton.waitFor({ state: "visible" });
    await previewButton.click();

    const banner = page.locator(".preview-banner");
    await banner.waitFor({ state: "visible" });
    await expect(banner).toContainText("Preview — sample data only.");
    await expect(banner).toContainText("This is not a live GitHub connection.");

    // The fixture repositories (sample data only) populate the selector.
    const select = page.locator("select#repository-select");
    await select.waitFor({ state: "visible" });
    await expectOptions(page, "select#repository-select", [
      "Choose a repository",
      "sample-org/sample-journal · read-only",
      "sample-org/sample-blog · read+write",
      "sample-user/private-notes · read+write",
    ]);

    // Selecting a fixture repository stays inside the labeled preview.
    await select.selectOption({ index: 1 });
    await expect(page.locator("h2")).toHaveText("sample-org/sample-journal");

    // No live API call for repositories (or anything else) was made.
    expect(api.paths.filter((p) => p === "/api/repositories")).toHaveLength(0);
    expect(api.paths.every((p) => p === "/api/session")).toBe(true);
  });

  test("connected session presents identity, safe avatar, and no credentials in DOM or console", async ({
    page,
  }) => {
    const sessionCalls = { count: 0 };
    await routeSession(page, sessionCalls, () => ({
      status: 200,
      body: sessionBody(CSRF_TOKEN),
    }));
    await routeJson(page, /\/api\/repositories/, 200, REPOSITORIES);
    const console = collectConsole(page);

    await page.goto("/");

    await expect(page.getByText("Signed in as octo-tester")).toBeVisible();
    await expect(
      page.getByText("Octo Tester (octo-tester)"),
    ).toBeVisible();
    await expect(page.getByText("Connected to GitHub")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Disconnect" }),
    ).toBeVisible();

    // The avatar host is not avatars.githubusercontent.com, so the safe
    // avatar path must omit the image entirely.
    await expect(page.locator("img.avatar")).toHaveCount(0);

    // The session CSRF token is a credential: it must never be rendered or
    // logged.
    const html = await page.evaluate(() => document.documentElement.innerHTML);
    expect(html).not.toContain(CSRF_TOKEN);
    expect(console.messages.join("\n")).not.toContain(CSRF_TOKEN);
  });

  test("repository discovery renders the list and a writable repository selection", async ({
    page,
  }) => {
    await routeSession(page, { count: 0 }, () => ({
      status: 200,
      body: sessionBody(CSRF_TOKEN),
    }));
    await routeJson(page, /\/api\/repositories/, 200, REPOSITORIES);

    await page.goto("/");

    const select = page.locator("select#repository-select");
    await select.waitFor({ state: "visible" });
    await expectOptions(page, "select#repository-select", [
      "Choose a repository",
      "octo-tester/public-notes · read+write",
      "octo-tester/private-journal · read+write",
      "octo-tester/read-only-docs · read-only",
    ]);

    // No repository selected yet: the labeled content placeholder.
    await expect(
      page.getByText("Select a repository to view its content."),
    ).toBeVisible();

    await select.selectOption({ label: "octo-tester/public-notes · read+write" });
    await expect(page.locator("h2")).toHaveText("octo-tester/public-notes");
    await expect(page.getByText("Access: read + write")).toBeVisible();
    await expect(page.getByText("Visibility: public")).toBeVisible();
    await expect(
      page.getByText(
        "Repository content reading is not implemented yet — a later foundation task.",
      ),
    ).toBeVisible();
  });

  test("switching repositories updates the metadata for private and read-only access", async ({
    page,
  }) => {
    await routeSession(page, { count: 0 }, () => ({
      status: 200,
      body: sessionBody(CSRF_TOKEN),
    }));
    await routeJson(page, /\/api\/repositories/, 200, REPOSITORIES);

    await page.goto("/");

    const select = page.locator("select#repository-select");
    await select.waitFor({ state: "visible" });

    await select.selectOption({ label: "octo-tester/private-journal · read+write" });
    await expect(page.locator("h2")).toHaveText("octo-tester/private-journal");
    await expect(page.getByText("Access: read + write")).toBeVisible();
    await expect(page.getByText("Visibility: private")).toBeVisible();

    await select.selectOption({ label: "octo-tester/read-only-docs · read-only" });
    await expect(page.locator("h2")).toHaveText("octo-tester/read-only-docs");
    await expect(page.getByText("Access: read-only")).toBeVisible();
    await expect(page.getByText("Visibility: private")).toBeVisible();
  });

  test("repository discovery failure shows a labeled recovery and a functional retry", async ({
    page,
  }) => {
    await routeSession(page, { count: 0 }, () => ({
      status: 200,
      body: sessionBody(CSRF_TOKEN),
    }));
    // Stateful fixture: the outage stays in place until the test clears it
    // after confirming the error UI. (In the dev StrictMode build the mount
    // effect runs twice, so an index-based "first call fails" fixture would
    // be auto-recovered before the assertion.)
    const repoCalls = { count: 0 };
    let failing = true;
    await page.route(/\/api\/repositories/, (route) => {
      repoCalls.count += 1;
      route.fulfill({
        status: failing ? 502 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          failing
            ? errorBody(
                "GITHUB_UNAVAILABLE",
                "GitHub is temporarily unavailable.",
                true,
                502,
              )
            : REPOSITORIES,
        ),
      });
    });

    await page.goto("/");

    // The shared recovery copy for GitHub unavailability.
    await expect(
      page.getByText("GitHub is unreachable — check your connection and retry."),
    ).toBeVisible();

    // The outage clears before the retry is clicked, so the retry is what
    // recovers the list.
    failing = false;
    await page.getByRole("button", { name: "Retry" }).click();

    // The retry recovered: the repository list is live and selectable.
    await expectOptions(page, "select#repository-select", [
      "Choose a repository",
      "octo-tester/public-notes · read+write",
      "octo-tester/private-journal · read+write",
      "octo-tester/read-only-docs · read-only",
    ]);
    await expect(
      page.getByText("Select a repository to view its content."),
    ).toBeVisible();
    expect(repoCalls.count).toBeGreaterThanOrEqual(2);
  });

  test("a session-expired repository discovery reconciles to the disconnected state without leaking the error code", async ({
    page,
  }) => {
    await routeSession(page, { count: 0 }, () => ({
      status: 200,
      body: sessionBody(CSRF_TOKEN),
    }));
    await routeJson(
      page,
      /\/api\/repositories/,
      401,
      errorBody(
        "UNAUTHORIZED",
        "Your GitHub session is no longer valid. Please sign in again.",
        false,
        401,
      ),
    );

    await page.goto("/");

    // The definitive 401 UNAUTHORIZED from repository discovery reconciles
    // to the disconnected view (no raw error code is rendered).
    await expect(
      page.getByRole("heading", { name: "Not connected to GitHub" }),
    ).toBeVisible();
    await expect(page.getByText("Signed in as octo-tester")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible();
    await expect(page.getByText("UNAUTHORIZED")).toHaveCount(0);
  });

  test("a CSRF-rejected logout keeps the connection, explains the failure, and offers a session recheck", async ({
    page,
  }) => {
    const sessionCalls = { count: 0 };
    await routeSession(page, sessionCalls, (call) =>
      call === 1
        ? { status: 200, body: sessionBody(CSRF_TOKEN) }
        : { status: 200, body: sessionBody(CSRF_TOKEN_FRESH) },
    );
    await routeJson(page, /\/api\/repositories/, 200, REPOSITORIES);

    const logoutCalls = { count: 0 };
    await page.route(/\/api\/auth\/logout/, (route) => {
      logoutCalls.count += 1;
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify(
          errorBody(
            "CSRF_INVALID",
            "Your session token was missing or invalid. Please try again.",
            false,
            403,
          ),
        ),
      });
    });

    await page.goto("/");
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    await page.getByRole("button", { name: "Disconnect" }).click();

    // The CSRF boundary rejected the logout: the UI must not claim a
    // disconnect it did not get. The connection stays, the failure is
    // explained safely, and a recheck is offered.
    await expect(page.getByRole("alert")).toContainText("Couldn't disconnect:");
    await expect(
      page.getByText("Your GitHub connection is still active."),
    ).toBeVisible();
    await expect(page.getByText("Signed in as octo-tester")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Not connected to GitHub" })).toHaveCount(0);
    // The rejected token is never rendered.
    const html = await page.evaluate(() => document.documentElement.innerHTML);
    expect(html).not.toContain(CSRF_TOKEN);

    // Rechecking the session re-probes and restores the Disconnect control
    // (with the fresh token) — without resending the rejected logout.
    // The count is asserted relative to the recheck: in the dev StrictMode
    // build the mount probe can run more than once.
    const probesBeforeRecheck = sessionCalls.count;
    await page.getByRole("button", { name: "Recheck session" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await expect(page.getByText("Signed in as octo-tester")).toBeVisible();

    expect(logoutCalls.count).toBe(1);
    expect(sessionCalls.count).toBe(probesBeforeRecheck + 1);
  });

  test("an unrecoverable session probe failure shows a labeled connection problem with a working retry", async ({
    page,
  }) => {
    // Stateful fixture: the session probe keeps failing until the test
    // clears it after confirming the error UI (same StrictMode rationale as
    // the repository-retry test).
    const sessionCalls = { count: 0 };
    let failing = true;
    await page.route(/\/api\/session/, (route) => {
      sessionCalls.count += 1;
      route.fulfill({
        status: failing ? 502 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          failing
            ? errorBody(
                "GITHUB_UNAVAILABLE",
                "GitHub is temporarily unavailable.",
                true,
                502,
              )
            : sessionBody(CSRF_TOKEN),
        ),
      });
    });
    await routeJson(page, /\/api\/repositories/, 200, REPOSITORIES);

    await page.goto("/");

    // Not silently disconnected: a labeled, retryable connection problem.
    await expect(
      page.getByRole("heading", { name: "Connection problem" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "GitHub sign-in and note access are unavailable until the connection is restored.",
      ),
    ).toBeVisible();

    // The connection recovers before the retry is clicked.
    const probesBeforeRetry = sessionCalls.count;
    failing = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Signed in as octo-tester")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Disconnect" }),
    ).toBeVisible();
    expect(sessionCalls.count).toBe(probesBeforeRetry + 1);
  });

  test("the disconnected state issues no live repository or content requests", async ({
    page,
  }) => {
    await routeJson(page, /\/api\/session/, 404, "");
    const api = trackApiRequests(page);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Not connected to GitHub" }),
    ).toBeVisible();

    // While disconnected the app only probes the session; it never fetches
    // repositories or content.
    expect(api.paths.length).toBeGreaterThan(0);
    expect(api.paths.every((p) => p === "/api/session")).toBe(true);
  });
});

/**
 * Task 1.4 contrast correction — browser regression coverage for the
 * Settings entry button. The entry's label must use the approved Task 1.2
 * pairing (`--text-on-accent-strong` #FFFFFF on an `--accent-strong` fill
 * and border), reaching 4.5:1. Hover must NOT change those colors — a
 * whole-element filter dims the label too and dropped Ocean to ~4.32:1;
 * the hover lifts the button with the `--shadow-md` token instead.
 * Selecting a palette in the hub must re-theme the button immediately,
 * without a reload.
 */
/** Expected CSS `rgb()` form of a #RRGGBB hex color. */
function hexToRgbCss(hex: string): string {
  const v = hex.replace("#", "");
  return (
    `rgb(${parseInt(v.slice(0, 2), 16)}, ` +
    `${parseInt(v.slice(2, 4), 16)}, ` +
    `${parseInt(v.slice(4, 6), 16)})`
  );
}

/** The entry button's computed label color, fill, border, filter, and shadow. */
function entryColors(entry: ReturnType<Page["locator"]>): Promise<{
  background: string;
  border: string;
  color: string;
  filter: string;
  boxShadow: string;
}> {
  return entry.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      border: s.borderTopColor,
      color: s.color,
      filter: s.filter,
      boxShadow: s.boxShadow,
    };
  });
}

test.describe("Settings entry contrast pairing (task 1.4, browser E2E)", () => {
  test("hover lifts the entry with a shadow, keeps the approved colors, and re-themes immediately on palette change", async ({
    page,
  }) => {
    await routeJson(page, /\/api\/session/, 404, "");
    await page.goto("/");

    const entry = page.locator(".settings-entry");
    await expect(entry).toBeVisible();

    // Default palette (lavender), at rest: fill and border must be
    // --accent-strong, the label must be --text-on-accent-strong (#FFFFFF),
    // the measured pairing must reach the AA floor, and no filter or
    // shadow applies.
    const before = await entryColors(entry);
    expect(before.filter).toBe("none");
    expect(before.boxShadow).toBe("none");
    expect(before.background).toBe(
      hexToRgbCss(ACCENT_TOKENS.lavender["--accent-strong"]),
    );
    expect(before.border).toBe(hexToRgbCss(ACCENT_TOKENS.lavender["--accent-strong"]));
    expect(before.color).toBe("rgb(255, 255, 255)");
    expect(
      contrastRatio("#FFFFFF", ACCENT_TOKENS.lavender["--accent-strong"]),
      "lavender entry label contrast",
    ).toBeGreaterThanOrEqual(4.5);

    // Hovered at rest (still lavender): the hover is a --shadow-md lift —
    // the shadow appears, no filter applies, and the computed label and
    // fill colors are exactly the approved token values.
    await entry.hover();
    const hoveredLavender = await entryColors(entry);
    expect(hoveredLavender.boxShadow).toMatch(/0px 2px 8px 0px/);
    expect(hoveredLavender.filter).toBe("none");
    expect(hoveredLavender.background).toBe(before.background);
    expect(hoveredLavender.border).toBe(before.border);
    expect(hoveredLavender.color).toBe("rgb(255, 255, 255)");

    // Open the hub (the Appearance tab is the default) and pick Ocean.
    await entry.click();
    await expect(page.locator("#settings-hub")).toBeVisible();
    await page.getByRole("button", { name: "Ocean" }).click();

    // No reload: the entry must carry Ocean's --accent-strong fill and
    // border immediately, with the label pairing still above the floor.
    const after = await entryColors(entry);
    expect(after.filter).toBe("none");
    expect(after.boxShadow).toBe("none");
    expect(after.background).toBe(hexToRgbCss(ACCENT_TOKENS.ocean["--accent-strong"]));
    expect(after.border).toBe(hexToRgbCss(ACCENT_TOKENS.ocean["--accent-strong"]));
    expect(after.color).toBe("rgb(255, 255, 255)");
    expect(
      contrastRatio("#FFFFFF", ACCENT_TOKENS.ocean["--accent-strong"]),
      "ocean entry label contrast",
    ).toBeGreaterThanOrEqual(4.5);

    // Ocean hovered: the hover affordance appears and the computed text
    // and background colors remain the approved white and Ocean
    // --accent-strong values — no whole-element dimming.
    await entry.hover();
    const hoveredOcean = await entryColors(entry);
    expect(hoveredOcean.boxShadow).toMatch(/0px 2px 8px 0px/);
    expect(hoveredOcean.filter).toBe("none");
    expect(hoveredOcean.background).toBe(after.background);
    expect(hoveredOcean.border).toBe(after.border);
    expect(hoveredOcean.color).toBe("rgb(255, 255, 255)");
  });
});
