import * as stylex from "@stylexjs/stylex";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { z } from "zod";

import { resolveAskAnchor } from "./ask-anchor";
import {
  type BoardComment,
  CommentPin,
  useBoardComments,
} from "./board-comments";

const BLOCK = "[data-review-node-id]";

/** The passage a text comment was made on, as its selection kept it. */
const passageSchema = z.object({
  target: z.object({
    kind: z.literal("text"),
    anchor: z.object({
      blockId: z.string(),
      start: z.number(),
      end: z.number(),
      text: z.string(),
    }),
  }),
});

/** Comments on one place of the document, and where their icon goes. */
interface Spot {
  key: string;
  label: string;
  comments: BoardComment[];
  /** Relative to the layer's box. */
  x: number;
  y: number;
}

/** Comment icons on the whiteboard's text: at the end of a commented
 * passage, or at the top right corner of a commented block. A comment on a
 * diagram part shows on its diagram instead. */
export function DocumentCommentPins({
  articleRef,
  revision,
}: {
  articleRef: RefObject<HTMLElement | null>;
  /** The rendered document; a new one is searched again. */
  revision: string;
}): ReactElement | null {
  const comments = useBoardComments()?.comments;
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [layout, setLayout] = useState(0);

  useEffect(() => {
    setLayer(
      articleRef.current?.closest<HTMLElement>(".review-document") ??
        articleRef.current,
    );
  }, [articleRef, revision]);

  const open = useMemo(
    () =>
      (comments ?? []).filter(
        (comment) =>
          !comment.resolved &&
          comment.anchor.kind === "document" &&
          !comment.anchor.part &&
          comment.anchor.blockId,
      ),
    [comments],
  );

  // The text reflows as the layer resizes; the icons follow it.
  useEffect(() => {
    if (!layer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayout((count) => count + 1));

    observer.observe(layer);

    return () => observer.disconnect();
  }, [layer]);

  useLayoutEffect(() => {
    const article = articleRef.current;

    if (!layer || !article || !open.length) {
      setSpots([]);

      return;
    }

    const box = layer.getBoundingClientRect();

    const at = (x: number, y: number) => ({
      x: x - box.left + layer.scrollLeft,
      y: y - box.top + layer.scrollTop,
    });

    const byKey = new Map<string, Spot>();

    for (const comment of open) {
      const place = spotOf(article, comment);

      if (!place) continue;
      const spot = byKey.get(place.key);

      if (spot) spot.comments.push(comment);
      else
        byKey.set(place.key, {
          key: place.key,
          label: place.label,
          comments: [comment],
          ...at(place.x, place.y),
        });
    }

    setSpots([...byKey.values()]);
  }, [articleRef, layer, open, revision, layout]);

  if (!layer || !spots.length) return null;

  return createPortal(
    <>
      {spots.map((spot) => (
        <span
          key={spot.key}
          {...stylex.props(styles.spot)}
          style={{ left: spot.x, top: spot.y }}
        >
          <CommentPin comments={spot.comments} label={spot.label} />
        </span>
      ))}
    </>,
    layer,
  );
}

/** Where a comment's icon goes, in the viewport: after its passage when the
 * passage is still there, else at its block's corner. */
function spotOf(
  article: HTMLElement,
  comment: BoardComment,
): { key: string; label: string; x: number; y: number } | null {
  const { anchor } = comment;

  if (anchor.kind !== "document" || !anchor.blockId) return null;

  const passage = passageSchema.safeParse(comment.selection);

  const found = passage.success
    ? resolveAskAnchor(article, passage.data.target.anchor)
    : null;

  const last = found ? [...found.range.getClientRects()].at(-1) : undefined;

  if (found && last)
    return {
      key: `${anchor.blockId}:${found.start}:${found.end}`,
      label: anchor.quote ? `“${truncate(anchor.quote)}”` : "this passage",
      x: last.right + 2,
      y: last.top - 4,
    };

  const block = [...article.querySelectorAll<HTMLElement>(BLOCK)].find(
    (element) => element.dataset.reviewNodeId === anchor.blockId,
  );

  if (!block) return null;
  const rect = block.getBoundingClientRect();

  return {
    key: anchor.blockId,
    label: "this block",
    x: rect.right - 11,
    y: rect.top - 11,
  };
}

function truncate(text: string) {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

const styles = stylex.create({
  spot: {
    position: "absolute",
    zIndex: 3,
    display: "flex",
  },
});
