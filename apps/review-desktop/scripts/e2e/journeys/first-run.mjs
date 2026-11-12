/** A fresh profile meets the onboarding rail and no usage data notice; a reader with two reviews meets the community invitation once. */
import assert from "node:assert/strict";

import { assertNoBlockedReviewRequests } from "../../review-network-policy.mjs";
import { createReview, orderReviewBlocks } from "../harness.mjs";
import { readApplicationStorage } from "../storage.mjs";

export const name = "first-run";

export const phase = 1;

export const options = {
  disableCommunityHandler: true,
};

const COMMUNITY_TITLE = "Join the Whiteboard community";

const COMMUNITY_DISMISSED_KEY = "review.community.dontShowAgain";

/** Storage booleans arrive as `true`; a JSON-encoded `"true"` counts as well. */
const isStoredTrue = (value) => value === "true" || value === '"true"';

/** True when the locator turns up within `timeout`, false when it does not. */
const appears = (locator, timeout) =>
  locator.waitFor({ timeout }).then(
    () => true,
    () => false,
  );

/** The stored value for `key`, or undefined when the workbench flushed none within `timeout`. */
const storedValue = (ctx, key, timeout = 10000) =>
  ctx
    .until(
      () => readApplicationStorage(ctx.userData, key),
      `${key} in application storage`,
      timeout,
    )
    .catch((error) => {
      // Only a timeout means "nothing was stored"; the Desktop's exit diagnostic must stay fatal.
      if (!error.message.startsWith("Timed out waiting for")) throw error;

      return undefined;
    });

export async function run(ctx) {
  const { page } = ctx;

  const onboarding = page.locator("main.review-onboarding");

  await onboarding
    .getByRole("heading", { name: "Your codebase, explained by your agent." })
    .waitFor();

  for (const step of ["Welcome", "Install", "Run"])
    await onboarding
      .getByRole("navigation", { name: "Setup" })
      .getByText(step, { exact: true })
      .waitFor();
  // Nothing installs until the reader asks: Welcome has one button.
  await onboarding.getByRole("button", { name: "Get started" }).waitFor();
  ctx.check("empty Home renders first-run onboarding");

  // The invitation waits for a reader with two reviews, so a fresh profile never sees it.
  assert.equal(
    await page.getByText(COMMUNITY_TITLE, { exact: true }).count(),
    0,
    "the community invitation showed on a fresh profile",
  );
  ctx.check("a fresh profile gets no community invitation");

  // This build sends no usage data, so it never announces any.
  assert.equal(
    await appears(
      page.getByText("Whiteboard sends anonymous usage data"),
      3000,
    ),
    false,
    "a usage data notice showed",
  );
  ctx.check("a fresh profile gets no usage data notice");

  for (const title of ["First review", "Second review"])
    await createReview(ctx, { title, blocks: orderReviewBlocks });

  // The invitation is decided once per window, at startup.
  await ctx.restartDesktop();

  const dialog = ctx.page.getByText(COMMUNITY_TITLE, { exact: true });

  await dialog.waitFor({ timeout: 30000 });
  // Any answer is final: the invitation has no "Don't show again" of its own.
  await ctx.page.getByRole("button", { name: "Not now", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  const dismissed = await storedValue(ctx, COMMUNITY_DISMISSED_KEY);

  assert.ok(
    isStoredTrue(dismissed),
    `${COMMUNITY_DISMISSED_KEY} was not stored (${dismissed})`,
  );
  ctx.check("the community invitation shows once a reader has two reviews");

  await ctx.restartDesktop();
  await ctx.page.locator(".monaco-workbench").waitFor({ timeout: 60000 });
  await ctx.page.waitForTimeout(3000);
  assert.equal(
    await ctx.page.getByText(COMMUNITY_TITLE, { exact: true }).count(),
    0,
  );
  ctx.check("the dismissed dialog stays hidden after a restart");

  assertNoBlockedReviewRequests(ctx.requestUrls);
  ctx.check("no request left for a blocked host");
}
