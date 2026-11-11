import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SHARE_FORMAT } from "@dev.fast/review-share-protocol";
import { ReviewInputError } from "@dev.fast/whiteboard-document";
import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { exportShare } from "./export.js";
import {
  parseWhiteboardFile,
  whiteboardFileName,
  whiteboardFileText,
} from "./file.js";
import { mountSharingHost, mountSharingPublisher } from "./host.js";
import {
  cloneForReader,
  type cloneSharedRepository,
  fetchPinnedRepository,
  readShareRepository,
  sharedProtocols,
} from "./repository.js";

// The fixtures fetch from local paths.
sharedProtocols.add("file");

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "review-file-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  return { root, ...(await createShareFixture(root)) };
}

it("names the file after the board's title as a kebab slug", () => {
  expect(whiteboardFileName("My Board: v2!")).toBe("my-board-v2.whiteboard");
  expect(whiteboardFileName("")).toBe("untitled.whiteboard");
});

it("rejects text that is not a Whiteboard file", () => {
  expect(() => parseWhiteboardFile("nope")).toThrow(/not a Whiteboard file/);
  expect(() => parseWhiteboardFile("[1]")).toThrow(/not a Whiteboard file/);
  expect(() =>
    parseWhiteboardFile(JSON.stringify({ format: "review-share/1" })),
  ).toThrow(/different Whiteboard version/);
});

it("requires an update only for a strictly newer share format", () => {
  const next = Number(SHARE_FORMAT.split("/")[1]) + 1;

  expect(() =>
    parseWhiteboardFile(JSON.stringify({ format: `review-share/${next}` })),
  ).toThrow(
    "This action requires a newer version of Whiteboard. Use Check for Updates, then try again.",
  );
  expect(() =>
    parseWhiteboardFile(JSON.stringify({ format: "other-format/999" })),
  ).toThrow(/different Whiteboard version/);
  expect(() =>
    parseWhiteboardFile(JSON.stringify({ format: SHARE_FORMAT })),
  ).toThrow(ZodError);
});

it("round-trips an exported bundle through its file text", async () => {
  const sender = await fixture();
  const bundle = await exportShare({ ...sender, reviewId: sender.reviewId });
  const text = whiteboardFileText(bundle);

  expect(text.endsWith("}\n")).toBe(true);
  expect(parseWhiteboardFile(text)).toEqual(bundle);
});

it("exports an untitled board to a file that reads back", async () => {
  const sender = await fixture();

  const { reviewId } = await sender.store.execute(
    {
      operation: {
        type: "create",
        target: sender.store.read(sender.reviewId).target,
      },
    },
    undefined,
    { kind: "person" },
  );

  await sender.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Untitled notes." },
      },
    },
  });

  const text = whiteboardFileText(await exportShare({ ...sender, reviewId }));

  expect(parseWhiteboardFile(text).title).toBe("");
});

it("serves a board as a named .whiteboard file", async () => {
  const sender = await fixture();
  const api = new Hono();
  api.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof ReviewInputError ? error.status : 500,
    ),
  );
  mountSharingPublisher(api, sender.store, sender.data, {
    readRepository: async () => ({ repository: sender.repository }),
  });

  const response = await api.request("/sharing/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewId: sender.reviewId }),
  });

  expect(response.status).toBe(200);
  const { filename, text } = await response.json();
  expect(filename).toBe("sharing-pinned-commits.whiteboard");
  const bundle = parseWhiteboardFile(text);
  expect(bundle.reviewId).toBe(sender.reviewId);
  expect(bundle.repository).toEqual(sender.repository);
});

it("refuses to export pinned code without a remote to fetch it from", async () => {
  const sender = await fixture();
  const api = new Hono();
  api.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof ReviewInputError ? error.status : 500,
    ),
  );
  mountSharingPublisher(api, sender.store, sender.data, {
    readRepository: async () => {
      throw new Error("Sharing requires an origin remote.");
    },
  });

  const response = await api.request("/sharing/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewId: sender.reviewId }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error:
      "Exporting pinned code needs an https or ssh origin remote the file's reader can fetch from.",
  });
});

