import { mkdir } from "node:fs/promises";

import { type VcsArg, gitAt } from "@dev.fast/local-vcs";
import {
  normalizeGitHubRemote,
  normalizeGitRemote,
} from "@dev.fast/review-share-protocol";
import { type Pins, ReviewInputError } from "@dev.fast/whiteboard-document";

/** A full commit id, SHA-1 or SHA-256. */
export const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Refuses anything but full commit ids, before any of them reaches git:
 * a shared board's commits come from someone else, and one spelled as an
 * option or a refspec would make git do something else. */
export function assertCommitIds(commits: readonly string[]) {
  if (!commits.every((commit) => COMMIT_ID.test(commit)))
    throw new ReviewInputError(
      "The shared whiteboard names a commit that isn't a full commit id.",
    );
}

/** The transports a shared fetch may use. A shared board names its remote,
 * so `file`, `ext` and the rest stay off; tests add `file`. */
export const sharedProtocols = new Set(["https", "ssh"]);

/** Keep credential helpers but prevent the calling shell from redirecting
 * Git's object store. A fetch reaches only https and ssh remotes, and a
 * credential helper never waits for a person. */
export function sharedGit(cwd: string, args: VcsArg[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") ||
        [
          "GIT_SSH",
          "GIT_SSH_COMMAND",
          "GIT_ASKPASS",
          "GIT_SSH_VARIANT",
        ].includes(key),
    ),
  );

  return gitAt(
    cwd,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      ...[...sharedProtocols].flatMap((protocol) => [
        "-c",
        `protocol.${protocol}.allow=always`,
      ]),
      ...args,
    ],
    { env: { ...env, GCM_INTERACTIVE: "never" } },
  );
}

const UNADVERTISED =
  /not our ref|couldn't find remote ref|unadvertised object/i;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A catch boundary: git's error may be anything.
const stderrOf = (error: unknown) =>
  error instanceof Error && "stderr" in error ? String(error.stderr) : "";

function fetchError(stderr: string): ReviewInputError {
  if (UNADVERTISED.test(stderr))
    return new ReviewInputError(
      "The shared commits are no longer available on the repository's remote. Ask the sender to push or restore them, then retry.",
      409,
    );

  if (
    /could not read (?:username|password)|authentication failed|permission denied \(publickey|repository not found|returned error: 40[13]|\bSAML\b/i.test(
      stderr,
    )
  )
    return new ReviewInputError(
      "Git couldn't access this repository. Your Whiteboard sign-in doesn't grant repository access, so set up Git credentials for it, then retry.",
      409,
    );

  return new ReviewInputError(
    "Could not fetch the repository. Check your connection and Git credentials for this repository, then retry.",
    409,
  );
}

/** `commits` are other commits the board's references read at; a plan has
 * only those. */
export async function fetchPinnedRepository(
  root: string,
  url: string,
  pins: Pick<Pins, "base" | "head"> | undefined,
  commits: readonly string[] = [],
) {
  // Each commit and the ref it is fetched to.
  const named = [
    ...(pins
      ? [
          { commit: pins.base, ref: "base" },
          { commit: pins.head, ref: "head" },
        ]
      : []),
    ...commits.map((commit) => ({ commit, ref: `commits/${commit}` })),
  ];

  if (!named.every(({ commit }) => COMMIT_ID.test(commit)))
    throw new ReviewInputError(
      "Sharing requires immutable base and head commits.",
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await sharedGit(root, ["init", "--quiet"]);
  await sharedGit(root, ["config", "core.hooksPath", "/dev/null"]);
  await sharedGit(root, ["config", "core.fsmonitor", "false"]);

  if (process.platform === "win32")
    await sharedGit(root, ["config", "core.longpaths", "true"]);

  await sharedGit(root, ["remote", "add", "origin", { remote: url }]);

  try {
    await sharedGit(root, [
      "fetch",
      "--no-tags",
      "--force",
      "origin",
      ...named.map(({ commit, ref }) => ({
        refspec: { from: commit, to: `refs/review/${ref}` },
      })),
    ]);
  } catch (error) {
    throw fetchError(stderrOf(error));
  }

  for (const { commit } of named)
    await sharedGit(root, ["cat-file", "-e", { rev: `${commit}^{commit}` }]);
}

/** Fetches the commits a shared board's links read at into a checkout of
 * its repository, from its origin unless it has them, and keeps each under
 * `refs/review/shared/<share>/<commit>`, so `git gc` can't prune one the
 * board still quotes. */
export async function fetchSharedCommits(
  root: string,
  commits: readonly string[],
  share: string,
) {
  assertCommitIds(commits);

  const ref = (commit: string) => `refs/review/shared/${share}/${commit}`;
  const missing: string[] = [];

  for (const commit of commits)
    try {
      await sharedGit(root, ["cat-file", "-e", { rev: `${commit}^{commit}` }]);
      await sharedGit(root, ["update-ref", { ref: ref(commit) }, { commit }]);
    } catch {
      missing.push(commit);
    }

  if (!missing.length) return;

  try {
    await sharedGit(root, [
      "fetch",
      "--no-tags",
      "origin",
      ...missing.map((commit) => ({
        refspec: { from: commit, to: ref(commit), force: true },
      })),
    ]);

    return;
  } catch (error) {
    // A server that serves only advertised commits (Azure DevOps, Bitbucket)
    // still has them on a branch.
    if (!UNADVERTISED.test(stderrOf(error))) throw fetchError(stderrOf(error));
  }

  try {
    await sharedGit(root, ["fetch", "--no-tags", "origin"]);
  } catch (error) {
    throw fetchError(stderrOf(error));
  }

  for (const commit of missing)
    try {
      await sharedGit(root, ["cat-file", "-e", { rev: `${commit}^{commit}` }]);
      await sharedGit(root, ["update-ref", { ref: ref(commit) }, { commit }]);
    } catch {
      throw fetchError("not our ref");
    }
}

/** Drops the refs `fetchSharedCommits` kept for a share, once the share is
 * gone, so `git gc` can prune what only it quoted. */
export async function forgetSharedCommits(root: string, share: string) {
  const { stdout } = await sharedGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    { ref: `refs/review/shared/${share}/` },
  ]);

  for (const ref of stdout.split("\n").filter(Boolean))
    await sharedGit(root, ["update-ref", "-d", { ref }]);
}

