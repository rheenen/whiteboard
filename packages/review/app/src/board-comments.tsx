import { focusStyles } from "@canvas/ui/focus";
import { ChatIcon, CheckIcon, PencilIcon, TrashIcon } from "@canvas/ui/icons";
import { Popover } from "@canvas/ui/popover";
import { useTooltip } from "@canvas/ui/tooltip";
import type { ReviewSidebarComment } from "@dev.fast/review-protocol";
import type { AgentSelection } from "@review/agent-selection";
import type { CommentPart } from "@review/comment-part";
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactElement,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { canvasQueryKeys } from "./canvas-query";
import { formatRelativeTime } from "./format";
import { useReviewSession } from "./host/review-session";
import { useNotify } from "./notify";
import type { GuidedTourStop } from "./review-panel-model";
import { fontSize, fontWeight, leading, radius, space } from "./scale.stylex";
import { tokens } from "./tokens.stylex";
import { Button, IconButton } from "./ui/button";
import { TextArea } from "./ui/text-field";

const partSchema = z.object({
  blockId: z.string(),
  id: z.string(),
  label: z.string(),
});

const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.string(),
  updatedAt: z.string(),
  resolved: z.boolean(),
  parentId: z.string().optional(),
  anchor: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("source"),
      file: z.string(),
      side: z.enum(["head", "base"]),
      fromLine: z.number(),
      toLine: z.number(),
      commit: z.string().optional(),
      part: partSchema.optional(),
    }),
    z.object({
      kind: z.literal("document"),
      blockId: z.string().optional(),
      quote: z.string().optional(),
      part: partSchema.optional(),
    }),
  ]),
  /** The selection it was made on, which finds a passage again. */
  selection: z.unknown().optional(),
});

/** A comment as the canvas reads it. */
export type BoardComment = z.infer<typeof commentSchema> &
  Pick<ReviewSidebarComment, "anchor">;

const listSchema = z.object({ comments: z.array(commentSchema) });

/** A change to a comment: a new body, resolved or reopened. */
type CommentChange = { body: string } | { resolved: boolean };

export interface BoardComments {
  /** The board's comments, oldest first; empty until the first read. */
  comments: BoardComment[];
  /** Reads them again, after a comment is added. */
  refresh: () => void;
  change: (id: string, change: CommentChange) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

const BoardCommentsContext = createContext<BoardComments | null>(null);

/** How often the canvas reads the comments again: the sidebar can resolve
 * or delete one. */
const REFRESH_MS = 5_000;

/** The board's comments, shared by the comment icons on the document, the
 * diagrams and the code, and by the composer that adds to them. */
export function BoardCommentsProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const session = useReviewSession();
  const queryClient = useQueryClient();
  const notify = useNotify();

  const queryKey = useMemo(
    () => canvasQueryKeys.comments(session.reviewId),
    [session.reviewId],
  );

  const list = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await session.fetch("/comments");

      if (!response.ok) throw new Error("Unavailable");

      return listSchema.parse(await response.json()).comments;
    },
    refetchInterval: REFRESH_MS,
  });

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  const mutation = useMutation({
    mutationFn: async ({
      id,
      change,
    }: {
      id: string;
      change: CommentChange | "delete";
    }) => {
      const response = await session.fetch(
        `/comments/${encodeURIComponent(id)}`,
        change === "delete"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(change),
            },
      );

      if (!response.ok) throw new Error("Unavailable");
    },
    onSettled: refresh,
  });

  const { mutateAsync } = mutation;

  const apply = useCallback(
    async (id: string, change: CommentChange | "delete") => {
      try {
        await mutateAsync({ id, change });

        return true;
      } catch {
        notify({
          kind: "error",
          text:
            change === "delete"
              ? "Could not delete the comment."
              : "Could not save the comment.",
        });

        return false;
      }
    },
    [mutateAsync, notify],
  );

  const comments = list.data;

  const value = useMemo<BoardComments>(
    () => ({
      comments: comments ?? [],
      refresh,
      change: (id, change) => apply(id, change),
      remove: (id) => apply(id, "delete"),
    }),
    [comments, refresh, apply],
  );

  return (
    <BoardCommentsContext.Provider value={value}>
      {children}
    </BoardCommentsContext.Provider>
  );
}

