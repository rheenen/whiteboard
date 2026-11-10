// A diagram runs its script against `wb` in the same sandboxed stage as an
// animation. The stage is opaque to the test, so these read what the host
// draws from what the stage reports: the stage's size, the error line, the
// step strip, and the Verify summary built from the claims it counted.

import {
  loadFixture,
  mountWhiteboard,
  settled,
} from "@canvas/whiteboard-fixture";
import type { JsonObject } from "@dev.fast/json";
import {
  type Block,
  documentSchema,
  selectionKey,
} from "@dev.fast/whiteboard-document";
import type { ReviewProgress } from "@review/review-api/review-progress";
import type { Snapshot } from "@review/review-api/store";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import "@canvas/styles.css";

const pins = { repositoryId: "repo", base: "base", head: "head" };

const DRAWING = `
const app = wb.node({ id: "app", kind: "container", label: "App" });
const orders = wb.node({ id: "orders", kind: "container", label: "Orders", code: "status" });
const store = wb.node({ id: "store", kind: "database", label: "Store" });
wb.edge({ from: app, to: orders, label: "HTTPS" });
wb.edge({ from: orders, to: store, code: "status" });
await wb.layout();
`;

const diagram = (fields: JsonObject = {}): Block =>
  documentSchema.parse([
    {
      id: "diagram-1",
      type: "diagram",
      title: "Orders",
      script: DRAWING,
      code: {
        status: {
          source: "head/order.ts#L1",
          evidence: "status",
          label: "Status line",
        },
      },
      pins,
      ...fields,
    },
  ])[0]!;

const progress: ReviewProgress = {
  files: [],
  lenses: [],
  resolvedSelections: {
    [selectionKey({
      file: "order.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 1 },
    })]: [{ file: "order.ts", side: "head", fromLine: 1, toLine: 1 }],
  },
};

let canvas: ReturnType<typeof mountWhiteboard> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  document.body.replaceChildren();
});

async function mount(block: Block, staleSources?: string[]) {
  const snapshot: Snapshot = {
    reviewId: "diagram-review",
    version: 0,
    title: "Diagrams",
    pins,
    target: { kind: "commits", ...pins },
    document: [block],
    createdAt: "2026-11-01T00:00:00.000Z",
    ...(staleSources && { staleSources }),
  };

  const container = document.createElement("div");
  container.style.cssText = "width: 860px; margin: 0 auto;";
  document.body.append(container);

  await act(async () => {
    canvas = mountWhiteboard(
      container,
      loadFixture({
        snapshot,
        progress,
        commits: [],
        images: {},
        traces: {},
        maps: {},
      }),
    );
  });

  return container;
}

const figure = () => document.querySelector<HTMLElement>(".animation-block");

// A stage holds 120px until its script reports the drawing's size; these
// drawings are shorter, so a smaller stage has run.
const drawn = () => stageHeight() > 72 && stageHeight() < 120;

const stageHeight = () =>
  document.querySelector<HTMLIFrameElement>(".animation-block iframe")
    ?.parentElement?.parentElement?.offsetHeight ?? 0;

const alertText = () =>
  document.querySelector(".animation-block [role='alert']")?.textContent ??
  null;

const summary = () =>
  document.querySelector(".animation-block [role='status']")?.textContent ?? "";

const button = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(".animation-block button"),
  ].find(
    (item) =>
      item.textContent === name || item.getAttribute("aria-label") === name,
  );

// The name of the frame showing, under the player's track.
const current = () =>
  document.querySelector(".animation-block [aria-current='step']")?.textContent;

