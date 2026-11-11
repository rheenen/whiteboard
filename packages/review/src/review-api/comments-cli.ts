import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";

import { reviewServerStateDir } from "@review/server-discovery.js";

import { listReviewComments } from "./review-comments.js";

/** The version of the JSON `whiteboard comments --json` writes. A change
 * that a reader must know about raises it. */
export const COMMENTS_SCHEMA = 1;

/** Prints a whiteboard's comments from its saved state, without a server:
 * it reads the database read-only, also while Desktop is closed. */
export function runCommentsCli(input: {
  review?: string;
  session?: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}): number {
  const reviewId = input.review ?? input.session;

  if (
    !reviewId ||
    (input.review && input.session && input.review !== input.session)
  ) {
    input.stderr.write(
      "Give one whiteboard: --review <id> or --session <id>.\n",
    );

    return 2;
  }

  const stateDir = reviewServerStateDir(input.env);
  const databasePath = path.join(stateDir, "review-api.db");

  if (!existsSync(databasePath)) {
    input.stderr.write(`No saved whiteboards in ${stateDir}.\n`);

    return 1;
  }

  let db: DatabaseSync;

  try {
    db = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
  } catch (error) {
    input.stderr.write(
      `Cannot read ${databasePath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    return 1;
  }

  try {
    if (!db.prepare("SELECT 1 FROM reviews WHERE id=?").get(reviewId)) {
      input.stderr.write(`No whiteboard ${reviewId} in ${stateDir}.\n`);

      return 1;
    }

    const comments = listReviewComments(db, reviewId).map(
      ({
        title: _title,
        selection: _selection,
        version: _version,
        ...comment
      }) => comment,
    );

    if (input.json) {
      input.stdout.write(
        `${JSON.stringify({ schema: COMMENTS_SCHEMA, reviewId, sessionId: reviewId, comments }, null, 2)}\n`,
      );

      return 0;
    }

    if (!comments.length) {
      input.stdout.write("No comments.\n");

      return 0;
    }

    for (const comment of comments) {
      const { anchor } = comment;

      const place =
        anchor.kind === "source"
          ? `${anchor.file}:${anchor.fromLine}-${anchor.toLine} (${anchor.side})`
          : anchor.blockId
            ? `block ${anchor.blockId}`
            : "whiteboard";

      input.stdout.write(
        `${comment.id}  ${place}${comment.resolved ? "  [resolved]" : ""}\n  ${comment.author}, ${comment.updatedAt}\n${comment.body
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n\n`,
      );
    }

    return 0;
  } finally {
    db.close();
  }
}
