import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { connectReviewApi } from "@review/review-api/agent-client.js";
import { z } from "zod";

const exportSchema = z.strictObject({
  filename: z.string().min(1),
  text: z.string(),
});

export async function runExportCli(input: {
  review?: string;
  version?: string;
  out?: string;
  json?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}) {
  try {
    if (!input.review) throw new Error("Use whiteboard export --review <id>.");

    const client = await connectReviewApi(input.env);

    const result = exportSchema.parse(
      await client.post("/sharing/export", {
        reviewId: input.review,
        version:
          input.version === undefined
            ? undefined
            : z.number().int().nonnegative().parse(Number(input.version)),
      }),
    );

    if (input.out === "-") {
      input.stdout.write(result.text);

      return 0;
    }

    const file = path.resolve(input.cwd, input.out ?? result.filename);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, result.text);
    input.stdout.write(
      input.json ? JSON.stringify({ path: file }) + "\n" : file + "\n",
    );

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed.";

    if (input.json)
      input.stdout.write(
        JSON.stringify({ error: { code: "export_failed", message } }) + "\n",
      );
    input.stderr.write(message + "\n");

    return 1;
  }
}
