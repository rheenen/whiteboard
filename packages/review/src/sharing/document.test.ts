import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReviewApi } from "@review/review-api/http.js";
import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { exportShare } from "./export.js";
import { parseWhiteboardFile } from "./file.js";
import { mountSharingPublisher } from "./host.js";
import { importShare, validateShareBundle } from "./import.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "document-sharing-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const local = openLocalReviewStore(path.join(root, "review.db"));
  cleanup.push(() => local.store.close());
  cleanup.push(() => local.data.close());

  const { reviewId } = await local.store.execute({
    operation: {
      type: "create",
      title: "Whiteboard",
      target: {
        kind: "project",
        repositoryId: local.store.registerRepository(root).id,
      },
    },
  });

  await local.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "# A plan\nJust a document." },
      },
    },
  });

  return { root, ...local, reviewId };
}

it("imports a document shared without a GitHub repository as a board of its own", async () => {
  const local = await fixture();

  const app = new Hono();
  app.onError((error, context) => context.json({ error: error.message }, 500));
  mountSharingPublisher(app, local.store, local.data);

  const response = await app.request("/sharing/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewId: local.reviewId }),
  });

  expect(response.status).toBe(200);
  const bundle = parseWhiteboardFile((await response.json()).text);
  expect(bundle.repository).toBeUndefined();

  const id = await importShare(local, randomUUID(), bundle);

  const copy = local.store.read(id);

  expect(copy.target).toBeUndefined();
  expect(copy.document).toMatchObject([
    { type: "markdown", markdown: "# A plan\nJust a document." },
  ]);
});

it("leaves images unshared on a document without source pins", async () => {
  const local = await fixture();

  const resources = await createShareFixture(
    path.join(local.root, "resources"),
  );

  cleanup.push(() => resources.store.close());
  cleanup.push(() => resources.data.close());

  const { reviewId } = await resources.store.execute({
    operation: {
      type: "create",
      title: "Document with attachments",
      target: {
        kind: "project",
        repositoryId: resources.store.registerRepository(local.root).id,
      },
    },
  });

  const assetId = resources.imageId;

  await resources.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "image", assetId, alt: "Attached image" },
      },
    },
  });

  const bundle = await exportShare({
    store: resources.store,
    data: resources.data,
    reviewId,
    repository: { cloneUrl: "https://github.com/acme/app.git" },
  });

  expect(Object.keys(bundle.maps)).toEqual([]);
  expect(bundle.images).toEqual({});

  const id = await importShare(local, randomUUID(), bundle);

  const api = createReviewApi(local.store, local.data);
  const copy = local.store.read(id).document;

  expect(copy.find((block) => block.type === "image")).toMatchObject({
    assetId,
  });
  expect((await api.request(`/${id}/resources/${assetId}`)).status).toBe(404);
});

it("rejects source-dependent content disguised as a document-only share", async () => {
  const local = await fixture();
  const bundle = await exportShare(local);
  const snapshot = validateShareBundle(bundle).snapshot;

  for (const extra of [
    {
      pins: {
        repositoryId: "repo",
        base: "a".repeat(40),
        head: "b".repeat(40),
      },
    },
    {
      lenses: [
        {
          id: "lens",
          title: "Code",
          targets: [{ kind: "files", patterns: ["*.ts"] }],
        },
      ],
    },
    {
      document: [
        {
          id: "code",
          type: "markdown",
          markdown: "[source](review-source:head/main.ts#L1)",
        },
      ],
    },
  ]) {
    await expect(
      importShare(
        local,
        randomUUID(),
        // SAFETY: the test disguises the snapshot on purpose.
        { ...bundle, snapshot: { ...snapshot, ...extra } } as typeof bundle,
      ),
    ).rejects.toThrow(/code references|open a checkout/i);
  }
});

async function sharedPlan(cloneUrl = "https://github.com/acme/app.git") {
  const local = await fixture();
  const checkout = path.join(local.root, "app");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/app.git",
  ]);
  const { id: repositoryId } = await local.data.register(checkout);

  const { reviewId } = await local.store.execute({
    operation: {
      type: "create",
      title: "Plan",
      target: { kind: "project", repositoryId },
    },
  });

  await local.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Ship the sidebar." },
      },
    },
  });

  const bundle = await exportShare({
    store: local.store,
    data: local.data,
    reviewId,
    repository: { cloneUrl },
  });

  const id = await importShare(local, randomUUID(), bundle);

  return { local, id, repositoryId };
}

it("files a shared plan without pins on the receiver's checkout of its repository", async () => {
  const { local, id, repositoryId } = await sharedPlan();

  expect(local.store.read(id).target).toEqual({
    kind: "project",
    repositoryId,
  });
});

it("keeps a shared plan the receiver has no checkout of as a board of its own", async () => {
  const { local, id } = await sharedPlan("https://github.com/acme/other.git");

  expect(local.store.read(id).target).toBeUndefined();
});
