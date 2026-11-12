import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
  BoardCommentsProvider,
  DiagramCommentScope,
  DiagramPartPin,
  partSelection,
} from "./board-comments";
import { TestCanvasQuery } from "./canvas-query-test-utils";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

import "./styles.css";

const comment = (
  id: string,
  body: string,
  part: { id: string; label: string },
  resolved = false,
) => ({
  id,
  reviewId: "test-review",
  body,
  author: "Reviewer",
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
  hash: id,
  resolved,
  anchor: {
    kind: "source",
    file: "src/audit.ts",
    side: "head",
    fromLine: 10,
    toLine: 14,
    part: { blockId: "flow", ...part },
  },
  title: part.label,
  version: 1,
});

const audit = { id: "flow:audit:0", label: "Audit writer" };

afterEach(() => {
  document.body.replaceChildren();
});

it("shows a diagram part's open comments on its icon, to edit, resolve or delete", async () => {
  const session = testReviewSession();
  const requests: { path: string; method: string; body?: string }[] = [];

  vi.spyOn(session, "fetch").mockImplementation(async (path, init) => {
    requests.push({
      path: String(path),
      method: init?.method ?? "GET",
      ...(init?.body !== undefined && { body: String(init.body) }),
    });

    if (init?.method) return Response.json({});

    return Response.json({
      reviewId: "test-review",
      comments: [
        comment("c1", "Retry here?", audit),
        // The node's step without code.
        comment("c2", "Name it AuditLog.", {
          id: "flow:audit",
          label: "Audit writer",
        }),
        comment("c3", "Done.", audit, true),
        comment("c4", "Another node.", { id: "flow:queue", label: "Queue" }),
      ],
    });
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <ReviewSessionProvider session={session}>
        <TestCanvasQuery>
          <BoardCommentsProvider>
            <DiagramCommentScope.Provider value="flow">
              <div style={{ position: "relative", margin: 40, width: 120 }}>
                <DiagramPartPin
                  partId="audit"
                  label="Audit writer"
                  scoped
                  steps
                />
              </div>
            </DiagramCommentScope.Provider>
          </BoardCommentsProvider>
        </TestCanvasQuery>
      </ReviewSessionProvider>,
    ),
  );

  // Resolved comments and other parts' comments stay off the icon.
  const pin = await vi.waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="2 comments on Audit writer"]',
    );

    expect(found).not.toBeNull();

    return found!;
  });

  await userEvent.click(pin);

  const popover = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Comments on Audit writer"]',
  )!;

  expect(popover.textContent).toContain("Retry here?");
  expect(popover.textContent).toContain("Name it AuditLog.");
  expect(popover.textContent).not.toContain("Done.");

  const [edit] = popover.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Edit comment"]',
  );

  await userEvent.click(edit!);

  const field = popover.querySelector<HTMLTextAreaElement>("textarea")!;

  await userEvent.clear(field);
  await userEvent.type(field, "Retry with backoff?");
  await userEvent.click(
    [...popover.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!,
  );

  await vi.waitFor(() =>
    expect(requests).toContainEqual({
      path: "/comments/c1",
      method: "PATCH",
      body: JSON.stringify({ body: "Retry with backoff?" }),
    }),
  );

  const [, remove] = popover.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Delete comment"]',
  );

  await userEvent.click(remove!);

  await vi.waitFor(() =>
    expect(requests).toContainEqual({
      path: "/comments/c2",
      method: "DELETE",
    }),
  );

  const [resolve] = popover.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Resolve comment"]',
  );

  await userEvent.click(resolve!);

  await vi.waitFor(() =>
    expect(requests).toContainEqual({
      path: "/comments/c1",
      method: "PATCH",
      body: JSON.stringify({ resolved: true }),
    }),
  );

  await act(async () => root.unmount());
});

it("comments on a step's code when it has code, and on its diagram when not", () => {
  const source = {
    file: "src/audit.ts",
    start: { side: "head" as const, line: 10 },
    end: { side: "head" as const, line: 14 },
  };

  expect(
    partSelection("flow", {
      anchor: { id: "flow:audit:0", title: "Audit writer" },
      label: "Audit writer",
      content: { kind: "source", source },
    }),
  ).toEqual({
    target: {
      kind: "code",
      path: "src/audit.ts",
      side: "head",
      startLine: 10,
      endLine: 14,
    },
    title: "Audit writer",
    part: { blockId: "flow", id: "flow:audit:0", label: "Audit writer" },
  });

  // A range across sides takes its head end.
  expect(
    partSelection("flow", {
      anchor: { id: "flow:audit:0", title: "Audit writer" },
      label: "Audit writer",
      content: {
        kind: "source",
        source: {
          file: "src/audit.ts",
          start: { side: "base", line: 84 },
          end: { side: "head", line: 90 },
        },
      },
    }).target,
  ).toMatchObject({ side: "head", startLine: 90, endLine: 90 });

  expect(
    partSelection("flow", {
      anchor: { id: "flow:queue", title: "Queue" },
      label: "Queue",
      content: { kind: "explanation", text: "Holds jobs." },
    }).target,
  ).toEqual({ kind: "block", blockId: "flow" });
});