export function useBoardComments(): BoardComments | null {
  return useContext(BoardCommentsContext);
}

/** The open comments on one diagram part, oldest first. */
export function usePartComments(
  blockId: string,
  matches: (partId: string) => boolean,
): BoardComment[] {
  const comments = useBoardComments()?.comments;

  return useMemo(
    () =>
      (comments ?? []).filter(
        (comment) =>
          !comment.resolved &&
          comment.anchor.part?.blockId === blockId &&
          matches(comment.anchor.part.id),
      ),
    [comments, blockId, matches],
  );
}

/** The diagram block whose parts are drawn below: their comment icons
 * find their comments by it. */
export const DiagramCommentScope = createContext<string | null>(null);

/** The comment icon on a diagram part, at its top right corner. `partId` is
 * the part's tour step, or with `scoped` the step's id after
 * `<block id>:`; with `steps`, also the steps under it (`<partId>:<n>`), as
 * a flow node with several sources has. */
export function DiagramPartPin({
  partId,
  label,
  scoped = false,
  steps = false,
}: {
  partId: string;
  label: string;
  scoped?: boolean;
  steps?: boolean;
}): ReactElement | null {
  const blockId = useContext(DiagramCommentScope);
  const full = scoped ? `${blockId}:${partId}` : partId;

  const matches = useCallback(
    (id: string) => id === full || (steps && id.startsWith(`${full}:`)),
    [full, steps],
  );

  const comments = usePartComments(blockId ?? "", matches);

  if (!blockId || !comments.length) return null;

  // "nopan" and "nodrag" keep the diagram's pan and drag off the icon.
  return (
    <span className="nopan nodrag" {...stylex.props(styles.partPin)}>
      <CommentPin comments={comments} label={label} />
    </span>
  );
}

/** What a comment on a diagram step is on. */
export interface PartSelection {
  target: AgentSelection["target"];
  title: string;
  part: CommentPart;
}

/** A comment on a diagram step: on the code behind it when it has code,
 * else on the diagram's block. */
export function partSelection(
  blockId: string,
  stop: GuidedTourStop,
): PartSelection {
  const source =
    stop.content.kind === "source" ? stop.content.source : stop.anchor.peek;

  const title = stop.label.slice(0, 500);
  const part = { blockId, id: stop.anchor.id, label: title };

  if (!source) return { target: { kind: "block", blockId }, title, part };

  // A range across sides ("diff/path#L84-R90") comments on its head end.
  const across = source.start.side !== source.end.side;
  const side = across ? source.end.side : source.start.side;
  const startLine = across ? source.end.line : source.start.line;

  return {
    target: {
      kind: "code",
      path: source.file,
      side,
      startLine,
      endLine: source.end.line,
    },
    title,
    part,
  };
}

/** A comment icon with the number of comments it holds. A press shows them,
 * to read, edit, resolve or delete. */
