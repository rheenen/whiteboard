import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ReviewInputError,
  componentReference,
  writableBlockTypes,
} from "@dev.fast/whiteboard-document";
import { findReviewPackageRoot } from "@review/package-paths.js";
import { z } from "zod";

export const INSTRUCTION_TOPICS = [
  "authoring",
  "animation",
  "file-lenses",
] as const;

export type InstructionTopic = (typeof INSTRUCTION_TOPICS)[number];

export const instructionsQuerySchema = z.strictObject({
  topic: z.enum(INSTRUCTION_TOPICS).default("authoring"),
});

export interface InstructionContext {
  animationsEnabled?: boolean;
}

/** Keep disabled experimental components out of agent guidance. */
export const desktopBlockTypes = (animationsEnabled: boolean) =>
  writableBlockTypes.filter(
    (type) => animationsEnabled || (type !== "animation" && type !== "clip"),
  );

const COMPONENT_EXAMPLE =
  'Example (replace its path and lines with verified ones): {"type":"sequence","title":"Request","actors":{"a":"Client","b":"Server"},"steps":[{"from":"a","to":"b","label":"Send","source":"head/src/app.ts#L10-L20"}]}';

const cache = new Map<string, Promise<string>>();

function read(root: string, name: string): Promise<string> {
  const file = path.join(root, "instructions", `${name}.md`);
  let content = cache.get(file);

  if (!content) {
    content = readFile(file, "utf8").catch((error) => {
      cache.delete(file);
      throw error;
    });
    cache.set(file, content);
  }

  return content;
}

export async function renderInstructions(
  topic: InstructionTopic,
  context: InstructionContext,
  root = findReviewPackageRoot(import.meta.url),
): Promise<string> {
  if (topic === "animation" && !context.animationsEnabled)
    throw new ReviewInputError(
      "Animation authoring is disabled. Enable Animations in Settings under Experimental Features.",
      409,
    );

  if (topic !== "authoring") return read(root, topic);

  return [
    await read(root, "authoring"),
    [
      componentReference(desktopBlockTypes(context.animationsEnabled === true)),
      "",
      COMPONENT_EXAMPLE,
    ].join("\n"),
  ].join("\n\n");
}
