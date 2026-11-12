import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDesktopProtocolMismatchError } from "./desktop-discovery";
import { runReviewAppImport, runReviewAppPick } from "./review-app";
import {
  cleanupTempDirs,
  selectingDesktop,
  tempDir,
} from "./review-test-utils";

const input = {
  cwd: "/repo",
  stdin: { isTTY: true } as NodeJS.ReadStream,
  stdout: process.stdout,
};

const launch = async () => ({
  event: "app" as const,
  action: "launch" as const,
  state: "running" as const,
  instanceId: "desktop",
});

const discovery = {
  version: 3 as const,
  instanceId: "desktop",
  url: "http://127.0.0.1:5570",
  token: "secret",
  appPid: 1,
  serverPid: 2,
  startedAt: 3,
};

const runtime = (
  fetch: typeof globalThis.fetch,
  read: () => Promise<typeof discovery | null> = async () => discovery,
) => ({
  launch,
  selectInstance: selectingDesktop(read, fetch),
  resolveReviewRoot: async () => "/repo",
  fetch,
});

describe("native Review picker", () => {
  it("asks for the snapshot the id lookup needs, not the block index", async () => {
    // Unversioned reads answer block descriptors, not the summary.
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (init?.method === "POST") return Response.json({ ok: true });

      return String(url).includes("full=true")
        ? Response.json({ reviewId: "review", version: 1, title: "Native" })
        : Response.json([{ id: "block-1", type: "markdown", label: "Native" }]);
    });

    expect(
      await runReviewAppPick(
        { ...input, reviewUuid: "review" },
        runtime(fetch),
      ),
    ).toEqual({
      event: "app",
      action: "pick",
      reviewUuid: "review",
      title: "Native",
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/reviews-api/review?full=true",
      "http://127.0.0.1:5570/reviews-api/review/open",
    ]);
  });
  it("offers only undismissed reviews from the current repository and handles cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json([
            {
              reviewId: "native",
              title: "Native",
              repositoryPath: "/repo",
              createdAt: "2026-09-16",
              viewedAt: null,
              trashedAt: null,
            },
            {
              reviewId: "dismissed",
              repositoryPath: "/repo",
              trashedAt: "2026-09-16",
            },
            { reviewId: "other", repositoryPath: "/elsewhere" },
          ]),
    );

    const pickReview = vi.fn<typeof import("./review-app-picker").pickReview>(
      async () => null,
    );

    expect(
      await runReviewAppPick(input, { ...runtime(fetch), pickReview }),
    ).toBeNull();
    expect(pickReview.mock.calls[0]?.[0]).toEqual([
      {
        uuid: "native",
        title: "Native",
        status: "new",
        lastPublishedAt: "2026-09-16",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("surfaces a missing native review without trying a different store", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json({ error: "Not found" }, { status: 404 }),
    );

    await expect(
      runReviewAppPick({ ...input, reviewUuid: "missing" }, runtime(fetch)),
    ).rejects.toThrow("Not found");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("launches Desktop when no pointer exists yet, then opens the review", async () => {
    const launched = vi.fn<typeof launch>(launch);
    let reads = 0;

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : Response.json({ reviewId: "review", title: "Native" }),
    );

    expect(
      await runReviewAppPick(
        { ...input, reviewUuid: "review" },
        {
          ...runtime(fetch, async () => (reads++ === 0 ? null : discovery)),
          launch: launched,
        },
      ),
    ).toEqual({
      event: "app",
      action: "pick",
      reviewUuid: "review",
      title: "Native",
    });
    expect(launched).toHaveBeenCalledOnce();
  });

  it("reports an unusable pointer instead of launching a second Desktop", async () => {
    const launched = vi.fn<typeof launch>(launch);

    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true }),
    );

    await expect(
      runReviewAppPick(
        { ...input, reviewUuid: "review" },
        {
          ...runtime(fetch, async () => {
            throw new ReviewDesktopProtocolMismatchError(999);
          }),
          launch: launched,
        },
      ),
    ).rejects.toThrow(
      "Whiteboard Desktop uses protocol 999, but this Whiteboard CLI needs protocol 3.",
    );
    expect(launched).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the instance as not running when the pointer leads nowhere", async () => {
    const launched = vi.fn<typeof launch>(launch);

    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("connection refused");
    });

    await expect(
      runReviewAppPick(
        { ...input, reviewUuid: "review" },
        { ...runtime(fetch), launch: launched },
      ),
    ).rejects.toThrow(
      "Whiteboard `stable` is not running. Start it with `whiteboard app launch`, or pick another instance with `whiteboard instances`. No Whiteboard is running.",
    );
    expect(launched).not.toHaveBeenCalled();
  });

  it("focuses a running Desktop after opening when asked", async () => {
    const fetch = desktopFetch();

    await runReviewAppPick(
      { ...input, reviewUuid: "review", focus: true },
      runtime(fetch),
    );
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:5570/health",
      "http://127.0.0.1:5570/reviews-api/review?full=true",
      "http://127.0.0.1:5570/reviews-api/review/open",
      "http://127.0.0.1:5570/app/focus",
    ]);
    expect(
      new Headers(fetch.mock.calls[3]?.[1]?.headers).get("x-review-token"),
    ).toBe("secret");
  });

  it("forwards focus to the launcher when no Desktop is running", async () => {
    const launched = vi.fn<typeof launch>(launch);
    let reads = 0;
    const fetch = desktopFetch();

    await runReviewAppPick(
      { ...input, reviewUuid: "review", focus: true },
      {
        ...runtime(fetch, async () => (reads++ === 0 ? null : discovery)),
        launch: launched,
      },
    );
    expect(launched).toHaveBeenCalledWith({ focus: true });
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(
      "http://127.0.0.1:5570/app/focus",
    );
  });
});