async function recipientApi() {
  const sender = await fixture();

  const recipient = openLocalReviewStore(
    path.join(sender.root, "recipient.db"),
  );

  cleanup.push(() => recipient.store.close());
  cleanup.push(() => recipient.data.close());
  vi.stubEnv("DEV_REVIEW_HOME", sender.root);

  const api = new Hono();
  api.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof ReviewInputError ? error.status : 500,
    ),
  );

  const fetchRepository = vi.fn<typeof fetchPinnedRepository>(
    (target, _url, ...rest) =>
      fetchPinnedRepository(target, sender.repo, ...rest),
  );

  const cloneRepository = vi.fn<typeof cloneSharedRepository>(async () => {
    throw new Error("A file never clones.");
  });

  mountSharingHost(api, recipient.store, recipient.data, {
    fetchRepository,
    cloneRepository,
  });

  const text = whiteboardFileText(
    await exportShare({
      ...sender,
      reviewId: sender.reviewId,
      repository: sender.repository,
    }),
  );

  /** The recipient's own clone of the sender's repository. */
  const checkout = async (name: string, origin?: string) => {
    const root = path.join(sender.root, name);

    execFileSync("git", ["clone", "-q", sender.repo, root]);

    if (origin)
      execFileSync("git", ["-C", root, "remote", "set-url", "origin", origin]);
    else execFileSync("git", ["-C", root, "remote", "remove", "origin"]);

    return (await recipient.data.register(root)).id;
  };

  const file = path.join(sender.root, "board.whiteboard");
  await writeFile(file, text);

  const open = async (
    body: { path: string; readOnly?: boolean } | { url: string },
  ) => {
    const started = await api.request("/sharing/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (started.status !== 202)
      return { status: started.status, ...(await started.json()) };
    const { reviewId: id } = await started.json();

    for (;;) {
      const status = await (await api.request(`/sharing/import/${id}`)).json();

      if (status.stage === "ready" || status.stage === "error")
        return { status: 202, ...status };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const clone = async (body: { url: string; parent: string; name: string }) => {
    const response = await api.request("/sharing/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    return { status: response.status, ...(await response.json()) };
  };

  return {
    sender,
    recipient,
    text,
    file,
    open,
    clone,
    checkout,
    fetchRepository,
    cloneRepository,
  };
}

it("imports a .whiteboard file once per content", async () => {
  const { sender, recipient, file, open, checkout } = await recipientApi();
  const own = await checkout("own", "git@github.com:fixture/review.git");

  const first = await open({ path: file });

  expect(first.stage).toBe("ready");
  expect(recipient.store.read(first.reviewId).pins?.repositoryId).toBe(own);
  expect(first.title).toBe("Sharing pinned commits");
  expect(recipient.store.read(first.reviewId).shared?.cloneUrl).toBe(
    sender.repository.cloneUrl,
  );

  expect(await open({ path: file })).toMatchObject({
    stage: "ready",
    reviewId: first.reviewId,
  });
});

it("never clones for a file: it asks for a checkout of the repository", async () => {
  const { file, open, fetchRepository, cloneRepository } = await recipientApi();

  expect(await open({ path: file })).toMatchObject({
    stage: "error",
    error:
      "Open a checkout of fixture / review in Whiteboard first, then open this file again.",
  });
  expect(fetchRepository).not.toHaveBeenCalled();
  expect(cloneRepository).not.toHaveBeenCalled();
});

it("offers to clone the repository a file needs, and clones only that one", async () => {
  const { sender, file, open, clone } = await recipientApi();

  expect(await open({ path: file })).toMatchObject({
    stage: "error",
    missingCheckout: { remote: sender.repository.cloneUrl, name: "review" },
  });

  expect(
    await clone({
      url: `file://${sender.repo}`,
      parent: sender.root,
      name: "elsewhere",
    }),
  ).toMatchObject({ status: 409 });
});

it("clones into a new folder only, and leaves nothing behind when it fails", async () => {
  const { sender } = await recipientApi();

  const root = await cloneForReader(
    path.join(sender.root, "projects"),
    "review",
    `file://${sender.repo}`,
  );

  expect(
    execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"])
      .toString()
      .trim(),
  ).toBe("true");
  await expect(
    cloneForReader(
      path.join(sender.root, "projects"),
      "review",
      `file://${sender.repo}`,
    ),
  ).rejects.toThrow(/already exists/);
  await expect(
    cloneForReader(sender.root, "../out", `file://${sender.repo}`),
  ).rejects.toThrow(/plain folder name/);
  await expect(
    cloneForReader(sender.root, "gone", `file://${sender.root}/missing`),
  ).rejects.toThrow(ReviewInputError);
  expect(existsSync(path.join(sender.root, "gone"))).toBe(false);
});

it("opens a file read-only without a checkout, reading the lines it carries", async () => {
  const { recipient, text, file, open, fetchRepository } = await recipientApi();

  const opened = await open({ path: file, readOnly: true });

  expect(opened.error).toBeUndefined();
  expect(opened.stage).toBe("ready");
  expect(fetchRepository).not.toHaveBeenCalled();

  const pins = recipient.store.read(opened.reviewId).pins!;
  const [excerpt] = parseWhiteboardFile(text).sources;

  const side = excerpt!.commit === pins.head ? "head" : "base";

  const read = await recipient.data.file(pins, side, excerpt!.file);

  expect(
    read.text
      .split("\n")
      .slice(
        excerpt!.fromLine - 1,
        excerpt!.fromLine - 1 + excerpt!.lines.length,
      ),
  ).toEqual(excerpt!.lines);

  // A read-only copy does not stand in for one on a checkout.
  expect(await open({ path: file })).toMatchObject({ stage: "error" });
});

it("opens a file on a checkout that holds every pinned commit", async () => {
  const { recipient, file, open, checkout } = await recipientApi();
  const local = await checkout("no-origin");

  const opened = await open({ path: file });

  expect(opened.stage).toBe("ready");
  expect(recipient.store.read(opened.reviewId).pins?.repositoryId).toBe(local);
});

it("exports and opens a board of an Azure DevOps repository", async () => {
  const { sender, recipient, open, checkout } = await recipientApi();

  execFileSync("git", [
    "-C",
    sender.repo,
    "remote",
    "add",
    "origin",
    "git@ssh.dev.azure.com:v3/org/Payments%20Hub/iac",
  ]);

  const exported = await exportShare({
    ...sender,
    reviewId: sender.reviewId,
    repository: undefined,
    ...(await readShareRepository(sender.repo)),
  });

  expect(exported.repository).toBeUndefined();
  expect(exported.remote).toEqual({
    url: "https://dev.azure.com/org/Payments%20Hub/_git/iac",
  });

  const file = path.join(sender.root, "azure.whiteboard");
  await writeFile(file, whiteboardFileText(exported));

  // Another project's checkout with the same commits is not preferred.
  await checkout("other", "https://dev.azure.com/org/Other/_git/iac");

  const own = await checkout(
    "azure",
    "https://Org@dev.azure.com/Org/Payments%20Hub/_git/iac",
  );

  const opened = await open({ path: file });

  expect(opened.stage).toBe("ready");
  expect(recipient.store.read(opened.reviewId).pins?.repositoryId).toBe(own);
});

it("reports a file that is not a whiteboard", async () => {
  const { sender, open } = await recipientApi();
  const file = path.join(sender.root, "notes.whiteboard");
  await writeFile(file, "nope");

  expect(await open({ path: file })).toMatchObject({
    stage: "error",
    error: "This is not a Whiteboard file.",
  });
});

it("shows update guidance when opening a newer Whiteboard file", async () => {
  const { file, open } = await recipientApi();
  const next = Number(SHARE_FORMAT.split("/")[1]) + 1;
  await writeFile(file, JSON.stringify({ format: `review-share/${next}` }));

  expect(await open({ path: file })).toMatchObject({
    stage: "error",
    error:
      "This action requires a newer version of Whiteboard. Use Check for Updates, then try again.",
  });
});

it("reports a file it cannot read", async () => {
  const { sender, open } = await recipientApi();

  expect(
    await open({ path: path.join(sender.root, "gone.whiteboard") }),
  ).toEqual({
    status: 400,
    error:
      "Could not read gone.whiteboard. Check that the file still exists and Whiteboard can open it.",
  });
});

it("refuses a relative file path", async () => {
  const { open } = await recipientApi();

  expect(await open({ path: "board.whiteboard" })).toMatchObject({
    status: 400,
  });
});