describe("diagram", () => {
  it("lays out its script's drawing and sizes the stage to it", async () => {
    await mount(diagram());

    expect(await settled(drawn, 8000)).toBe(true);
    expect(figure()?.querySelector("figcaption")?.textContent).toContain(
      "DIAGRAM",
    );
    // A still diagram has no player under it.
    expect(document.querySelector("[role='slider']")).toBeNull();
    expect(button("Replay step")).toBeUndefined();
    expect(alertText()).toBeNull();
  });

  it("counts its claims against the code when the reader verifies", async () => {
    await mount(diagram());
    expect(await settled(drawn, 8000)).toBe(true);

    await act(async () => button("Verify")!.click());

    // Orders and its wire to Store back onto the status line; App, Store
    // and the App wire name no code.
    expect(
      await settled(() => summary() === "2 match · 3 unlinked", 4000),
    ).toBe(true);
    expect(button("Verify")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks a claim changed when the board marked its code stale", async () => {
    // The server marks a range stale when its evidence left it. The diagram
    // still draws, and says so without being asked.
    await mount(diagram(), ["diagram-1:code:status"]);
    expect(await settled(drawn, 8000)).toBe(true);
    expect(await settled(() => summary() === "2 changed")).toBe(true);
    await act(async () => button("Verify")!.click());

    expect(
      await settled(
        () => summary() === "0 match · 2 changed · 3 unlinked",
        4000,
      ),
    ).toBe(true);
  });

  it("fits a chart's title into its box, and reports a chart that overflows", async () => {
    const chart = (height: string) => `
      wb.chart({
        label: "Bars",
        x: 0, y: 0, width: 400, height: 160,
        plot: ({ Plot }) => ({
          title: "A title above the plot",
          ${height}
          marks: [Plot.barX([1, 2, 3])],
        }),
      });
    `;

    const findings = () =>
      document.querySelector<HTMLElement>(".animation-block")?.dataset
        .findings ?? "";

    const ran = () =>
      document
        .querySelector(".animation-block")
        ?.hasAttribute("data-stage-ran") === true;

    await mount(
      diagram({ script: chart(""), stage: { width: 400, height: 160 } }),
    );
    expect(await settled(ran, 8000)).toBe(true);
    // Plot loads after the script ends; give the chart a moment to draw.
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(findings()).toBe("");

    await act(async () => canvas?.dispose());
    document.body.replaceChildren();

    // A script that fixes the plot's own height cannot be fitted.
    await mount(
      diagram({
        script: chart("height: 400,"),
        stage: { width: 400, height: 160 },
      }),
    );
    expect(
      await settled(() => findings().includes('Chart "Bars" draws'), 8000),
    ).toBe(true);
  });

  it("moves a group's name clear of the wires that enter it", async () => {
    // Two wires drop into a narrow group from above, one under each end of
    // its header: the name has to go to the group's bottom.
    await mount(
      diagram({
        script: `
          const a = wb.node({ id: "a", kind: "container", label: "A" });
          const b = wb.node({ id: "b", kind: "container", label: "B" });
          const c = wb.node({ id: "c", kind: "container", label: "C" });
          const d = wb.node({ id: "d", kind: "container", label: "D" });
          wb.edge({ from: a, to: b });
          wb.edge({ from: a, to: c });
          wb.edge({ from: b, to: c });
          wb.edge({ from: c, to: d });
          wb.group({ label: "A long group name", around: [c, d] });
          await wb.layout({ direction: "down" });
        `,
        code: {},
      }),
    );

    expect(
      await settled(
        () =>
          document
            .querySelector(".animation-block")
            ?.hasAttribute("data-stage-ran") === true,
        8000,
      ),
    ).toBe(true);
    expect(
      document.querySelector<HTMLElement>(".animation-block")?.dataset
        .findings ?? "",
    ).toBe("");
  });

  it("stacks a group down inside a drawing that runs across", async () => {
    // Three nodes in a row are one node tall; stacked, they are three.
    const script = (direction: string) => `
      const a = wb.node({ id: "a", kind: "container", label: "A" });
      const b = wb.node({ id: "b", kind: "container", label: "B" });
      const c = wb.node({ id: "c", kind: "container", label: "C" });
      const d = wb.node({ id: "d", kind: "container", label: "D" });
      wb.edge({ from: a, to: b, label: "in" });
      wb.edge({ from: a, to: c });
      wb.edge({ from: b, to: c });
      wb.edge({ from: c, to: d });
      wb.group({ label: "Inside", around: [b, c, d]${direction} });
      await wb.layout({ direction: "right" });
    `;

    const ran = () =>
      document
        .querySelector(".animation-block")
        ?.hasAttribute("data-stage-ran") === true;

    await mount(diagram({ script: script(""), code: {} }));
    expect(await settled(ran, 8000)).toBe(true);
    const across = stageHeight();

    await act(async () => canvas?.dispose());
    document.body.replaceChildren();

    await mount(diagram({ script: script(', direction: "down"'), code: {} }));
    expect(await settled(ran, 8000)).toBe(true);
    expect(stageHeight()).toBeGreaterThan(across * 2);
    expect(
      document.querySelector<HTMLElement>(".animation-block")?.dataset
        .findings ?? "",
    ).toBe("");
  });

  it("keeps a manual layout where the script put it, and names a node it never placed", async () => {
    const script = (third: string) => `
      const a = wb.node({ id: "a", kind: "container", label: "A", x: 0, y: 0, width: 120, height: 48 });
      const b = wb.node({ id: "b", kind: "container", label: "B", x: 200, y: 0, width: 120, height: 48 });
      const c = wb.node({ id: "c", kind: "container", label: "C", ${third} width: 120, height: 48 });
      wb.edge({ from: a, to: b });
      wb.edge({ from: a, to: c });
      await wb.layout({ mode: "manual" });
    `;

    const ran = () =>
      document
        .querySelector(".animation-block")
        ?.hasAttribute("data-stage-ran") === true;

    const findings = () =>
      document.querySelector<HTMLElement>(".animation-block")?.dataset
        .findings ?? "";

    // Two rows: the stage takes the drawing's height, 48 + 80 + 48.
    await mount(diagram({ script: script("x: 0, y: 128,"), code: {} }));
    expect(await settled(ran, 8000)).toBe(true);
    expect(findings()).toBe("");
    expect(stageHeight()).toBeGreaterThan(176);

    await act(async () => canvas?.dispose());
    document.body.replaceChildren();

    await mount(diagram({ script: script(""), code: {} }));
    expect(await settled(ran, 8000)).toBe(true);
    expect(findings()).toContain('Node "C" has no x and y');
  });

  it("runs an edit of a diagram with steps in a new stage", async () => {
    const frames = [
      {
        key: "sent",
        title: "Order sent",
        moves: [{ from: "app", to: "orders" }],
      },
      {
        key: "stored",
        title: "Order stored",
        moves: [{ from: "orders", to: "store" }],
      },
    ];

    // Laid out downward, the three nodes stack; across, they sit in a row.
    const container = await mount(
      diagram({
        frames,
        script: DRAWING.replace(
          "wb.layout()",
          'wb.layout({ direction: "down" })',
        ),
      }),
    );

    expect(await settled(() => stageHeight() > 300, 8000)).toBe(true);

    // The agent turns it across: the stage runs the new script.
    const edited = diagram({ frames });
    await act(async () =>
      canvas?.update(
        loadFixture({
          snapshot: {
            reviewId: "diagram-review",
            version: 1,
            title: "Diagrams",
            pins,
            target: { kind: "commits", ...pins },
            document: [edited],
            createdAt: "2026-11-01T00:00:00.000Z",
          },
          progress,
          commits: [],
          images: {},
          traces: {},
          maps: {},
        }),
      ),
    );

    expect(await settled(() => stageHeight() < 300, 8000)).toBe(true);
    expect(container.textContent).toContain("Order sent");
  });

  it("shows what its script threw", async () => {
    await mount(diagram({ script: 'throw new Error("no orders");' }));

    expect(
      await settled(() => alertText()?.includes("no orders") === true, 8000),
    ).toBe(true);
  });

  it("shows a syntax error in its script", async () => {
    await mount(diagram({ script: "wb.node({ kind: " }));

    expect(
      await settled(() => alertText()?.includes("SyntaxError") === true, 8000),
    ).toBe(true);
  });

  it("steps through frames whose moves ride the wires", async () => {
    await mount(
      diagram({
        frames: [
          {
            key: "sent",
            title: "Order sent",
            label: "SENT",
            moves: [{ from: "app", to: "orders", label: "POST" }],
          },
          {
            key: "stored",
            title: "Order stored",
            label: "STORED",
            moves: [{ from: "orders", to: "store" }],
          },
        ],
      }),
    );

    expect(await settled(() => current() === "SENT", 8000)).toBe(true);
    await act(async () => button("STORED")!.click());
    expect(await settled(() => current() === "STORED")).toBe(true);

    // Reached by hand, the last stop is the end: the line runs full.
    const stretches = () => [
      ...document.querySelector("[role='slider'][aria-label='Frame']")!
        .firstElementChild!.children,
    ];

    expect(stretches().map((stretch) => stretch.childElementCount)).toEqual([
      1,
    ]);
    expect(button("Replay")).toBeDefined();

    // The arrows on the track step between frames.
    const press = (key: string) =>
      act(async () => {
        document
          .querySelector("[role='slider'][aria-label='Frame']")!
          .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    await press("ArrowLeft");
    expect(await settled(() => current() === "SENT")).toBe(true);
    await press("ArrowRight");
    expect(await settled(() => current() === "STORED")).toBe(true);

    // The moves play once; the reader asks to see them again.
    await act(async () => button("Replay step")!.click());
    expect(current()).toBe("STORED");
    expect(alertText()).toBeNull();
  });

  it("plays a timeline through its chapters", async () => {
    await mount(
      diagram({
        timeline: {
          chapters: [
            { key: "ask", title: "Ask", duration: 400 },
            { key: "answer", title: "Answer", duration: 400 },
          ],
        },
      }),
    );

    const play = () => button("Play") ?? button("Pause") ?? button("Replay");

    // The stage reports its size once its script has run.
    expect(await settled(drawn, 8000)).toBe(true);
    await act(async () => play()!.click());
    expect(await settled(() => button("Replay") !== undefined, 4000)).toBe(
      true,
    );
    expect(alertText()).toBeNull();
  });

  it("moves a timeline's playhead from its track", async () => {
    await mount(
      diagram({
        timeline: {
          chapters: [
            { key: "ask", title: "Ask", duration: 2000 },
            { key: "answer", title: "Answer", duration: 2000 },
          ],
        },
      }),
    );

    expect(await settled(drawn, 8000)).toBe(true);

    const slider = () =>
      document.querySelector<HTMLElement>("[role='slider']")!;

    const current = () =>
      document.querySelector("[aria-current='step']")?.textContent;

    const press = (key: string) =>
      act(async () => {
        slider().dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });

    const valueNow = () => Number(slider().getAttribute("aria-valuenow"));

    // Right snaps to the next frame's start, Left back to the one before.
    await press("ArrowRight");
    expect(await settled(() => current() === "Answer" && valueNow() > 0)).toBe(
      true,
    );
    const answer = valueNow();
    await press("ArrowLeft");
    expect(await settled(() => valueNow() === 0)).toBe(true);
    await press("ArrowRight");
    expect(await settled(() => valueNow() === answer)).toBe(true);

    // The chapter's name jumps back to its start.
    await act(async () => button("Ask")!.click());
    expect(await settled(() => valueNow() === 0)).toBe(true);

    await press("End");
    expect(await settled(() => button("Replay") !== undefined)).toBe(true);
  });
});
