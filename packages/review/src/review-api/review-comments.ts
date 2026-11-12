import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ReviewInputError } from "@dev.fast/whiteboard-document";
import { commentPartSchema } from "@review/comment-part.js";
import { z } from "zod";

/** Where a comment points in the source: a line range of one side of the
 * comparison, at the commit that side shows, in the repository its remote
 * names. A PR tool posts it as an inline comment on that range. */
export const commentSourceAnchorSchema = z.strictObject({
  kind: z.literal("source"),
  /** The origin remote, without credentials. Absent when the checkout has
   * no https or ssh origin. */
  repo: z.string().optional(),
  /** Relative to the repository root, without a leading slash. */
  file: z.string().min(1),
  side: z.enum(["head", "base"]),
  /** 1-based lines of the file at `commit`. */
  fromLine: z.number().int().positive(),
  toLine: z.number().int().positive(),
  /** The full commit id of the side. */
  commit: z.string().optional(),
  /** The diagram part whose code this is, when the comment was made on it. */
  part: commentPartSchema.optional(),
});

/** Where a comment points in the whiteboard's text: a block, a quote in it,
 * or the whole whiteboard when both are absent. */
export const commentDocumentAnchorSchema = z.strictObject({
  kind: z.literal("document"),
  blockId: z.string().optional(),
  quote: z.string().optional(),
  /** The diagram part, when the comment was made on one without code. */
  part: commentPartSchema.optional(),
});

export const commentAnchorSchema = z.discriminatedUnion("kind", [
  commentSourceAnchorSchema,
  commentDocumentAnchorSchema,
]);

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

export const reviewCommentSchema = z.strictObject({
  id: z.string(),
  reviewId: z.string(),
  /** Markdown. */
  body: z.string(),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Changes when the body or the anchor changes, so a reader can tell an
   * edited comment from one it already handled. */
  hash: z.string(),
  parentId: z.string().optional(),
  resolved: z.boolean(),
  anchor: commentAnchorSchema,
  /** What the selection showed, for the sidebar. */
  title: z.string(),
  /** The selection the comment was made on, to find it again on the
   * whiteboard. */
  selection: z.unknown().optional(),
  /** The whiteboard version the comment was made on. */
  version: z.number().int(),
});

export type ReviewComment = z.infer<typeof reviewCommentSchema>;

/** The longest comment body. */
export const COMMENT_BODY_LIMIT = 20_000;

export function commentHash(body: string, anchor: CommentAnchor) {
  return createHash("sha256")
    .update(JSON.stringify([body, sortedAnchor(anchor)]))
    .digest("hex");
}

/** The anchor with its keys in one order, so the hash does not depend on
 * how it was written. */
function sortedAnchor(anchor: CommentAnchor) {
  return Object.fromEntries(
    Object.entries(anchor)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

const rowSchema = z
  .object({
    id: z.string(),
    review_id: z.string(),
    parent_id: z.string().nullable(),
    body: z.string(),
    author: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    resolved: z.number(),
    anchor: z.string(),
    title: z.string(),
    selection: z.string().nullable(),
    version: z.number(),
  })
  .transform((row): ReviewComment => {
    const anchor = commentAnchorSchema.parse(JSON.parse(row.anchor));

    return {
      id: row.id,
      reviewId: row.review_id,
      body: row.body,
      author: row.author,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      hash: commentHash(row.body, anchor),
      ...(row.parent_id !== null && { parentId: row.parent_id }),
      resolved: row.resolved === 1,
      anchor,
      title: row.title,
      ...(row.selection !== null && { selection: JSON.parse(row.selection) }),
      version: row.version,
    };
  });

const LIST_SQL =
  "SELECT * FROM review_comments WHERE review_id=? ORDER BY created_at, id";

/** Reads a whiteboard's comments from a database that may have none yet,
 * without writing to it. */
export function listReviewComments(db: DatabaseSync, reviewId: string) {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_comments'",
    )
    .get();

  if (!table) return [];

  return db
    .prepare(LIST_SQL)
    .all(reviewId)
    .map((row) => rowSchema.parse(row));
}

export interface NewReviewComment {
  reviewId: string;
  body: string;
  author: string;
  anchor: CommentAnchor;
  title: string;
  selection?: unknown;
  version: number;
  parentId?: string;
}

/** The reviewer's own comments on a whiteboard, kept with the anchor they
 * resolved to when they were made. Deleting a board removes its comments by
 * hand (removeReview). */
export class ReviewComments {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: DatabaseSync,
    /** The store's rule for writing about a board: one in Trash is
     * read-only. */
    private readonly writable: (reviewId: string) => void = () => {},
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_comments(
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      parent_id TEXT,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      anchor TEXT NOT NULL,
      title TEXT NOT NULL,
      selection TEXT,
      version INTEGER NOT NULL);`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS review_comments_review ON review_comments(review_id, created_at)",
    );
  }

  /** Calls back when a comment is added, changed or deleted. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  list(reviewId: string) {
    return listReviewComments(this.db, reviewId);
  }

  get(reviewId: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM review_comments WHERE review_id=? AND id=?")
      .get(reviewId, id);

    return row ? rowSchema.parse(row) : undefined;
  }

  add(input: NewReviewComment) {
    this.writable(input.reviewId);

    if (input.parentId && !this.get(input.reviewId, input.parentId))
      throw new ReviewInputError(
        `Comment ${input.parentId} does not exist.`,
        404,
      );

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO review_comments(id,review_id,parent_id,body,author,created_at,updated_at,resolved,anchor,title,selection,version)
        VALUES(?,?,?,?,?,?,?,0,?,?,?,?)`,
      )
      .run(
        id,
        input.reviewId,
        input.parentId ?? null,
        input.body,
        input.author,
        now,
        now,
        JSON.stringify(input.anchor),
        input.title,
        input.selection === undefined ? null : JSON.stringify(input.selection),
        input.version,
      );
    this.changed();

    return this.get(input.reviewId, id)!;
  }

  update(
    reviewId: string,
    id: string,
    change: { body?: string; resolved?: boolean },
  ) {
    this.writable(reviewId);

    const found = this.get(reviewId, id);

    if (!found) return undefined;

    this.db
      .prepare(
        "UPDATE review_comments SET body=?, resolved=?, updated_at=? WHERE id=?",
      )
      .run(
        change.body ?? found.body,
        (change.resolved ?? found.resolved) ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    this.changed();

    return this.get(reviewId, id);
  }

  /** Deletes a comment and its replies. */
  delete(reviewId: string, id: string) {
    this.writable(reviewId);

    const { changes } = this.db
      .prepare(
        "DELETE FROM review_comments WHERE review_id=? AND (id=? OR parent_id=?)",
      )
      .run(reviewId, id, id);

    if (changes > 0) this.changed();

    return changes > 0;
  }

  removeReview(reviewId: string) {
    this.db
      .prepare("DELETE FROM review_comments WHERE review_id=?")
      .run(reviewId);
    this.changed();
  }
}
