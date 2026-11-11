import { useCallback } from "react";

import { useAgentSelection } from "./agent-selection";
import { partSelection } from "./board-comments";
import type { GuidedTour } from "./review-panel-model";

/** Offers the selection actions (Add comment among them) on the diagram
 * part a click chose: on the code behind it when it has code. */
export function useOfferPartComment(tour: GuidedTour) {
  const select = useAgentSelection();

  return useCallback(
    (anchorId: string) => {
      const stop = tour.stops.find((item) => item.anchor.id === anchorId);

      if (!stop) return;

      // After the click opened the part's peek or the expanded diagram, so
      // the actions land on what is on screen then, at the pointer.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => select(partSelection(tour.id, stop))),
      );
    },
    [select, tour],
  );
}
