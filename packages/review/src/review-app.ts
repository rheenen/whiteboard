import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { gitAt } from "@dev.fast/local-vcs";
import {
  ReviewApiClient,
  ReviewApiError,
  type ReviewApiSummary,
} from "@dev.fast/review-protocol";
import { normalizeGitRemote } from "@dev.fast/review-share-protocol";

import {
  type ReviewInstanceSelection,
  healthyReviewInstance,
  reviewInstanceUnavailable,
  selectReviewInstance,
} from "./desktop-discovery";
import { focusReviewDesktop, runReviewAppLaunch } from "./review-app-launcher";
import { pickReview } from "./review-app-picker";
import { resolveReviewRoot } from "./runtime";
import { parseWhiteboardFile } from "./sharing/file";
import { validateShareBundle } from "./sharing/import";

interface ReviewAppRuntime {
  launch: typeof runReviewAppLaunch;
  selectInstance: () => Promise<ReviewInstanceSelection>;
  resolveReviewRoot: typeof resolveReviewRoot;
  pickReview: typeof pickReview;
  fetch: typeof globalThis.fetch;
}

export class ReviewAppUsageError extends Error {
  readonly name = "ReviewAppUsageError";
}

export class ReviewAppStateError extends Error {
  readonly name = "ReviewAppStateError";
}

export interface RunReviewAppInput {
  cwd: string;
  reviewUuid?: string;
  /** Bring Whiteboard Desktop forward. */
  focus?: boolean;
  stdin: NodeJS.ReadStream;
  stdout: Writable;
}

export interface ReviewAppEvent {
  event: "app";
  action: "pick";
  reviewUuid: string;
  title: string;
  cancelled?: boolean;
}

