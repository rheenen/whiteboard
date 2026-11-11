import { z } from "zod";

/** The part of a diagram a comment is on: a step of its tour, as the
 * expanded diagram shows it. A comment on a part with code also points at
 * that code; one on a part without code points at the diagram only. */
export const commentPartSchema = z.strictObject({
  /** The diagram's block. */
  blockId: z.string().min(1).max(200),
  /** The step, as the diagram's tour names it. */
  id: z.string().min(1).max(400),
  /** What the diagram calls it. */
  label: z.string().max(500),
});

export type CommentPart = z.infer<typeof commentPartSchema>;
