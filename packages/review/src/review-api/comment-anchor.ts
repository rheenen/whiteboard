import os from "node:os";

import type { AgentSelection } from "@review/agent-selection.js";
import {
  COMMIT_ID,
  readShareRepository,
  sharedGit,
} from "@review/sharing/repository.js";

import type { LocalReviewData } from "./local-data.js";
import type { CommentAnchor } from "./review-comments.js";
import type { ReviewStore, Snapshot } from "./store.js";

/** Where a selection points, resolved once, when the comment is made: a PR
 * tool reads it later without the checkout, the store or this server. */
export async function commentAnchor(
  store: ReviewStore,
  data: LocalReviewData | undefined,
  snapshot: Snapshot,
  selection: AgentSelection,
): Promise<CommentAnchor> {
  const target = selection.target;

  if (target.kind === "text")
    return {
      kind: "document",
      ...(target.anchor && { blockId: target.anchor.blockId }),
      quote: target.quote,
    };

  if (target.kind === "block")
    return { kind: "document", blockId: target.blockId };

  if (target.kind === "review") return { kind: "document" };

  const range = {
    kind: "source" as const,
    file: target.path.replace(/^\/+/, ""),
    side: target.side,
    fromLine: Math.min(target.startLine, target.endLine),
    toLine: Math.max(target.startLine, target.endLine),
  };

  const pins = await data
    ?.resolveSource(
      snapshot,
      selection.apiSource?.commit,
      selection.apiSource?.pins,
    )
    .then((resolved) => resolved.pins)
    .catch(() => undefined);

  const root = pins?.repositoryId
    ? safely(() => store.repositoryPath(pins.repositoryId))
    : undefined;

  const commit = pins?.[target.side];

  const repo =
    (root ? await originUrl(root) : undefined) ?? snapshot.shared?.cloneUrl;

  return {
    ...range,
    ...(repo && { repo }),
    ...(commit &&
      COMMIT_ID.test(commit) &&
      !(target.side === "head" && pins?.worktreeRevision) && { commit }),
  };
}

/** Who wrote a comment: the checkout's Git author, else the login name. */
export async function commentAuthor(
  store: ReviewStore,
  snapshot: Snapshot,
): Promise<string> {
  const repositoryId =
    snapshot.pins?.repositoryId ?? snapshot.target?.repositoryId;

  const root = repositoryId
    ? safely(() => store.repositoryPath(repositoryId))
    : undefined;

  if (root) {
    const name = await sharedGit(root, ["config", "user.name"])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");

    if (name) return name;
  }

  return safely(() => os.userInfo().username) ?? "unknown";
}

async function originUrl(root: string) {
  const found = await readShareRepository(root).catch(() => undefined);

  if (!found) return undefined;

  return "repository" in found ? found.repository.cloneUrl : found.remote.url;
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
