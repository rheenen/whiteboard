import * as stylex from "@stylexjs/stylex";
import { describe, expect, it } from "vitest";

import { scopeReviewCanvasCss } from "../desktop-css-scope";
import { appMarker } from "./markers.stylex";
import {
  softwareMapFrameProps,
  softwareMapOverlayProps,
} from "./software-map/SoftwareMap";

import canvasCss from "./styles.css?inline";
import "./styles.css";

describe("Review layout", () => {
  it("keeps an expanded software map inside the viewport and above the topbar", () => {
    const styles = document.createElement("style");
    styles.textContent = scopeReviewCanvasCss(canvasCss);
    const canvas = document.createElement("div");
    canvas.className = "review-canvas-root";
    canvas.style.cssText =
      "position: fixed; inset: 40px 0 0; height: auto; min-height: 0";
    const review = document.createElement("div");
    review.className = `review-app ${stylex.props(appMarker).className}`;
    canvas.append(review);
    const frame = document.createElement("figure");
    frame.className = softwareMapFrameProps({
      expanded: true,
      showChrome: true,
    }).className!;
    const overlay = document.createElement("div");
    overlay.className = softwareMapOverlayProps({
      theme: "dark",
      nodeTint: "slate",
    }).className!;
    const closeButton = document.createElement("button");
    closeButton.setAttribute("aria-label", "Close expanded software map");
    overlay.append(closeButton, frame);
    canvas.append(overlay);
    document.body.append(styles, canvas);

    const overlayStyle = getComputedStyle(overlay);
    const frameStyle = getComputedStyle(frame);

    expect(frameStyle.marginBlockStart).toBe("0px");
    expect(frameStyle.marginBlockEnd).toBe("0px");
    expect(overlayStyle.position).toBe("fixed");
    const bounds = overlay.getBoundingClientRect();
    expect(bounds.top).toBe(40);
    expect(bounds.bottom).toBe(window.innerHeight);
    expect(bounds.width).toBe(window.innerWidth);
    expect(overlay.contains(document.elementFromPoint(100, 100))).toBe(true);
    expect(Number(overlayStyle.zIndex)).toBeGreaterThan(2_147_482_999);
    expect(
      overlay.querySelector('[aria-label="Close expanded software map"]'),
    ).toBe(closeButton);
  });
});
