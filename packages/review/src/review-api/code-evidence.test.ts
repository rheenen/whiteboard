import { type Pins, ReviewInputError } from "@dev.fast/whiteboard-document";
import { describe, expect, it } from "vitest";

import { diagramEvidenceProblems, evidenceIn } from "./code-evidence.js";

const FILE = [
  "import { router } from './router';",
  "",
  "router.post('/orders', create);",
  "",
  "export function create(request) {",
  "  return save(request.body);",
  "}",
].join("\n");

describe("evidenceIn", () => {
  it("holds when the text is inside the linked lines", () => {
    expect(evidenceIn(FILE, 3, 3, "router.post(")).toEqual({ holds: true });
  });

  it("names the line the text moved to", () => {
    expect(evidenceIn(FILE, 1, 1, "router.post(")).toEqual({
      holds: false,
      movedTo: 3,
    });
  });

  it("picks the occurrence nearest the old lines", () => {
    const twice = `${FILE}\nrouter.post('/again', create);`;

    expect(evidenceIn(twice, 7, 7, "router.post(")).toEqual({
      holds: false,
      movedTo: 8,
    });
  });

  it("reports text gone from the file", () => {
    expect(evidenceIn(FILE, 3, 3, "router.put(")).toEqual({ holds: false });
  });

  it("matches text across lines, and in a file with CRLF line ends", () => {
    const crlf = FILE.replaceAll("\n", "\r\n");

    expect(evidenceIn(crlf, 5, 6, "create(request) {\n  return save(")).toEqual(
      { holds: true },
    );
  });
});

describe("diagramEvidenceProblems", () => {
  const pins = { repositoryId: "repo", base: "base", head: "head" };

  const read = async (_pins: Pins, _side: string, file: string) => {
    if (file !== "orders.ts")
      throw new ReviewInputError(`${file} does not exist.`, 404);

    return FILE;
  };

  it("lists each link whose evidence left its lines", async () => {
    const problems = await diagramEvidenceProblems(
      {
        code: {
          route: { source: "head/orders.ts#L3", evidence: "router.post(" },
          moved: { source: "head/orders.ts#L1", evidence: "export function" },
          gone: { source: "head/orders.ts#L3", evidence: "router.delete(" },
          missing: { source: "head/other.ts#L3", evidence: "x" },
        },
      },
      pins,
      read,
    );

    expect(problems).toEqual([
      '- moved: "export function" is not in head/orders.ts#L1; it is at line 5.',
      '- gone: "router.delete(" is not in orders.ts.',
      "- missing: other.ts cannot be read: other.ts does not exist.",
    ]);
  });
});
