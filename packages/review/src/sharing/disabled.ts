import { readFileSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";

import { findReviewPackageRoot } from "@review/package-paths.js";
import { z } from "zod";

export const SHARING_DISABLED = "Sharing is disabled on this installation";

/** The install policy beside the runtime's `package.json`. Root-owned in a
 * system install, so neither a user nor an agent can undo it, and read on
 * every request, so it holds whatever environment the server started in. */
export const SHARING_POLICY_FILE = "sharing-policy.json";

const enabledPolicy = z.object({ sharing: z.literal("enabled") });

/**
 * Whether this installation turned sharing off: share links, sign-in and
 * opening links. Files still export and import. True when
 * `DEV_REVIEW_SHARING_DISABLED` is `1` or `true`, or when the install policy
 * file says `{"sharing": "disabled"}`. A policy file that cannot be read or
 * parsed, or holds anything but `{"sharing": "enabled"}`, also disables it.
 */
export function isSharingDisabled(
  runtimeRoot: string = findReviewPackageRoot(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.DEV_REVIEW_SHARING_DISABLED?.trim().toLowerCase();

  if (flag === "1" || flag === "true") return true;

  let text: string;

  try {
    text = readFileSync(path.join(runtimeRoot, SHARING_POLICY_FILE), "utf8");
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }

  try {
    return !enabledPolicy.safeParse(JSON.parse(text)).success;
  } catch {
    return true;
  }
}

/** Copies the install policy into `DEV_REVIEW_SHARING_DISABLED`, so code
 * that cannot read the policy file (the hosted trace store client in
 * trace-core) and every child process see the same answer. */
export function applySharingPolicy(env: NodeJS.ProcessEnv = process.env) {
  if (isSharingDisabled(undefined, env)) env.DEV_REVIEW_SHARING_DISABLED = "1";
}

/** The CLI's refusal: exit code 2 with the reason, before any network call;
 * undefined when sharing is on. */
export function refuseDisabledSharing(input: {
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
}): 2 | undefined {
  if (!isSharingDisabled(undefined, input.env)) return undefined;

  if (input.json)
    input.stdout.write(
      JSON.stringify({
        error: { code: "sharing_disabled", message: SHARING_DISABLED },
      }) + "\n",
    );
  input.stderr.write(SHARING_DISABLED + "\n");

  return 2;
}
