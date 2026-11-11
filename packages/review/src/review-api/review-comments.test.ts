import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import type { AgentSelection } from "@review/agent-selection.js";
import type { CommentPart } from "@review/comment-part.js";
import { createReviewApi } from "@review/review-api/http.js";
import { ReviewStore } from "@review/review-api/store.js";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runCommentsCli } from "./comments-cli.js";

/** What the comment routes take: a new comment, or a change to one. */
type CommentRequest =
  | { selection: AgentSelection; body: string; part?: CommentPart }
  | { body?: string; resolved?: boolean };

const pins = { repositoryId: "repo", base: "base", head: "head" };

let dir: string;

let store: ReviewStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "review-comments-"));
  store = new ReviewStore(path.join(dir, "review-api.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
});

afterEach(async () => {
  await store.close();
});

const board = async () =>
  (
    await store.execute({
      operation: {
        type: "create",
        title: "Payments",
        target: { kind: "commits", ...pins },
      },
    })
  ).reviewId;

const request = (
  reviewId: string,
  method: string,
  route = "",
  body?: CommentRequest,
) =>
  createReviewApi(store).request(`/${reviewId}/comments${route}`, {
    method,
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

const cli = (args: { review?: string; session?: string; json?: boolean }) => {
  let stdout = "";
  let stderr = "";

  const sink = (write: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, done) {
        write(String(chunk));
        done();
      },
    });

  const code = runCommentsCli({
    ...args,
    stdout: sink((text) => (stdout += text)),
    stderr: sink((text) => (stderr += text)),
    env: { DEV_REVIEW_SERVER_DIR: dir },
  });

  return { code, stdout, stderr };
};

it("keeps comments on text and on code, and lists them for a PR tool without a server", async () => {
  const reviewId = await board();

  const onText = await request(reviewId, "POST", "", {
    selection: {
      title: "Retention",
      target: {
        kind: "text",
        quote: "90 days",
        anchor: { blockId: "b1", start: 4, end: 11, text: "for 90 days" },
      },
    },
    body: "Why **90**?",
  });

  expect(onText.status).toBe(200);

  const onCode = await request(reviewId, "POST", "", {
    selection: {
      title: "src/audit.ts:3-5",
      target: {
        kind: "code",
        path: "/src/audit.ts",
        side: "head",
        startLine: 5,
        endLine: 3,
      },
    },
    body: "Off by one.",
  });

  const code = await onCode.json();

  expect(code.anchor).toEqual({
    kind: "source",
    file: "src/audit.ts",
    side: "head",
    fromLine: 3,
    toLine: 5,
  });

  const { code: exit, stdout, stderr } = cli({ session: reviewId, json: true });

  expect([exit, stderr]).toEqual([0, ""]);

  const listed = JSON.parse(stdout);

  expect(listed).toMatchObject({ schema: 1, reviewId, sessionId: reviewId });
  expect(
    listed.comments.map((comment: { body: string }) => comment.body),
  ).toEqual(["Why **90**?", "Off by one."]);
  expect(listed.comments[0]).toMatchObject({
    resolved: false,
    anchor: { kind: "document", blockId: "b1", quote: "90 days" },
  });
  expect(listed.comments[0]).not.toHaveProperty("selection");
});

it("names the diagram part a comment is on, with the code behind it when it has code", async () => {
  const reviewId = await board();
  const part = { blockId: "flow", id: "flow:audit:0", label: "Audit writer" };

  const onCode = await (
    await request(reviewId, "POST", "", {
      selection: {
        title: "Audit writer",
        target: {
          kind: "code",
          path: "src/audit.ts",
          side: "head",
          startLine: 10,
          endLine: 14,
        },
      },
      body: "Retry here?",
      part,
    })
  ).json();

  expect(onCode.anchor).toEqual({
    kind: "source",
    file: "src/audit.ts",
    side: "head",
    fromLine: 10,
    toLine: 14,
    part,
  });

  const withoutCode = await (
    await request(reviewId, "POST", "", {
      selection: {
        title: "Queue",
        target: { kind: "block", blockId: "flow" },
      },
      body: "Which queue?",
      part: { blockId: "flow", id: "flow:queue", label: "Queue" },
    })
  ).json();

  expect(withoutCode.anchor).toEqual({
    kind: "document",
    blockId: "flow",
    part: { blockId: "flow", id: "flow:queue", label: "Queue" },
  });

  const listed = JSON.parse(cli({ review: reviewId, json: true }).stdout);

  expect(listed.comments[0].anchor.part).toEqual(part);
});

it("changes the hash when the body changes, not when the comment is resolved", async () => {
  const reviewId = await board();

  const made = await (
    await request(reviewId, "POST", "", {
      selection: { title: "Payments", target: { kind: "review" } },
      body: "First",
    })
  ).json();

  const resolved = await (
    await request(reviewId, "PATCH", `/${made.id}`, { resolved: true })
  ).json();

  expect(resolved).toMatchObject({ resolved: true, hash: made.hash });

  const edited = await (
    await request(reviewId, "PATCH", `/${made.id}`, { body: "Second" })
  ).json();

  expect(edited.hash).not.toBe(made.hash);

  expect((await request(reviewId, "DELETE", `/${made.id}`)).status).toBe(200);
  expect((await request(reviewId, "DELETE", `/${made.id}`)).status).toBe(404);
});

it("lists none for a board without comments, and refuses an unknown board on one line", async () => {
  const reviewId = await board();

  expect(JSON.parse(cli({ review: reviewId, json: true }).stdout)).toEqual({
    schema: 1,
    reviewId,
    sessionId: reviewId,
    comments: [],
  });

  const unknown = cli({ review: "nope", json: true });

  expect(unknown.code).toBe(1);
  expect(unknown.stdout).toBe("");
  expect(unknown.stderr.trim().split("\n")).toHaveLength(1);
});

it("reads the saved comments after the server closed", async () => {
  const reviewId = await board();

  await request(reviewId, "POST", "", {
    selection: { title: "Payments", target: { kind: "review" } },
    body: "Kept",
  });
  await store.close();

  store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const { code, stdout } = cli({ review: reviewId, json: true });

  expect(code).toBe(0);
  expect(JSON.parse(stdout).comments[0].body).toBe("Kept");
});
