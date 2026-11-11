import { useCallback } from "react";

import { useAgentSelection } from "./agent-selection";
import { partSelection } from "./board-comments";
import type { GuidedTour, GuidedTourStop } from "./review-panel-model";

/** Offers the selection actions (Add comment among them) on a step of a
 * diagram or call tree that a click chose: on the code behind it when it
 * has code. */
export function useOfferStopComment() {
  const select = useAgentSelection();

  return useCallback(
    (blockId: string, stop: GuidedTourStop) =>
      // After the click opened the step's peek or the expanded diagram, so
      // the actions land on what is on screen then, at the pointer.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => select(partSelection(blockId, stop))),
      ),
    [select],
  );
}

/** Offers the selection actions on the diagram part a click chose. */
export function useOfferPartComment(tour: GuidedTour) {
  const offer = useOfferStopComment();

  return useCallback(
    (anchorId: string) => {
      const stop = tour.stops.find((item) => item.anchor.id === anchorId);

      if (stop) offer(tour.id, stop);
    },
    [offer, tour],
  );
}