export async function runReviewAppPick(
  input: RunReviewAppInput,
  overrides: Partial<ReviewAppRuntime> = {},
): Promise<ReviewAppEvent | null> {
  const fetch = overrides.fetch ?? globalThis.fetch;

  const runtime = {
    launch: runReviewAppLaunch,
    selectInstance: () => selectReviewInstance({ fetch }),
    resolveReviewRoot,
    pickReview,
    fetch,
    ...overrides,
  };

  // Only `whiteboard app launch` may recover a stale or incompatible record; the
  // other verbs report the diagnosis rather than start a second Desktop. No
  // record at all means nothing is running, which launching does fix.
  let selection = await runtime.selectInstance();
  let launched = false;

  if (!selection.instance && !selection.problem) {
    await runtime.launch({ focus: input.focus });
    launched = true;
    selection = await runtime.selectInstance();
  }

  const discovery = healthyReviewInstance(selection);

  if (!discovery) throw reviewInstanceUnavailable(selection);

  const client = new ReviewApiClient(
    { serverUrl: discovery.url, token: discovery.token },
    runtime.fetch,
  );

  let review: Pick<ReviewApiSummary, "reviewId" | "title">;

  if (input.reviewUuid) {
    // Without `full`, GET /reviews-api/:id answers inspectSnapshot(): block
    // descriptors with no reviewId or title.
    review = await client.read(
      `/${encodeURIComponent(input.reviewUuid)}?full=true`,
    );
  } else {
    if (!input.stdin.isTTY)
      throw new ReviewAppUsageError(
        "whiteboard app pick needs a terminal without --session. Pass --session <uuid> or run it in a terminal.",
      );
    const root = await runtime.resolveReviewRoot(input.cwd);

    const reviews = (await client.read<ReviewApiSummary[]>(""))
      .filter((review) => review.repositoryPath === root && !review.trashedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (!reviews.length) throw new ReviewAppStateError("No review to show.");

    const picked = await runtime.pickReview(
      reviews.map((review) => ({
        uuid: review.reviewId,
        title: review.title,
        status: review.viewedAt ? "viewed" : "new",
        lastPublishedAt: review.createdAt,
      })),
      input,
    );

    if (!picked) return null;
    review = { reviewId: picked.uuid, title: picked.title };
  }

  await client.post(`/${encodeURIComponent(review.reviewId)}/open`, {});

  // A focused fresh launch already came forward; a running one must be asked.
  if (input.focus && !launched)
    await focusReviewDesktop(discovery, runtime.fetch);

  return {
    event: "app",
    action: "pick",
    reviewUuid: review.reviewId,
    title: review.title,
  };
}

export type ReviewAppImportCode =
  | "invalid_file"
  | "remote_mismatch"
  | "no_desktop"
  | "missing_checkout"
  | "import_failed"
  | "pending"
  | "imported_not_opened";

export class ReviewAppImportError extends Error {
  readonly name = "ReviewAppImportError";
  constructor(
    message: string,
    readonly code: ReviewAppImportCode,
    readonly remote?: string,
    readonly reviewUuid?: string,
  ) {
    super(message);
  }
}

interface RunReviewAppImportInput {
  cwd: string;
  file: string;
  repo?: string;
  readOnly?: boolean;
  focus?: boolean;
  timeoutMs?: number;
}

export interface ReviewAppImportEvent {
  event: "app";
  action: "import";
  reviewUuid: string;
  title: string;
}

interface ImportStatus {
  stage: "reading" | "fetching" | "validating" | "ready" | "error";
  reviewId: string;
  title?: string;
  error?: string;
  missingCheckout?: { remote?: string };
}

export async function runReviewAppImport(
  input: RunReviewAppImportInput,
  overrides: Partial<ReviewAppRuntime> = {},
): Promise<ReviewAppImportEvent> {
  const file = path.resolve(input.cwd, input.file);
  let remote: string | undefined;

  try {
    if (!(await stat(file)).isFile()) throw new Error("Not a regular file.");

    const { bundle, snapshot } = validateShareBundle(
      parseWhiteboardFile(await readFile(file, "utf8")),
    );

    remote = bundle.repository?.cloneUrl ?? bundle.remote?.url;

    if (snapshot.pins && !remote)
      throw new Error("The whiteboard has pins but no repository remote.");
  } catch (error) {
    throw new ReviewAppImportError(String(error), "invalid_file");
  }

  if (!input.repo && !input.readOnly)
    throw new ReviewAppImportError(
      "Pass --repo or --read-only.",
      "remote_mismatch",
    );
  const repo = input.repo ? path.resolve(input.cwd, input.repo) : undefined;

  if (repo) {
    try {
      await gitAt(repo, ["rev-parse", "--show-toplevel"]);

      const origin = (
        await gitAt(repo, ["remote", "get-url", "origin"])
      ).stdout.trim();

      if (!remote || normalizeGitRemote(origin) !== normalizeGitRemote(remote))
        throw new Error(
          "The repository origin does not match the whiteboard remote.",
        );
    } catch (error) {
      throw new ReviewAppImportError(String(error), "remote_mismatch");
    }
  }

  const timeoutMs = input.timeoutMs ?? 120_000;
  const end = Date.now() + timeoutMs;
  const deadline = AbortSignal.timeout(timeoutMs);

  const bounded = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const abort = () => reject(deadline.reason);

      if (deadline.aborted) return abort();
      deadline.addEventListener("abort", abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener("abort", abort));
    });

  const baseFetch = overrides.fetch ?? globalThis.fetch;

  const fetch: typeof globalThis.fetch = (url, init) =>
    baseFetch(url, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([deadline, init.signal])
        : deadline,
    });

  const selectInstance =
    overrides.selectInstance ?? (() => selectReviewInstance({ fetch }));

  const select = async () => {
    if (deadline.aborted) throw deadline.reason;

    return bounded(selectInstance());
  };

  const launch = overrides.launch ?? runReviewAppLaunch;
  let client: ReviewApiClient;
  let discovery;

  try {
    let selection = await select();

    if (!selection.instance && !selection.problem) {
      await bounded(
        launch(
          { timeoutMs: Math.max(1, end - Date.now()) },
          {
            fetch,
            selectInstance: select,
            wait: async (ms) => {
              await delay(ms, undefined, { signal: deadline });
            },
          },
        ),
      );
      selection = await select();
    }

    discovery = healthyReviewInstance(selection);

    if (!discovery) throw reviewInstanceUnavailable(selection);
    client = new ReviewApiClient(
      { serverUrl: discovery.url, token: discovery.token },
      fetch,
    );

    if (repo) await client.post("/repositories", { path: repo }, deadline);

    if (deadline.aborted) throw deadline.reason;
  } catch (error) {
    throw new ReviewAppImportError(String(error), "no_desktop");
  }

  let status: ImportStatus;

  try {
    status = await client.post(
      "/sharing/import",
      { path: file, readOnly: input.readOnly },
      deadline,
    );
  } catch (error) {
    throw new ReviewAppImportError(
      String(error),
      error instanceof ReviewApiError ? "import_failed" : "pending",
    );
  }

  try {
    while (status.stage !== "ready" && status.stage !== "error") {
      await delay(500, undefined, { signal: deadline });
      status = await client.read(
        `/sharing/import/${encodeURIComponent(status.reviewId)}`,
        deadline,
      );
    }
  } catch (error) {
    throw new ReviewAppImportError(String(error), "pending");
  }

  if (status.stage === "error")
    throw new ReviewAppImportError(
      status.error ?? "Import failed.",
      status.missingCheckout ? "missing_checkout" : "import_failed",
      status.missingCheckout?.remote,
    );
  const reviewUuid = status.reviewId;

  try {
    const route = `/${encodeURIComponent(reviewUuid)}/open`;

    try {
      await client.post(route, {}, deadline);
    } catch (error) {
      if (!(error instanceof ReviewApiError) || error.status !== 409)
        throw error;
      await client.post(
        "/commands",
        {
          operation: {
            type: "lifecycle",
            reviewId: reviewUuid,
            state: "active",
          },
        },
        deadline,
      );
      await client.post(route, {}, deadline);
    }

    if (input.focus) await focusReviewDesktop(discovery, fetch);
  } catch (error) {
    throw new ReviewAppImportError(
      String(error),
      "imported_not_opened",
      undefined,
      reviewUuid,
    );
  }

  return {
    event: "app",
    action: "import",
    reviewUuid,
    title: status.title ?? "",
  };
}
