import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { removeLegacyTraceHooks } from "./legacy-trace-hooks";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

async function temporaryHome(): Promise<string> {
  const home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "legacy-trace-hooks-")),
  );

  roots.push(home);

  return home;
}

async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Points a repository at trace hooks the way earlier builds did. */
async function installGitHooks(
  home: string,
  repo: string,
  previousHooksPath?: string,
): Promise<void> {
  execFileSync("git", ["init", "-q", repo]);

  if (previousHooksPath)
    git(repo, "config", "core.hooksPath", previousHooksPath);
  const commonDir = path.join(repo, ".git");
  const stateDir = path.join(commonDir, "dev-fast", "trace-hooks");
  const hooks = path.join(stateDir, "hooks");

  await writeText(
    path.join(hooks, "pre-push"),
    "#!/bin/sh\n'whiteboard' trace git-hook pre-push \"$@\" || true\n",
  );
  await writeText(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      root: repo,
      managedHooksPath: hooks,
      previousHooksPath: previousHooksPath ?? path.join(commonDir, "hooks"),
      previousHookDirectory: previousHooksPath ?? path.join(commonDir, "hooks"),
      previousWasConfigured: previousHooksPath !== undefined,
      command: "'whiteboard'",
    }),
  );
  git(repo, "config", "core.hooksPath", hooks);

  const registry = path.join(home, ".config", "dev-trace", "repositories.json");

  const known: string[] = existsSync(registry)
    ? JSON.parse(await readFile(registry, "utf8"))
    : [];

  await writeText(registry, JSON.stringify([...known, repo]));
}

function extensionSource(command: string): string {
  return `// Managed by Review Desktop trace setup
import { spawn } from "node:child_process";

export function runTraceHook(eventName: string) {
  const proc = spawn(${JSON.stringify(command)}, ["trace", "hook", eventName], {});
  proc.on("error", () => {});
}
`;
}

function codexBlock(command: string): string {
  return EVENTS.map(
    (event) =>
      `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(`${command} trace hook ${event}`)}`,
  ).join("\n\n");
}

it("removes earlier builds' harness and Git hooks and restores hook paths", async () => {
  const home = await temporaryHome();
  const claudeSettings = path.join(home, ".claude", "settings.json");
  const codexConfig = path.join(home, ".codex", "config.toml");

  const piExtension = path.join(
    home,
    ".pi",
    "agent",
    "extensions",
    "review-trace.ts",
  );

  const openCodePlugin = path.join(
    home,
    ".config",
    "opencode",
    "plugins",
    "review-trace.ts",
  );

  await writeText(
    claudeSettings,
    JSON.stringify({
      model: "opus",
      hooks: {
        ...Object.fromEntries(
          EVENTS.map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: "command",
                    command: `whiteboard trace hook ${event}`,
                  },
                ],
              },
            ],
          ]),
        ),
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
    }),
  );
  await writeText(
    codexConfig,
    `model = "o3"\n\n# review-trace-hooks:start\n${codexBlock("whiteboard")}\n# review-trace-hooks:end\n`,
  );
  await writeText(piExtension, extensionSource("whiteboard"));
  await writeText(openCodePlugin, extensionSource("whiteboard"));

  const custom = path.join(home, "custom");
  const plain = path.join(home, "plain");
  await installGitHooks(home, custom, "custom-hooks");
  await installGitHooks(home, plain);

  expect(await removeLegacyTraceHooks({ homeDir: home, env: {} })).toEqual({
    hooks: ["claude", "codex", "opencode", "pi"],
    repositories: [custom, plain],
  });

  expect(JSON.parse(await readFile(claudeSettings, "utf8"))).toEqual({
    model: "opus",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
  });
  expect(await readFile(codexConfig, "utf8")).toBe('model = "o3"\n');
  expect(existsSync(piExtension)).toBe(false);
  expect(existsSync(openCodePlugin)).toBe(false);
  expect(git(custom, "config", "--local", "core.hooksPath")).toBe(
    "custom-hooks",
  );
  expect(() =>
    execFileSync("git", ["-C", plain, "config", "--local", "core.hooksPath"], {
      stdio: "ignore",
    }),
  ).toThrow("Command failed");
  expect(existsSync(path.join(plain, ".git", "dev-fast", "trace-hooks"))).toBe(
    false,
  );

  const settingsAfter = await readFile(claudeSettings, "utf8");

  expect(await removeLegacyTraceHooks({ homeDir: home, env: {} })).toEqual({
    hooks: [],
    repositories: [],
  });
  expect(await readFile(claudeSettings, "utf8")).toBe(settingsAfter);
});

it("writes nothing on a machine without hooks, and keeps another live installation's", async () => {
  const empty = await temporaryHome();

  expect(await removeLegacyTraceHooks({ homeDir: empty, env: {} })).toEqual({
    hooks: [],
    repositories: [],
  });
  expect(execFileSync("ls", ["-A", empty], { encoding: "utf8" })).toBe("");

  const home = await temporaryHome();
  const other = path.join(home, "other", "whiteboard");
  await writeText(other, "#!/bin/sh\n");
  await chmod(other, 0o755);

  const piExtension = path.join(
    home,
    ".pi",
    "agent",
    "extensions",
    "review-trace.ts",
  );

  await writeText(piExtension, extensionSource(other));

  expect(
    await removeLegacyTraceHooks({
      homeDir: home,
      env: {},
      ownCommand: path.join(home, ".local", "bin", "whiteboard"),
    }),
  ).toEqual({ hooks: [], repositories: [] });
  expect(existsSync(piExtension)).toBe(true);
});
