// A diagram's code links carry evidence: text that must appear inside the
// linked lines. A link holds while it does; when the code moves, the text
// shows up elsewhere in the file, and when the code goes, nowhere.

import { isJsonObject } from "@dev.fast/json";
import {
  type Block,
  type DiagramBlock,
  type Edit,
  type Pins,
  ReviewInputError,
  anchorPins,
  anchorSelection,
  blocks,
  elements,
} from "@dev.fast/whiteboard-document";

/** Where a link's evidence is: inside its lines, moved to another line
 * (from 1), or gone from the file. */
export type EvidenceState =
  | { holds: true }
  | { holds: false; movedTo?: number };

/** Whether `evidence` is inside lines `start` to `end` (from 1, inclusive)
 * of `text`, and if not, the line nearest them where it is now. */
export function evidenceIn(
  text: string,
  start: number,
  end: number,
  evidence: string,
): EvidenceState {
  const file = text.replaceAll("\r\n", "\n");
  const wanted = evidence.replaceAll("\r\n", "\n");
  const lines = file.split("\n");

  if (
    lines
      .slice(start - 1, end)
      .join("\n")
      .includes(wanted)
  )
    return { holds: true };

  let movedTo: number | undefined;

  for (
    let index = file.indexOf(wanted);
    index >= 0;
    index = file.indexOf(wanted, index + 1)
  ) {
    const line = file.slice(0, index).split("\n").length;

    if (
      movedTo === undefined ||
      Math.abs(line - start) < Math.abs(movedTo - start)
    )
      movedTo = line;
  }

  return movedTo === undefined ? { holds: false } : { holds: false, movedTo };
}

/** Reads one side of a file at the pins, or throws ReviewInputError. */
export type ReadSource = (
  pins: Pins,
  side: "base" | "head",
  file: string,
) => Promise<string>;

/** What is wrong with each of a diagram's code links, in words: one line
 * per link whose evidence is not inside its lines. A link across the diff
 * (base to head) is not checked. */
export async function diagramEvidenceProblems(
  diagram: Pick<DiagramBlock, "code" | "pins">,
  documentPins: Pins | undefined,
  read: ReadSource,
): Promise<string[]> {
  const problems = await Promise.all(
    Object.entries(diagram.code).map(async ([name, entry]) => {
      const source = anchorSelection(entry.source, diagram.pins);

      if (source.start.side !== source.end.side) return [];

      let text: string;

      try {
        text = await read(
          anchorPins(source, documentPins),
          source.start.side,
          source.file,
        );
      } catch (error) {
        if (!(error instanceof ReviewInputError)) throw error;

        return [`- ${name}: ${source.file} cannot be read: ${error.message}`];
      }

      const state = evidenceIn(
        text,
        source.start.line,
        source.end.line,
        entry.evidence,
      );

      if (state.holds) return [];

      return [
        state.movedTo === undefined
          ? `- ${name}: ${JSON.stringify(entry.evidence)} is not in ${source.file}.`
          : `- ${name}: ${JSON.stringify(entry.evidence)} is not in ${entry.source}; it is at line ${state.movedTo}.`,
      ];
    }),
  );

  return problems.flat();
}

/** The diagrams an edit writes code links for: those it inserts or puts in
 * place, and one it updates with new code or pins. */
export function editedDiagrams(edit: Edit, document: Block[]): DiagramBlock[] {
  if ("content" in edit)
    return elements([edit.content]).flatMap((element) =>
      element.type === "diagram" ? [element] : [],
    );

  if (edit.type !== "update") return [];

  const target = elements(document).find(
    (element) => element.id === edit.targetId,
  );

  const { changes } = edit;

  if (
    target?.type !== "diagram" ||
    !isJsonObject(changes) ||
    (!("code" in changes) && !("pins" in changes))
  )
    return [];

  // The store checks the update itself; an invalid one is not ours to read.
  const merged = blocks.diagram.schema.safeParse({ ...target, ...changes });

  return merged.success ? [merged.data] : [];
}
