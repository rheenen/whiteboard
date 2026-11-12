// Removes the agent harness hooks that earlier builds wrote for trace
// capture. Trace capture is gone; only the cleanup remains.

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type JsonValue,
  isJsonArray,
  isJsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/json";

import { keepTraceExecutable, shellQuote } from "./trace-command";

export type AgentTraceHookAgent = "claude" | "codex" | "opencode" | "pi";

/** Every harness an earlier build wrote a trace hook for, in report order. */
export const AGENT_TRACE_HOOK_AGENTS: readonly AgentTraceHookAgent[] = [
  "claude",
  "codex",
  "opencode",
  "pi",
];

const EXTENSION_MARKER = "Managed by Review Desktop trace setup";

type TraceHookOwner = "review";

function claudeSettingsPath(homeDir: string): string {
  return path.join(homeDir, ".claude", "settings.json");
}

function codexConfigPath(homeDir: string): string {
  return path.join(homeDir, ".codex", "config.toml");
}

function piExtensionPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "extensions", "review-trace.ts");
}

/** The configuration base OpenCode reads: `$XDG_CONFIG_HOME`, else `~/.config`. */
function configHome(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
}

function openCodeDirectory(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(configHome(homeDir, env), "opencode");
}

function openCodePluginPath(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    openCodeDirectory(homeDir, env),
    "plugins",
    "review-trace.ts",
  );
}

function executableOwner(file: string): TraceHookOwner | null {
  const base = path.basename(file);

  return base === "review" || base === "whiteboard" ? "review" : null;
}

/** The executable of a single lifecycle command, or undefined for a shell compound. */
function traceHookCommandFile(
  command: JsonValue | undefined,
): string | undefined {
  const text = jsonString(command);

  if (text === undefined) return undefined;

  const match =
    /^(.*) trace hook (SessionStart|UserPromptSubmit|SessionEnd)$/.exec(text);

  if (!match) return undefined;
  const prefix = match[1];

  if (/^[a-zA-Z0-9_./-]+$/.test(prefix)) return prefix;
  const decoded = prefix.slice(1, -1).replaceAll(`'"'"'`, "'");

  return shellQuote(decoded) === prefix ? decoded : undefined;
}

/** Identifies a single executable lifecycle command; never accepts shell compounds. */
function traceHookCommandOwner(
  command: JsonValue | undefined,
): TraceHookOwner | null {
  const file = traceHookCommandFile(command);

  return file === undefined ? null : executableOwner(file);
}

function extensionCommandFile(source: string): string | undefined {
  if (!source.trimStart().startsWith(`// ${EXTENSION_MARKER}`))
    return undefined;
  const match = /spawn\(("(?:[^"\\]|\\.)*"), \["trace", "hook"/.exec(source);

  if (!match) return undefined;

  return jsonString(parseJsonText(match[1]));
}

function extensionOwner(source: string): TraceHookOwner | null {
  const file = extensionCommandFile(source);

  return file === undefined ? null : executableOwner(file);
}

/** Removes Review hooks; a scoped removal preserves another live executable. */
export async function removeAgentTraceHook(
  agent: AgentTraceHookAgent,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  expectedCommand?: string,
): Promise<boolean> {
  const removable = (file: string | undefined) =>
    expectedCommand === undefined ||
    !keepTraceExecutable(file, expectedCommand);

  if (agent === "claude") {
    const settingsPath = claudeSettingsPath(homeDir);

    if (!existsSync(settingsPath)) return false;
    let parsed: JsonValue;

    try {
      parsed = parseJsonText(await readFile(settingsPath, "utf8"));
    } catch {
      return false;
    }

    if (!isJsonObject(parsed)) return false;
    const hooks = parsed.hooks;

    if (!isJsonObject(hooks)) return false;
    let changed = false;

    for (const eventName of [
      "SessionStart",
      "UserPromptSubmit",
      "SessionEnd",
    ] as const) {
      const existing = hooks[eventName];
      const groups: JsonValue[] = isJsonArray(existing) ? existing : [];

      const keptGroups = groups.flatMap((group): JsonValue[] => {
        if (!isJsonObject(group)) return [group];

        if (!isJsonArray(group.hooks)) return [group];

        const keptHooks = group.hooks.filter((hook) => {
          const command = isJsonObject(hook) ? hook.command : undefined;

          const owned =
            traceHookCommandOwner(command) === "review" &&
            removable(traceHookCommandFile(command));

          if (owned) changed = true;

          return !owned;
        });

        return keptHooks.length > 0 ? [{ ...group, hooks: keptHooks }] : [];
      });

      if (keptGroups.length > 0) hooks[eventName] = keptGroups;
      else delete hooks[eventName];
    }

    if (!changed) return false;
    parsed.hooks = hooks;
    await writeFile(
      settingsPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );

    return true;
  }

  if (agent === "codex") {
    const configPath = codexConfigPath(homeDir);

    if (!existsSync(configPath)) return false;
    const existing = await readFile(configPath, "utf8");

    const removed = transformCodexHooks(existing, (block, command) =>
      traceHookCommandOwner(command) === "review" &&
      removable(traceHookCommandFile(command))
        ? ""
        : block,
    ).replace(/# review-trace-hooks:start\n\s*# review-trace-hooks:end\n?/, "");

    if (removed === existing) return false;
    const next = removed.replace(/\n{3,}/g, "\n\n");
    await writeFile(
      configPath,
      next.trim() ? `${next.trimEnd()}\n` : "",
      "utf8",
    );

    return true;
  }

  const extensionPath =
    agent === "pi"
      ? piExtensionPath(homeDir)
      : openCodePluginPath(homeDir, env);

  if (!existsSync(extensionPath)) return false;
  const existing = await readFile(extensionPath, "utf8");

  if (
    extensionOwner(existing) !== "review" ||
    !removable(extensionCommandFile(existing))
  ) {
    return false;
  }

  await rm(extensionPath, { force: true });

  return true;
}

// Restrict edits to the lifecycle blocks we generate, never arbitrary TOML keys.
// JSON basic strings are also valid TOML strings; parse the same emitted subset.
function transformCodexHooks(
  content: string,
  transform: (block: string, command: string, event: string) => string,
): string {
  return content.replace(
    /^\[\[hooks\.(SessionStart|UserPromptSubmit|SessionEnd)\]\]\n\[\[hooks\.\1\.hooks\]\]\ntype = "command"\ncommand = ("(?:[^"\\\n]|\\.)*")(?:\n|$)(?:statusMessage = "[^"\n]*"(?:\n|$))?/gm,
    (block: string, event: string, encoded: string, offset: number) => {
      // A generated prefix is not proof of an entire owned group. Extra keys
      // and later child tables still depend on the parent header we remove.
      let reachedOtherTable = false;

      for (const line of content.slice(offset + block.length).split("\n")) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) continue;

        if (!trimmed.startsWith("[")) {
          if (!reachedOtherTable) return block;
          continue;
        }

        const header = /^\[{1,2}([A-Za-z0-9_.-]+)\]{1,2}(?:\s*#.*)?$/.exec(
          trimmed,
        );

        // Unrecognized table syntax is preserved rather than guessed at.
        if (!header) return block;

        if (trimmed === `[[hooks.${event}]]`) break;

        if (
          header[1] === `hooks.${event}` ||
          header[1].startsWith(`hooks.${event}.`)
        )
          return block;
        reachedOtherTable = true;
      }

      try {
        const command = jsonString(parseJsonText(encoded));

        if (!command?.endsWith(` trace hook ${event}`)) return block;

        return transform(block, command, event);
      } catch {
        return block;
      }
    },
  );
}
