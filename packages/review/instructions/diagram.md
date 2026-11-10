A `diagram` component draws with a JavaScript module you write against the `wb` API, in a sandboxed stage on the whiteboard. It draws architecture, request flows, sequences, call paths and charts: nodes in groups, wires between them, laid out for you, and steps that move a request along the wires. Every node and wire links to the code it stands for, and the reader can check that each link still holds. The `session_edit` schema lists its fields.

## Work in files

1. Write a folder: `diagram.js` (the script), `block.json` (`title`, `description`, `code`, and `stage` or `timeline` when you need them), and, for steps, `frames.json` and `scenarios.json`. Start from the reference closest to what you are drawing, listed under References at the end of these instructions.
2. Publish it: `session_edit({ sessionId, edit: { type: "insert", fromFiles: "<folder>", parentId, afterId } })`. Later, `session_checkout({ sessionId, targetId })` writes the diagram back to a folder, and `{ type: "update", targetId, fromFiles }` publishes your changes. A publish is refused when someone changed the diagram after your checkout.
3. Look at it: `session_render({ sessionId, targetId, frame })` shows the diagram (or that frame) on the whiteboard open in Desktop and returns it as a PNG image, with:
   - `error`: what stopped the script, with its line in `diagram.js`;
   - `findings`: what drew but is wrong: overlapping nodes or labels, a wire through a node, a move with no wire, a code name the block does not define, a node id used twice;
   - `claims`: how many nodes and wires match their code, have changed, or name none.
     Fix every finding and render again. Do not take screenshots of the screen.
4. `session_get({ sessionId, targetId })` reports the same error, findings and claims from the last time an open whiteboard ran the script, without a picture.

## Draw it

Read `wb.d.ts` (its path is under References) before writing the script. End it with `await wb.layout()`, which places everything with ELK, or `await wb.layout({ mode: "manual" })` when you place the nodes yourself. See Pick a layout below.

```js
const web = wb.node({
  id: "web",
  kind: "container",
  label: "Web app",
  tag: "Container · React",
  code: "web-app",
});
const api = wb.node({
  id: "api",
  kind: "container",
  label: "API",
  tag: "Container · Go",
  code: "api-routes",
});
const db = wb.node({
  id: "db",
  kind: "database",
  label: "Orders",
  tag: "Database · Postgres",
  code: "orders-table",
});

wb.edge({ from: web, to: api, label: "HTTPS", code: "web-calls-api" });
wb.edge({ from: api, to: db, label: "SQL", code: "insert-order" });

wb.group({ id: "backend", label: "Backend", around: [api, db] });
await wb.layout({ direction: "right" });
```

- Pick each node's `kind` by what it is: `person`, `system`, `container` (an app or service), `component`, `database`, `queue`, `external` (a third party). Kinds differ by outline; colour belongs to groups and state.
- Group what belongs together with `wb.group({ label, around })`: inner groups first, then a group around them, which becomes their boundary. Colour says who owns what.
- Keep labels to a few words: "HTTPS", "gRPC", "GET /play". The wire's label says how it travels, its `code` says where.
- Use `var(--wb-ink)`, `var(--wb-muted)`, `var(--wb-accent)` and the other `--wb-*` variables, or `wb.colors()`, for anything you colour yourself, so the diagram follows the board's light and dark theme.

## Pick a layout

Keep the drawing near square: a long thin strip reads badly in a board's column. Two layouts get you there.

**ELK** (`await wb.layout()`) places nodes, groups, wires and labels and keeps them clear of each other. Use it when the graph branches or fans out, when groups nest, past about eight nodes, or when you cannot picture a clean arrangement. Give it a `direction`, and turn a long chain inside one group with `wb.group({ direction })`: a drawing laid out `right` whose group stacks `down` keeps the chain from stretching it.

**Manual** (`await wb.layout({ mode: "manual" })`) keeps the `x` and `y` you give every node. Use it for a small drawing whose shape you can see and ELK spreads out, such as a column of services beside the two things that call them, and for a chart or 3D scene beside a sketch. Each wire takes one elbow from the side that faces the other node into the facing side of the target, and wires that share a side spread apart. So:

