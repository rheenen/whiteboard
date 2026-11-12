import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runReviewCli } from "@review/cli-runner.js";
import { ReviewApiClient } from "@review/review-api/client.js";
import type { ReviewServerDiscovery } from "@review/server-discovery.js";
import { parseWhiteboardFile } from "@review/sharing/file.js";
import * as repository from "@review/sharing/repository.js";
import { afterEach, expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { runHeadlessServer } from "./headless-host.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("exports a board to a file through a real headless server and CLI without Desktop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-headless-sharing-"));
  const fixture = await createShareFixture(root);
  const stateDir = path.join(root, "server");
  const pins = fixture.store.read(fixture.reviewId).pins;

  vi.spyOn(repository, "readShareRepository").mockResolvedValue({
    repository: fixture.repository,
  });

  vi.stubEnv("DEV_REVIEW_HOME", stateDir);
  vi.stubEnv("SHELL", "");

  const abort = new AbortController();
  const ready = Promise.withResolvers<ReviewServerDiscovery>();

  const running = runHeadlessServer({
    stateDir,
    signal: abort.signal,
    onReady: ready.resolve,
  });

  try {
    const discovery = await Promise.race([
      ready.promise,
      running.then(() => {
        throw new Error("Server exited before readiness");
      }),
    ]);

    const client = new ReviewApiClient({
      serverUrl: discovery.url,
      token: discovery.token,
    });

    await client.post("/repositories", {
      path: fixture.repo,
    });

    const d = await client.post<{ reviewId: string }>("/commands", {
      operation: {
        type: "create",
        title: "CI review",
        target: {
          kind: "commits",
          repositoryPath: fixture.repo,
          base: pins!.base,
          head: pins!.head,
        },
      },
    });

    await client.post("/commands", {
      operation: {
        type: "edit",
        reviewId: d.reviewId,
        edit: {
          type: "insert",
          content: {
            type: "section",
            title: "Summary",
            children: [
              {
                type: "code_peek",
                source: `head/${fixture.sourceFile}#L1`,
              },
            ],
          },
        },
      },
    });

    const file = path.join(root, "exported", "ci.whiteboard");
    const stdout = new PassThrough();
    let exported = "";
    stdout.on("data", (chunk) => {
      exported += chunk;
    });

    expect(
      await runReviewCli({
        argv: [
          "--state-dir",
          stateDir,
          "export",
          "--review",
          d.reviewId,
          "--out",
          file,
          "--json",
        ],
        env: process.env,
        stdout,
        stderr: new PassThrough(),
      }),
    ).toBe(0);
    expect(JSON.parse(exported)).toEqual({ path: file });
    expect(parseWhiteboardFile(await readFile(file, "utf8"))).toMatchObject({
      reviewId: d.reviewId,
      title: "CI review",
      repository: fixture.repository,
    });
  } finally {
    abort.abort();
    await running;
    await fixture.data.close();
    await fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
