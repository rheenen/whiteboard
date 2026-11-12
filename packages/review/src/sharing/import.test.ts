import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Block } from "@dev.fast/whiteboard-document";
import { createReviewApi } from "@review/review-api/http.js";
import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { afterEach, expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { exportShare } from "./export.js";
import {
  importShare,
  sharePresentationSchema,
  sharedSnapshotSchema,
} from "./import.js";
import { sharedProtocols } from "./repository.js";

// The fixtures fetch from local paths.
sharedProtocols.add("file");

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const close of cleanup.splice(0).reverse()) await close();
});

/** A sender's exported board, with a block pinned to commits of its own,
 * and a recipient whose checkout of the repository holds only its base. */
async function share() {
  const root = await mkdtemp(path.join(tmpdir(), "share-copy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const sender = await createShareFixture(root);
  cleanup.push(() => sender.store.close());
  cleanup.push(() => sender.data.close());
  const pins = sender.store.read(sender.reviewId).pins!;

  const { reviewId: other } = await sender.store.execute({
    operation: {
      type: "create",
      title: "Another of the sender's boards",
      target: { kind: "commits", ...pins },
    },
  });

  for (const content of [
    {
      type: "code_peek",
      source: "head/answer.ts#L2",
      pins: { repositoryId: pins.repositoryId, head: pins.base },
    },
    {
      type: "markdown",
      markdown: `[Here](whiteboard:board/${sender.reviewId}) and [there](whiteboard:board/${other}).`,
    },
  ])
    await sender.store.execute({
      operation: {
        type: "edit",
        reviewId: sender.reviewId,
        edit: { type: "insert", content },
      },
    });

  const bundle = await exportShare(sender);
  const recipient = openLocalReviewStore(path.join(root, "recipient.db"));
  cleanup.push(() => recipient.store.close());
  cleanup.push(() => recipient.data.close());

  const checkout = path.join(root, "recipient-checkout");
  await mkdir(checkout);

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();

  // Git reaches "GitHub" through the sender's repository.
  vi.stubEnv("HOME", root);
  await writeFile(
    path.join(root, ".gitconfig"),
    `[url "${sender.repo}"]\n\tinsteadOf = ${sender.repository.cloneUrl}\n`,
  );
  git("init", "-q");
  git("remote", "add", "origin", sender.repository.cloneUrl);
  git("fetch", "-q", "origin", pins.base);
  git("checkout", "-q", "--detach", "FETCH_HEAD");
  const own = await recipient.data.register(checkout);

  return { sender, other, pins, bundle, recipient, own, git };
}

it("copies a file's board into a board the recipient edits like their own", async () => {
  const { sender, other, pins, bundle, recipient, own } = await share();
  const key = randomUUID();

  const reviewId = await importShare(recipient, key, bundle);

  await rename(sender.repo, `${sender.repo}-gone`);

  const copy = recipient.store.read(reviewId);

  expect(copy.shared).toEqual({
    cloneUrl: sender.repository.cloneUrl,
    key,
    importedVersion: 0,
  });
  expect(copy.pins!.repositoryId).toBe(own.id);
  expect(JSON.stringify(copy.document)).not.toContain(pins.repositoryId);
  expect(
    copy.document.find(
      (block): block is Extract<Block, { type: "code_peek" }> =>
        block.type === "code_peek" && block.pins !== undefined,
    )?.pins,
  ).toEqual({ repositoryId: own.id, head: pins.base });
  expect(JSON.stringify(copy.document)).toContain(
    `[Here](whiteboard:board/${reviewId}) and [there](whiteboard:board/${other}).`,
  );

  const app = createReviewApi(recipient.store, recipient.data);
  const json = async (url: string) => (await app.request(url)).json();

  const map = copy.document.find((block) => block.type === "software_map");

  expect(
    (
      await json(
        `/${reviewId}/maps/${map?.type === "software_map" && map.mapVersionId}`,
      )
    ).countsByElementPath,
  ).toBeTruthy();
  expect(
    (await json(`/${reviewId}/file?side=head&file=answer.ts`)).text,
  ).toContain("return 42;");

  const renamed = await app.request("/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: { type: "rename", reviewId, title: "Mine now" },
    }),
  });

  expect(renamed.status).toBe(200);
  expect(recipient.store.read(reviewId).title).toBe("Mine now");
});

it("fetches the shared commits into the recipient's own checkout", async () => {
  const { pins, bundle, recipient, own, git } = await share();
  const key = randomUUID();

  const reviewId = await importShare(recipient, key, bundle);

  expect(recipient.store.read(reviewId).pins!.repositoryId).toBe(own.id);
  expect(git("rev-parse", `refs/review/shared/${key}/${pins.head}`)).toBe(
    pins.head,
  );
});

const element = (path: string, parentPath?: string) => ({
  type: "container" as const,
  id: path,
  path,
  parentPath,
  label: path,
  children: [],
});

const presentation = (elements: ReturnType<typeof element>[]) => ({
  maps: {
    map: {
      commit: "a".repeat(40),
      side: "head" as const,
      elements,
      relationships: [],
      countsByElementPath: {},
      unmappedByElementPath: {},
    },
  },
});

it("reads a map whose elements nest", () => {
  expect(() =>
    sharePresentationSchema.parse(
      presentation([element("app"), element("app.api", "app")]),
    ),
  ).not.toThrow();
});

it.each([
  ["itself", [element("app", "app")]],
  ["a loop", [element("a", "b"), element("b", "c"), element("c", "a")]],
])("refuses map elements nested in %s", (_name, elements) => {
  expect(() => sharePresentationSchema.parse(presentation(elements))).toThrow(
    /nest in a cycle/,
  );
});

const snapshot = (pullRequestUrl: string) => ({
  reviewId: "shared",
  version: 1,
  title: "Board",
  document: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  origin: { pullRequestNumber: 7, pullRequestUrl },
});

it("links a pull request only by its canonical https URL", () => {
  expect(
    sharedSnapshotSchema.parse(snapshot("https://github.com/o/r/pull/7"))
      .origin,
  ).toEqual({
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/o/r/pull/7",
  });

  for (const url of [
    "javascript:alert(1)",
    "http://github.com/o/r/pull/7",
    "/pull/7",
  ])
    expect(() => sharedSnapshotSchema.parse(snapshot(url))).toThrow(
      /pullRequestUrl/,
    );
});