- Set `width` and `height` on every node and line nodes up on shared rows and columns; a wire between aligned nodes runs straight.
- Leave at least 56px between nodes where a labelled wire runs, and 120px across a column gap.
- Put the two ends of a wire where its elbow will not cut through a third node or a group's name.
- The stage takes what you drew; give `stage` in `block.json` only for a size of your own.

Whichever you pick, render and fix the findings. If a manual drawing keeps colliding, switch to ELK.

## Steps and moves

For a request crossing the system, give the diagram `frames`: each frame is one step, and its `moves` are the movements in that step, which run together. A fan-out is one frame with several moves.

```json
[
  {
    "key": "ask",
    "title": "Request",
    "label": "REQUEST",
    "code": ["web-calls-api"],
    "moves": [{ "from": "web", "to": "api", "label": "POST /orders" }]
  },
  {
    "key": "store",
    "title": "Store the order",
    "label": "STORE",
    "code": ["insert-order"],
    "moves": [{ "from": "api", "to": "db", "label": "INSERT" }]
  },
  {
    "key": "reply",
    "title": "Reply",
    "label": "REPLY",
    "moves": [{ "from": "api", "to": "web", "label": "201" }]
  }
]
```

- Each move plays once when the reader reaches its step, and its token rests at the far end; the reader replays the step with a button under the diagram.
- Moves name nodes by their `id` and ride the wire between them; a move against the wire's direction is drawn as a reply. Every move needs a wire: the findings name one without.
- The stage lights what the request has reached so far, keeps the rest of its path plain, and dims everything it never touches. Call `wb.moves.manual()` to draw states and tokens yourself with `wb.onFrame`, `wb.token` and `wb.travel`.
- A frame's `code` lists the code that step walks through: the reader's code view follows the steps.
- For paths a reader can pick, such as a cache hit and a miss, or the old path and the new one, add `scenarios.json`: `[{ "key", "label", "frames": [frame keys in order] }]`. The whiteboard draws the picker.
- Give every frame a `label` (a word or two in capitals) or none.

A played diagram (a timeline the reader plays, pauses and scrubs) takes `timeline: { chapters: [{ key, title, duration }] }` in `block.json` instead of frames. Draw each moment from `wb.onTime((time, moment) => ...)`: time can jump either way.

## Charts

`wb.chart({ label, x, y, width, height, plot })` draws with Observable Plot. `plot` returns ordinary Plot options; the stage fills in the palette, the series colours in fixed order, and the fonts, and calls `plot` again on every theme, scenario and frame change, so a step can stress what it is about. Between steps each mark eases from where it was: bars resize, lines reshape, colours blend, and marks that appear or go fade. Keep the same marks in the same order across steps so they move rather than fade. One axis per chart. Label the series directly or give a legend. Give the chart `code` naming the query or code that produces its data.

## 3D scenes

For something physical or spatial that a flat drawing loses, `const THREE = await wb.three()` gives you three.js: the stage has no network, so never `import` it. Build the scene once, size the renderer to `stage.width` and `stage.height` in `block.json`, and draw it as a played diagram, posing everything as a function of time in `wb.onTime`. Prefer nodes and wires whenever the point is structure.

## Link the code

Name every range the diagram stands for in `block.json`'s `code`:

```json
"code": {
  "api-routes": { "source": "head/services/api/routes.go#L12-L30", "evidence": "func Routes(", "label": "API routes" },
  "insert-order": { "source": "head/services/api/orders.go#L48", "evidence": "INSERT INTO orders", "label": "Insert the order" }
}
```

- `evidence` is text that must appear inside the linked lines: the call or the definition the node or wire stands for. The whiteboard checks it when you publish (a link whose evidence is not in its lines is refused, naming the line where the text is now) and again whenever the board moves to new commits, marking a link whose evidence moved as changed.
- A node names where it is defined; a wire names its call site, the line where one side calls the other. A person, an external system and a wire to either claim nothing unless you give them `code`.
- A node or wire with code opens it beside the board when clicked, or with Enter. Mark anything else you draw with `wb.code(element, names, label)`.
- Leave nothing unlinked that is code: `claims.unlinked` in a render counts what names none.