/** Healthy Desktop: answers the summary read, accepts every post. */
function desktopFetch() {
  return vi.fn<typeof globalThis.fetch>(async (url, init) =>
    String(url).endsWith("/health")
      ? healthyResponse()
      : Response.json(
          init?.method === "POST"
            ? { ok: true }
            : { reviewId: "review", title: "Native" },
        ),
  );
}

function healthyResponse(): Response {
  return Response.json({
    ok: true,
    instanceId: "desktop",
    desktopAttached: true,
  });
}

describe("app import", () => {
  afterEach(cleanupTempDirs);

  async function fixture() {
    const dir = await tempDir("review-app-import-");
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      "https://github.com/example/repo.git",
    ]);
    const file = path.join(dir, "board.whiteboard");

    const bundle = {
      format: "review-share/2",
      reviewId: "source",
      version: 1,
      title: "Board",
      snapshot: {
        reviewId: "source",
        version: 1,
        title: "Board",
        document: [],
        createdAt: "2026-01-01",
      },
      images: {},
      traces: {},
      maps: {},
      commits: [],
      selections: {},
      sources: [],
      repository: { cloneUrl: "https://github.com/example/repo.git" },
    };

    await writeFile(file, JSON.stringify(bundle));

    return { dir, file, bundle, writeFile };
  }

  it("imports and opens a board in order", async () => {
    const { dir, file } = await fixture();

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (String(url).endsWith("/sharing/import"))
        return Response.json({ stage: "reading", reviewId: "key" });

      if (String(url).includes("/sharing/import/"))
        return Response.json({
          stage: "ready",
          reviewId: "board",
          title: "Board",
        });

      return Response.json({ ok: true });
    });

    await expect(
      runReviewAppImport({ cwd: dir, file, repo: dir }, runtime(fetch)),
    ).resolves.toEqual({
      event: "app",
      action: "import",
      reviewUuid: "board",
      title: "Board",
    });
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/health",
      "/reviews-api/repositories",
      "/reviews-api/sharing/import",
      "/reviews-api/sharing/import/key",
      "/reviews-api/board/open",
    ]);
  });

  it.each(["bad", "frozen", "mismatch", "pins without remote"])(
    "rejects %s before contacting Desktop",
    async (kind) => {
      const { dir, file, bundle } = await fixture();

      if (kind === "bad") await writeFile(file, "not json");

      if (kind === "frozen")
        await writeFile(file, JSON.stringify({ ...bundle, frozen: true }));

      if (kind === "mismatch")
        execFileSync("git", [
          "-C",
          dir,
          "remote",
          "set-url",
          "origin",
          "https://github.com/other/repo.git",
        ]);

      if (kind === "pins without remote") {
        const { repository: _repository, ...rest } = bundle;
        await writeFile(
          file,
          JSON.stringify({
            ...rest,
            snapshot: {
              ...bundle.snapshot,
              pins: {
                base: "a".repeat(40),
                head: "b".repeat(40),
                repositoryId: "repo",
              },
            },
          }),
        );
      }

      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        runReviewAppImport({ cwd: dir, file, repo: dir }, runtime(fetch)),
      ).rejects.toMatchObject({
        code: kind === "mismatch" ? "remote_mismatch" : "invalid_file",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ stage: "error", reviewId: "key", error: "failed" }, "import_failed"],
    [
      {
        stage: "error",
        reviewId: "key",
        error: "checkout missing",
        missingCheckout: { remote: "https://github.com/example/repo.git" },
      },
      "missing_checkout",
    ],
  ])("reports server import errors", async (status, code) => {
    const { dir, file } = await fixture();

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (String(url).endsWith("/sharing/import"))
        return Response.json({ stage: "reading", reviewId: "key" });

      if (String(url).includes("/sharing/import/"))
        return Response.json(status);

      return Response.json({ ok: true });
    });

    await expect(
      runReviewAppImport({ cwd: dir, file, repo: dir }, runtime(fetch)),
    ).rejects.toMatchObject({
      code,
      ...("missingCheckout" in status && {
        remote: status.missingCheckout.remote,
      }),
    });
  });

  it("restores a trashed imported board and opens it", async () => {
    const { dir, file } = await fixture();
    let opened = false;

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (String(url).endsWith("/sharing/import"))
        return Response.json({
          stage: "ready",
          reviewId: "board",
          title: "Board",
        });

      if (String(url).endsWith("/board/open") && !opened) {
        opened = true;

        return Response.json({ error: "In Trash" }, { status: 409 });
      }

      return Response.json({ ok: true });
    });

    await runReviewAppImport({ cwd: dir, file, repo: dir }, runtime(fetch));

    const command = fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/commands"),
    );

    expect(JSON.parse(String(command?.[1]?.body))).toEqual({
      operation: { type: "lifecycle", reviewId: "board", state: "active" },
    });
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/board/open")),
    ).toHaveLength(2);
  });

  it("launches Desktop when none exists", async () => {
    const { dir, file } = await fixture();
    const launched = vi.fn<typeof launch>(launch);
    let reads = 0;

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : String(url).endsWith("/sharing/import")
          ? Response.json({ stage: "ready", reviewId: "board", title: "Board" })
          : Response.json({ ok: true }),
    );

    await runReviewAppImport(
      { cwd: dir, file, repo: dir },
      {
        ...runtime(fetch, async () => (reads++ ? discovery : null)),
        launch: launched,
      },
    );
    expect(launched).toHaveBeenCalledOnce();
  });

  it.each([
    "lost post",
    "failed poll",
    "deadline after post",
    "deadline before post",
    "open fails",
  ])("classifies %s", async (failure) => {
    const { dir, file } = await fixture();
    let aborted = false;

    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (
        (failure === "deadline before post" &&
          String(url).endsWith("/repositories")) ||
        (failure === "deadline after post" &&
          String(url).endsWith("/sharing/import"))
      ) {
        return await new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          ),
        );
      }

      if (String(url).endsWith("/sharing/import")) {
        if (failure === "lost post") throw new Error("connection lost");

        return Response.json(
          failure === "open fails"
            ? { stage: "ready", reviewId: "board", title: "Board" }
            : { stage: "reading", reviewId: "key" },
        );
      }

      if (String(url).includes("/sharing/import/"))
        throw new Error("poll failed");

      if (String(url).endsWith("/board/open"))
        return Response.json({ error: "open failed" }, { status: 500 });

      return Response.json({ ok: true });
    });

    await expect(
      runReviewAppImport(
        {
          cwd: dir,
          file,
          repo: dir,
          timeoutMs: failure.startsWith("deadline") ? 50 : 3000,
        },
        runtime(fetch),
      ),
    ).rejects.toMatchObject(
      failure === "deadline before post"
        ? { code: "no_desktop" }
        : failure === "open fails"
          ? { code: "imported_not_opened", reviewUuid: "board" }
          : { code: "pending" },
    );

    expect(aborted).toBe(failure.startsWith("deadline"));
  });

  it("imports read-only without registering a checkout", async () => {
    const { dir, file } = await fixture();

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/health")
        ? healthyResponse()
        : String(url).endsWith("/sharing/import")
          ? Response.json({ stage: "ready", reviewId: "board", title: "Board" })
          : Response.json({ ok: true }),
    );

    await runReviewAppImport(
      { cwd: dir, file, readOnly: true },
      runtime(fetch),
    );
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/repositories")),
    ).toBe(false);

    const post = fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/sharing/import"),
    );

    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      path: file,
      readOnly: true,
    });
  });

  it("rejects a bare repository before contacting Desktop", async () => {
    const { dir, file } = await fixture();
    const bare = path.join(dir, "bare.git");
    execFileSync("git", ["init", "--bare", "-q", bare]);
    execFileSync("git", [
      "-C",
      bare,
      "remote",
      "add",
      "origin",
      "https://github.com/example/repo.git",
    ]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      runReviewAppImport({ cwd: dir, file, repo: bare }, runtime(fetch)),
    ).rejects.toMatchObject({ code: "remote_mismatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an explicit import rejection", async () => {
    const { dir, file } = await fixture();

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (String(url).endsWith("/sharing/import"))
        return Response.json({ error: "rejected" }, { status: 400 });

      return Response.json({ ok: true });
    });

    await expect(
      runReviewAppImport({ cwd: dir, file, repo: dir }, runtime(fetch)),
    ).rejects.toMatchObject({ code: "import_failed" });
  });

  it("reports an imported board when focus fails", async () => {
    const { dir, file } = await fixture();

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/health")) return healthyResponse();

      if (String(url).endsWith("/sharing/import"))
        return Response.json({
          stage: "ready",
          reviewId: "board",
          title: "Board",
        });

      if (String(url).endsWith("/app/focus")) throw new Error("focus failed");

      return Response.json({ ok: true });
    });

    await expect(
      runReviewAppImport(
        { cwd: dir, file, repo: dir, focus: true },
        runtime(fetch),
      ),
    ).rejects.toMatchObject({
      code: "imported_not_opened",
      reviewUuid: "board",
    });
  });

  it("bounds Desktop selection by the deadline", async () => {
    const { dir, file } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      runReviewAppImport(
        { cwd: dir, file, readOnly: true, timeoutMs: 20 },
        { fetch, selectInstance: () => new Promise(() => {}) },
      ),
    ).rejects.toMatchObject({ code: "no_desktop" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
