import { defineBlock, label } from "./definition.js";

/** Retired with trace capture: stored boards still parse, agents cannot
 * write it, and the canvas shows a placeholder. */
export const trace_quote = {
  type: "trace_quote",
  reference: [],
  schema: defineBlock("trace_quote", {
    traceId: label,
    eventId: label,
    text: label,
  }),
} as const;
