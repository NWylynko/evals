import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import {
  NEXT_DEV_READY_PATTERN,
  NEXT_DEV_URL_PATTERN,
  createPiSuiteHarness,
  startWorkspaceDevServer,
  type PiHarness,
  type WorkspaceDevServer,
} from "../pi-harness/index.ts";

/** Next dev compiles a route on first request, so the first hit is slow. */
const PAGE_TIMEOUT_MS = 90_000;

/**
 * A multi-stage agentic eval: one Next.js app, built up across three prompts and
 * checked in a real browser.
 *
 * Every stage runs in the SAME workspace and depends on the previous one, so the
 * suite shares one harness and each stage skips itself if an earlier stage did
 * not complete — otherwise one broken stage produces three confusing failures.
 *
 * Verification runs the app rather than grepping source: a file containing the
 * right string proves nothing if the app does not compile, the route does not
 * exist, or the component never renders. The dev server starts once after the
 * scaffold and is reused; Next recompiles on each request, so later stages see
 * the agent's edits without a restart.
 */
describe("nextjs app", () => {
  let harness: PiHarness;
  let devServer: WorkspaceDevServer | undefined;
  let browser: Browser | undefined;
  /** Highest stage that finished successfully; gates the stages after it. */
  let completedStage = 0;

  beforeAll(async () => {
    harness = await createPiSuiteHarness();
  });

  afterAll(async () => {
    await browser?.close();
    await devServer?.stop();
    await harness?.cleanup();
  });

  /** Loads a path in a fresh page, waiting for the dev-server compile. */
  async function openPage(path: string): Promise<Page> {
    if (!devServer || !browser) throw new Error("dev server or browser not started");
    const page = await browser.newPage();
    const response = await page.goto(`${devServer.url}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (!response?.ok()) {
      throw new Error(
        `GET ${path} returned ${response?.status() ?? "no response"}.\n` +
          `--- dev server output ---\n${devServer.output().slice(-2000)}`,
      );
    }
    return page;
  }

  it(
    "stage 1: scaffolds a Next.js app that actually boots",
    async () => {
      const run = await harness.runPiAgent(
        "Create a new Next.js application in the current directory using create-next-app. " +
          "The app must be in a folder named `myapp`. Use TypeScript and the App Router, " +
          "with no Tailwind, no ESLint, and no `src` directory. " +
          "The command must run non-interactively — pass whatever flags it needs so it never " +
          "prompts for input.",
        // Scaffolding downloads and installs Next.js, so this stage gets far
        // longer than a normal prompt. Kept under the vitest timeout below so
        // the harness's own error (with transcript) wins over vitest's.
        { timeoutMs: 540_000 },
      );

      // Asserted first: on a provider/model error this prints the actual cause,
      // where stopReason alone only ever says "error".
      expect(run.errorMessage).toBeUndefined();
      expect(run.stopReason).toBe("stop");

      expect(await harness.workspaceFileExists("myapp/package.json")).toBe(true);

      // The real test of a scaffold is that it serves a page, not that files exist.
      devServer = await startWorkspaceDevServer({
        cwd: `${harness.workspaceDir}/myapp`,
        command: "npx",
        args: ["--no-install", "next", "dev"],
        urlPattern: NEXT_DEV_URL_PATTERN,
        readyPattern: NEXT_DEV_READY_PATTERN,
      });
      browser = await chromium.launch({ headless: true });

      const page = await openPage("/");
      await expect.poll(() => page.locator("h1").first().isVisible()).toBe(true);
      await page.close();

      completedStage = 1;
    },
    600_000,
  );

  it("stage 2: changes the homepage heading", async (ctx) => {
    if (completedStage < 1) ctx.skip("stage 1 did not complete");

    const run = await harness.runPiAgent(
      "In the Next.js app in the `myapp` folder, change the main heading — the <h1> element " +
        "on the homepage — so it reads exactly: Hello from the eval harness",
    );

    expect(run.errorMessage).toBeUndefined();
    expect(run.stopReason).toBe("stop");

    const page = await openPage("/");
    // Polled: the dev server may still be recompiling the edited route.
    await expect
      .poll(async () => (await page.locator("h1").first().textContent())?.trim(), {
        timeout: PAGE_TIMEOUT_MS,
      })
      .toBe("Hello from the eval harness");

    // The scaffold's original heading must be gone, not merely added alongside.
    expect(await page.content()).not.toContain("To get started, edit the page.tsx file.");
    await page.close();

    completedStage = 2;
  });

  it("stage 3: adds a new page at /about", async (ctx) => {
    if (completedStage < 2) ctx.skip("stage 2 did not complete");

    const run = await harness.runPiAgent(
      "In the Next.js app in the `myapp` folder, add a new page at the `/about` route. " +
        "The page must display exactly this text: This is the about page.",
    );

    expect(run.errorMessage).toBeUndefined();
    expect(run.stopReason).toBe("stop");

    const aboutPage = await openPage("/about");
    await expect
      .poll(() => aboutPage.getByText("This is the about page.").isVisible(), {
        timeout: PAGE_TIMEOUT_MS,
      })
      .toBe(true);
    await aboutPage.close();

    // The homepage change from stage 2 must survive.
    const homepage = await openPage("/");
    expect((await homepage.locator("h1").first().textContent())?.trim()).toBe(
      "Hello from the eval harness",
    );
    await homepage.close();

    completedStage = 3;
  });
});