/** A managed clone of a repository's default branch, for a shared board
 * with no pins whose repository the receiver has no checkout of. */
export async function cloneSharedRepository(root: string, url: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await sharedGit(root, ["init", "--quiet"]);
  await sharedGit(root, ["config", "core.hooksPath", "/dev/null"]);
  await sharedGit(root, ["config", "core.fsmonitor", "false"]);

  if (process.platform === "win32")
    await sharedGit(root, ["config", "core.longpaths", "true"]);

  await sharedGit(root, ["remote", "add", "origin", { remote: url }]);

  try {
    await sharedGit(root, ["fetch", "--no-tags", "origin", "HEAD"]);
  } catch (error) {
    throw fetchError(stderrOf(error));
  }

  await sharedGit(root, ["checkout", "--detach", "FETCH_HEAD"]);
}

export async function repositoryReady(
  root: string,
  pins: Pick<Pins, "base" | "head">,
  commits: readonly string[] = [],
): Promise<boolean> {
  if (
    ![pins.base, pins.head, ...commits].every((commit) =>
      COMMIT_ID.test(commit),
    )
  )
    return false;

  try {
    const head = await sharedGit(root, ["rev-parse", "HEAD"]);

    if (head.stdout.trim() !== pins.head) return false;

    for (const commit of [pins.base, pins.head, ...commits])
      await sharedGit(root, ["cat-file", "-e", { rev: `${commit}^{commit}` }]);

    return true;
  } catch {
    return false;
  }
}

/** Where a reader fetches the board's commits: `repository` for GitHub, as
 * every reader understands it, `remote` for any other host. */
export async function readShareRepository(
  root: string,
): Promise<{ repository: { cloneUrl: string } } | { remote: { url: string } }> {
  let origin: string;

  try {
    origin = (
      await sharedGit(root, ["remote", "get-url", "origin"])
    ).stdout.trim();
  } catch {
    throw new ReviewInputError("Sharing requires an origin remote.");
  }

  try {
    return { repository: { cloneUrl: normalizeGitHubRemote(origin) } };
  } catch {
    // Not GitHub.
  }

  try {
    return { remote: { url: normalizeGitRemote(origin) } };
  } catch {
    throw new ReviewInputError(
      "Sharing requires an https or ssh origin remote.",
    );
  }
}
