import assert from "node:assert/strict";
import path from "node:path";

import {
  DIAGRAM_REVIEW_TITLE,
  createDiagramReview,
  showView,
} from "../harness.mjs";

export const name = "diagram-persistence";

export const phase = 1;

export const options = { seedRepo: false };

const TITLE = "Diagram persistence review";

export async function run(ctx) {
  const check = ctx.check;
  ctx.check = (...items) => {
    console.error(...items);
    check(...items);
  };

  await createDiagramReview(ctx);
  let page = await ctx.apiCanvasFor(DIAGRAM_REVIEW_TITLE);

  const canvas = () => page.locator(".review-canvas-root [data-review-api]");

  async function reload() {
    await page.keyboard.press("F1");
    await page
      .locator(".quick-input-widget input")
      .fill(">Developer: Reload Window");
    const loaded = page.waitForEvent("domcontentloaded");
    await page
      .getByRole("option", { name: /Developer: Reload Window/ })
      .click();
    await loaded;
    page = ctx.page;
    await canvas().waitFor();
    await ctx.watchPage(page);
  }

  const useCase = () =>
    page.getByRole("combobox", { name: "Database use case" }).first();

  const values = await useCase()
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));

  assert.ok(
    values.length > 1,
    "the diagram review needs multiple database use cases",
  );
  await useCase().selectOption(values.at(-1));
  await reload();
  assert.equal(await useCase().inputValue(), values.at(-1));
  ctx.check("database use case survives reload");
  await ctx.quitAndRelaunchDesktop();
  page = ctx.page;
  await canvas().waitFor();
  await showView(ctx, "Whiteboard", page);
  assert.equal(await useCase().inputValue(), values.at(-1));
  ctx.check("database state survives application relaunch");
  await page.screenshot({ path: path.join(ctx.root, "diagrams-restored.png") });
}
