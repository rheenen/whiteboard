import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Quotes one value for a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Only stable absolute commands can retain ownership across installations. */
function isLiveTraceExecutable(file: string | undefined): boolean {
  if (!file || !path.isAbsolute(file)) return false;

  try {
    accessSync(file, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/** A hook that runs another live installation's executable is not ours to
 * remove; a missing or bare executable is. */
export function keepTraceExecutable(
  existing: string | undefined,
  wanted: string,
): boolean {
  return existing !== wanted && isLiveTraceExecutable(existing);
}

/** The first shell word from an earlier build's rendered Git hook command. */
export function traceCommandExecutable(
  command: string | undefined,
): string | undefined {
  if (!command) return undefined;
  const quoted = /^'((?:[^']|'"'"')*)'(?:\s|$)/.exec(command);
  const bare = /^([^\s']+)(?:\s|$)/.exec(command);

  return quoted ? quoted[1]!.replaceAll(`'"'"'`, "'") : bare?.[1];
}
