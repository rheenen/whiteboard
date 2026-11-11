import type { JsonValue } from "@dev.fast/review-protocol";
import { documentSchema } from "@dev.fast/whiteboard-document";
import type { Snapshot } from "@review/review-api/store";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import {
  fixtureHost,
  loadFixture,
  mountWhiteboard,
  settled,
} from "./whiteboard-fixture";

import "./styles.css";

// Vite inlines the fixture files, one array of blocks per kind.
const fixtureFiles = import.meta.glob<{ default: JsonValue }>(
  "../../src/fixtures/blocks/{call_stack_diff,flow_diagram,sequence}.json",
  { eager: true },
);

const fixture = (kind: string): Snapshot["document"] =>
  documentSchema.parse(
    fixtureFiles[`../../src/fixtures/blocks/${kind}.json`]!.default,
  );

const flowBlocks = fixture("flow_diagram");

const sequenceBlocks = fixture("sequence");

const callTreeBlocks = fixture("call_stack_diff");

interface Posted {
  body: string;
  selection: { target: Target };
  part?: { blockId: string; id: string; label: string };
}

interface Target {
  kind: string;
  path?: string;
  side?: string;
  startLine?: number;
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

// The whiteboard with a host that keeps the comments it is sent.
async function mountBoard(blocks: Snapshot["document"], fullscreen: boolean) {
  const posted: Posted[] = [];
  const saved: JsonValue[] = [];

  const snapshot: Snapshot = {
    reviewId: "fixture-comments",
    version: 0,
    title: "Fixture review",
    pins: { repositoryId: "repo", base: "base", head: "head" },
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
    document: blocks,
    createdAt: "2026-09-16T00:00:00.000Z",
  };

  const host = fixtureHost({
    request: async (path, init) => {
      if (!String(path).includes("/comments"))
        throw new Error("This host serves no requests.");

      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as Posted;
        const { target } = input.selection;
        posted.push(input);

        const anchor =
          target.kind === "code"
            ? {
                kind: "source",
                file: target.path,
                side: target.side,
                fromLine: target.startLine,
                toLine: target.startLine,
                part: input.part,
              }
            : { kind: "document", part: input.part };

        const id = `c${saved.length + 1}`;
        saved.push({
          id,
          reviewId: snapshot.reviewId,
          body: input.body,
          author: "Reviewer",
          createdAt: "2026-11-11T10:00:00.000Z",
          updatedAt: "2026-11-11T10:00:00.000Z",
          hash: id,
          resolved: false,
          anchor,
          title: input.part?.label ?? "",
          version: 1,
        } as JsonValue);

        return Response.json(saved.at(-1));
      }

      return Response.json({ reviewId: snapshot.reviewId, comments: saved });
    },
  });

  const container = document.createElement("div");
  document.body.append(container);

  await act(async () => {
    const canvas = mountWhiteboard(
      container,
      loadFixture({ snapshot, commits: [], images: {}, traces: {}, maps: {} }),
      { host, settings: { diagramFullscreenOnClick: fullscreen } },
    );

    dispose = () => canvas.dispose();
  });

  return { container, posted };
}

async function click(element: Element) {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

// Writes a comment in the selection actions the click offered.
async function addComment(text: string) {
  const add = await settled(() =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Add comment",
    ),
  );

  expect(add, "the click offers Add comment").toBeTruthy();
  // Add comment is the first action, ahead of Ask and Copy ref.
  expect(add!.parentElement!.querySelector("button")).toBe(add);
  await userEvent.click(add!);

  const field = await settled(() =>
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Comment"]',
    ),
  );

  expect(field, "Add comment opens the comment field").toBeTruthy();
  await userEvent.type(field!, text);
  await userEvent.click(
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Comment"),
    )!,
  );
}

it.each([false, true])(
  "comments on the code behind a flow node (expanded: %s)",
  async (fullscreen) => {
    const { container, posted } = await mountBoard(flowBlocks, fullscreen);

    const node = await settled(() =>
      container.querySelector(".lens-flow-node"),
    );

    await click(node!);
    await addComment("Retry here?");

    await settled(() => posted.length > 0);
    expect(posted[0]).toMatchObject({
      body: "Retry here?",
      selection: {
        target: { kind: "code", path: "order.ts", side: "head", startLine: 1 },
      },
      part: { blockId: "flow-1", label: "Queue order" },
    });
    expect(posted[0]!.part!.id.startsWith("flow-1:request")).toBe(true);

    // The node shows the comment's icon once the board reads it back.
    if (fullscreen)
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      );

    expect(
      await settled(() =>
        container.querySelector(
          '.lens-flow-node button[aria-label$="on Queue order"]',
        ),
      ),
      "the node shows a comment icon",
    ).toBeTruthy();
  },
);

it("comments on the code behind a sequence message", async () => {
  const { container, posted } = await mountBoard(sequenceBlocks, false);

  const message = await settled(() =>
    container.querySelector("button[data-review-anchor-id='step-1']"),
  );

  await click(message!);
  await addComment("Is this idempotent?");

  await settled(() => posted.length > 0);
  expect(posted[0]).toMatchObject({
    body: "Is this idempotent?",
    selection: {
      target: { kind: "code", path: "order.ts", side: "head", startLine: 1 },
    },
    part: { blockId: "diagram-1", id: "step-1", label: "set status" },
  });

  expect(
    await settled(() =>
      container.querySelector('button[aria-label$="on set status"]'),
    ),
    "the message shows a comment icon",
  ).toBeTruthy();
});

it("comments on an expanded diagram's step with its pencil", async () => {
  const { container, posted } = await mountBoard(flowBlocks, true);

  const node = await settled(() => container.querySelector(".lens-flow-node"));

  await click(node!);

  const pencils = await settled(() => {
    const found = container.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button[aria-label^="Add comment on"]',
    );

    return found.length ? [...found] : undefined;
  });

  const pencil = pencils?.[0];

  expect(pencil, "the expanded step offers a pencil").toBeTruthy();
  await userEvent.click(pencil!);

  // The pencil opens the comment field at once.
  const field = await settled(() =>
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Comment"]',
    ),
  );

  expect(field).toBeTruthy();
  await userEvent.type(field!, "Check the old validation.");
  await userEvent.click(
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Comment"),
    )!,
  );

  await settled(() => posted.length > 0);
  expect(posted[0]).toMatchObject({
    body: "Check the old validation.",
    selection: { target: { kind: "code", path: "order.ts", startLine: 1 } },
    part: { blockId: "flow-1" },
  });
  expect(posted[0]!.part!.id.startsWith("flow-1:request")).toBe(true);
});

it("comments on the code behind a call in a call tree", async () => {
  const { container, posted } = await mountBoard(callTreeBlocks, false);

  const call = await settled(() =>
    container.querySelector('nav[aria-label="Call tree"] button'),
  );

  await click(call!);
  await addComment("Why queued here?");

  await settled(() => posted.length > 0);
  expect(posted[0]).toMatchObject({
    body: "Why queued here?",
    selection: { target: { kind: "code", path: "order.ts", startLine: 1 } },
    part: { blockId: "block-1" },
  });

  expect(
    await settled(() =>
      container.querySelector(
        'nav[aria-label="Call tree"] button[aria-label^="Comment on"]',
      ),
    ),
    "the call shows a comment icon",
  ).toBeTruthy();
});