export function CommentPin({
  comments,
  label,
  xstyle,
}: {
  comments: readonly BoardComment[];
  /** What the comments are on, for the icon's name. */
  label: string;
  xstyle?: stylex.StyleXStyles;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const pin = useRef<HTMLButtonElement | null>(null);
  const [newest] = comments.slice(-1);

  const tooltip = useTooltip(
    newest
      ? `${newest.author}: ${truncate(newest.body, 120)}${comments.length > 1 ? ` (+${comments.length - 1})` : ""}`
      : "",
    { quick: true },
  );

  const bind = useCallback(
    (node: HTMLButtonElement | null) => {
      pin.current = node;

      return tooltip(node);
    },
    [tooltip],
  );

  if (!newest) return null;

  return (
    <>
      <button
        ref={bind}
        type="button"
        {...stylex.props(focusStyles.ring, styles.pin, xstyle)}
        aria-label={
          comments.length === 1
            ? `Comment on ${label}`
            : `${comments.length} comments on ${label}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        data-comment-pin=""
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <ChatIcon xstyle={styles.pinIcon} />
        {comments.length > 1 ? comments.length : null}
      </button>
      {open ? (
        <Popover
          anchor={pin}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label={`Comments on ${label}`}
          xstyle={styles.popover}
        >
          <ul {...stylex.props(styles.list)}>
            {comments.map((comment) => (
              <CommentItem key={comment.id} comment={comment} />
            ))}
          </ul>
        </Popover>
      ) : null}
    </>
  );
}

function CommentItem({ comment }: { comment: BoardComment }): ReactElement {
  const board = useBoardComments();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const body = draft.trim();

    if (!board || saving || !body) return;

    if (body === comment.body) {
      setEditing(false);

      return;
    }

    setSaving(true);

    if (await board.change(comment.id, { body })) setEditing(false);

    setSaving(false);
  };

  return (
    <li {...stylex.props(styles.item)}>
      <div {...stylex.props(styles.meta)}>
        <span {...stylex.props(styles.author)}>{comment.author}</span>
        <span {...stylex.props(styles.time)}>
          {formatRelativeTime(comment.updatedAt, Date.now(), { short: true })}
        </span>
        <span {...stylex.props(styles.spacer)} />
        {editing ? null : (
          <>
            <IconButton
              size="small"
              aria-label="Edit comment"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              <PencilIcon xstyle={styles.actionIcon} />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Resolve comment"
              onClick={() => board?.change(comment.id, { resolved: true })}
            >
              <CheckIcon xstyle={styles.actionIcon} />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Delete comment"
              onClick={() => board?.remove(comment.id)}
            >
              <TrashIcon xstyle={styles.actionIcon} />
            </IconButton>
          </>
        )}
      </div>
      {editing ? (
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextArea
            autoFocus
            aria-label="Comment"
            value={draft}
            rows={3}
            xstyle={styles.draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Leaves the editor, not the popover.
                event.stopPropagation();
                setEditing(false);
              }

              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <div {...stylex.props(styles.actions)}>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={saving}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p {...stylex.props(styles.body)}>{comment.body}</p>
      )}
    </li>
  );
}

function truncate(text: string, length: number) {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

const styles = stylex.create({
  pin: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    minWidth: "22px",
    height: "22px",
    paddingInline: space.s4,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: tokens.accent,
      ":hover": tokens.accentOutline,
    },
    borderRadius: radius.pill,
    backgroundColor: {
      default: tokens.accentSoft,
      ":hover": tokens.accentWash,
    },
    color: tokens.accent,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.small,
    fontWeight: fontWeight.medium,
    lineHeight: leading.none,
    cursor: "pointer",
    flexShrink: 0,
  },
  partPin: {
    position: "absolute",
    top: 0,
    right: 0,
    transform: "translate(50%, -50%)",
    zIndex: 5,
    display: "flex",
  },
  pinIcon: {
    width: "13px",
    height: "13px",
  },
  popover: {
    position: "fixed",
    top: "calc(anchor(bottom) + 4px)",
    right: "auto",
    bottom: "auto",
    left: "anchor(left)",
    width: "320px",
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "min(420px, calc(100vh - 16px))",
    margin: 0,
    padding: space.s8,
    overflowY: "auto",
    positionTryFallbacks: "flip-inline, flip-block",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: space.s6,
    minHeight: "22px",
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.body,
  },
  author: {
    color: tokens.ink,
    fontWeight: fontWeight.semibold,
  },
  time: {
    color: tokens.inkFaint,
  },
  spacer: {
    flexGrow: 1,
  },
  actionIcon: {
    width: "14px",
    height: "14px",
  },
  body: {
    margin: 0,
    color: tokens.ink,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.ui,
    lineHeight: leading.normal,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
  },
  draft: {
    width: "100%",
    resize: "vertical",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s6,
  },
});
