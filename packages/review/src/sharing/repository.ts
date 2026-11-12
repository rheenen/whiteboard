import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { type VcsArg, gitAt } from "@dev.fast/local-vcs";
import {
  normalizeGitHubRemote,
  normalizeGitRemote,
} from "@dev.fast/review-share-protocol";
import { ReviewInputError } from "@dev.fast/whiteboard-document";

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

/** The folder name a clone of `url` gets, as `git clone` would pick it. */
export function repositoryName(url: string): string {
  const last = url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .at(-1);

  let name = "";

  try {
    name = decodeURIComponent(last ?? "");
  } catch {
    name = last ?? "";
  }

  name = name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+/, "");

  return name || "repository";
}

/** A full clone of a file's repository for the reader to keep, into a new
 * folder `name` in `parent`. Only https and ssh remotes; no hooks run. */
export async function cloneForReader(
  parent: string,
  name: string,
  url: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(name) || name === "..")
    throw new ReviewInputError("Use a plain folder name for the clone.");

  const root = path.join(parent, name);

  if (existsSync(root))
    throw new ReviewInputError(
      `${root} already exists. Choose another folder, or open that checkout in Whiteboard.`,
      409,
    );

  await mkdir(parent, { recursive: true });

  try {
    await sharedGit(parent, ["clone", "--quiet", { remote: url }, name]);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw fetchError(stderrOf(error));
  }

  return root;
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
