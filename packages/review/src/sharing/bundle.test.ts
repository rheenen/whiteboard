import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_SHARE_BYTES,
  createShareSchema,
} from "@dev.fast/review-share-protocol";
import { ReviewInputError } from "@dev.fast/whiteboard-document";
import { afterEach, expect, it } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { exportShare, shareRequestBody } from "./export.js";
import { validateShareBundle } from "./import.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-bundle-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const shared = await createShareFixture(root);
  cleanup.push(async () => {
    await shared.data.close();
    await shared.store.close();
  });

  return shared;
}

it("carries the board, its resources, commits, resolved selections and exactly the lines it references", async () => {
  const shared = await fixture();
  const { pins } = shared.store.read(shared.reviewId);

  const { bundle } = createShareSchema.parse(
    JSON.parse(shareRequestBody(await exportShare(shared), randomUUID())),
  );

  expect(bundle.snapshot).not.toHaveProperty("target");
  expect(bundle.repository).toEqual(shared.repository);
  expect(bundle.images).toEqual({});
  expect(bundle.traces).toEqual({});
  expect(Object.values(bundle.maps)).toEqual([
    expect.objectContaining({ side: "head", commit: pins!.head }),
  ]);
  expect(bundle.commits).toEqual([
    expect.objectContaining({ commit: pins!.head }),
  ]);
  expect(Object.values(bundle.selections).flat()).toEqual(
    expect.arrayContaining([
      { side: "head", file: "new.ts", fromLine: 1, toLine: 1 },
      { side: "base", file: "removed.ts", fromLine: 1, toLine: 1 },
    ]),
  );

  // The map's range and the peek of the same lines make one excerpt.
  expect(bundle.sources).toEqual(
    expect.arrayContaining([
      {
        kind: "excerpt",
        file: "answer.ts",
        commit: pins!.head,
        fromLine: 1,
        lines: ["export function answer() {", "  return 42;", "}"],
      },
      {
        kind: "excerpt",
        file: "new.ts",
        commit: pins!.head,
        fromLine: 1,
        lines: ["export const added = true;"],
      },
      {
        kind: "excerpt",
        file: "removed.ts",
        commit: pins!.base,
        fromLine: 1,
        lines: ["export const obsolete = true;"],
      },
    ]),
  );
  expect(
    bundle.sources.filter(
      ({ file, commit }) => file === "answer.ts" && commit === pins!.head,
    ),
  ).toHaveLength(1);
  expect(validateShareBundle(bundle).snapshot.pins).toEqual(pins);

  // A review whose target named its base, as a stacked one does, still opens.
  const stacked = {
    ...bundle,
    snapshot: { ...bundle.snapshot, origin: { baseBranch: "main" } },
  };

  expect(validateShareBundle(stacked).snapshot.origin).toEqual({
    baseBranch: "main",
  });
});

it("refuses a bundle past the upload limit", async () => {
  const shared = await fixture();
  const bundle = await exportShare(shared);
  bundle.images.large = { png: "x".repeat(MAX_SHARE_BYTES) };

  expect(() => shareRequestBody(bundle, randomUUID())).toThrow(
    ReviewInputError,
  );
});

it("opens a bundle from a build with trace capture, ignoring its traces", async () => {
  const shared = await fixture();
  const bundle = await exportShare(shared);
  const traceId = randomUUID();
  // SAFETY: an exported snapshot carries its document as an array of blocks.
  const document = bundle.snapshot.document as unknown[];

  const old = {
    ...bundle,
    snapshot: {
      ...bundle.snapshot,
      document: [
        ...document,
        {
          type: "trace_quote",
          traceId,
          eventId: "response",
          text: "The answer is 42.",
        },
      ],
    },
    traces: { [traceId]: { label: "Anything", events: "not a trace" } },
  };

  expect(validateShareBundle(old).snapshot.document).toContainEqual(
    expect.objectContaining({ type: "trace_quote", traceId }),
  );
});
