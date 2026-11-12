/** A reader's place in a review survives a renderer reload: a commit diff and a fullscreen tour step. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIAGRAM_REVIEW_TITLE,
  clearToasts,
  commitPill,
  createDiagramReview,
  createReview,
  inView,
  scopeToCommit,
} from "../harness.mjs";

export const name = "canvas-resume";

export const phase = 1;

export const options = {};

const TITLE = "Canvas resume review";

/** Reloads the whole workbench renderer; the review's own window comes back with its canvas. */
async function reloadWindow(ctx, page) {
  const origin = await page.evaluate(() => performance.timeOrigin);

  await page.keyboard.press("F1");
  await page
    .locator(".quick-input-widget input")
    .fill(">Developer: Reload Window");
  await page
    .getByRole("option", { name: /Developer: Reload Window/ })
    .waitFor();
  await page.keyboard.press("Enter");
  await ctx.until(
    async () => (await page.evaluate(() => performance.timeOrigin)) !== origin,
    "the workbench renderer to reload",
  );
  // The resumed view may hide the review's title, so the canvas itself is the signal.
  await page
    .locator(".review-canvas-root [data-review-api]")
    .waitFor({ timeout: 90000 });
}

const scopeSubject = async (page) =>
  /^Commit \w+: (.*)\. Choose commits$/.exec(
    await commitPill(page)
      .getAttribute("aria-label", { timeout: 1000 })
      .catch(() => ""),
  )?.[1] ?? null;

export async function run(ctx) {
  const { until, git, repo } = ctx;

  await writeFile(path.join(repo, "ship.ts"), "export const shipped = true;\n");
  await git("add", ".");
  await git("commit", "-qm", "Ship");

  const ship = await git("rev-parse", "HEAD");

  const repositoryId = (
    await ctx.apiOk("/reviews-api/repositories", "POST", { path: repo })
  ).id;

  const review = await createReview(ctx, {
    title: TITLE,
    head: ship,
    blocks: [{ type: "markdown", markdown: "Ship the order queue." }],
  });

  const command = (operation) =>
    ctx.apiOk("/reviews-api/commands", "POST", {
      operation,
    });

  let page = await ctx.apiCanvasFor(TITLE);

  await ctx.watchPage(page);

  await scopeToCommit(ctx, "Queue", page);
  await until(
    async () => (await scopeSubject(page)) === "Queue",
    "the Queue commit diff",
  );
  await reloadWindow(ctx, page);
  await inView(ctx, "diff", page);
  await until(
    async () => (await scopeSubject(page)) === "Queue",
    "the Queue commit diff to resume after the reload",
  );
  ctx.check("a commit diff resumes with its scope after a reload");

  // A version that still lists the commit keeps the scope.
  await command({
    type: "edit",
    reviewId: review.reviewId,
    edit: {
      type: "insert",
      content: { type: "markdown", markdown: "The queue ships." },
    },
  });
  await reloadWindow(ctx, page);
  await inView(ctx, "diff", page);
  await until(
    async () => (await scopeSubject(page)) === "Queue",
    "the Queue scope to survive a version that still lists it",
  );

  // A version whose range drops the commit falls back to the full diff.
  await command({
    type: "set_target",
    reviewId: review.reviewId,
    target: { kind: "commits", repositoryId, head: ship, base: ctx.head },
  });
  await reloadWindow(ctx, page);
  await inView(ctx, "diff", page);
  await page.locator(".review-diff-view-host").waitFor();
  await until(
    async () =>
      (await commitPill(page).getAttribute("aria-label")).startsWith("All "),
    "the dropped commit's scope to clear",
  );
  assert.equal(
    await page.locator('[data-review-api] > p[role="status"]').count(),
    0,
  );
  assert.deepEqual(ctx.pageErrors, []);
  ctx.check(
    "a new version keeps a listed commit's scope and drops an unlisted one",
  );

  await createDiagramReview(ctx);
  page = await ctx.apiCanvasFor(DIAGRAM_REVIEW_TITLE);
  await ctx.watchPage(page);

  const canvas = page.locator(".review-canvas-root [data-review-api]");

  // The telemetry notice's toast covers the tour's controls.
  await clearToasts(page);
  await canvas
    .locator(".sequence-diagram .diagram-tour-button")
    .first()
    .click();

  const overlay = page.locator(".diagram-tour-overlay");

  await overlay.getByRole("button", { name: / more steps$/ }).click();

  const count = () =>
    page
      .locator(".diagram-tour-overlay .tour-pill-count")
      .innerText({ timeout: 1000 })
      .catch(() => "");

  const atStepTwo = async () => /^2\/\d+$/.test(await count());

  await until(atStepTwo, "the sequence tour to reach step 2");
  await reloadWindow(ctx, page);
  await until(atStepTwo, "the sequence tour to resume at step 2");
  ctx.check("a fullscreen sequence tour resumes at its step after a reload");
}
