// Restores the Git hook path of every repository an earlier build pointed
// at its trace hooks. Trace capture is gone; only the cleanup remains.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { jsonArray, jsonString, parseJsonText } from "@dev.fast/json";
import { gitAt } from "@dev.fast/local-vcs";
import { z } from "zod";

import { writeFileAtomicAsync } from "./atomic-write";
import { keepTraceExecutable, traceCommandExecutable } from "./trace-command";

const repositoryHookStateSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  managedHooksPath: z.string(),
  previousHooksPath: z.string(),
  previousHookDirectory: z.string(),
  previousWasConfigured: z.boolean(),
  command: z.string().optional(),
});

type RepositoryHookState = z.infer<typeof repositoryHookStateSchema>;

interface TraceRepositoryStatus {
  repository: boolean;
  enabled: boolean;
  root?: string;
  managedHooksPath?: string;
  previousHooksPath?: string;
  /** The rendered hook command, when hooks are installed. */
  command?: string;
  message: string;
}

async function disableTraceRepository(input: {
  cwd: string;
  homeDir: string;
}): Promise<TraceRepositoryStatus> {
  const resolved = await resolveRepository(input.cwd);

  if (!resolved) {
    return {
      repository: false,
      enabled: false,
      message: "Not inside a Git repository.",
    };
  }

  const stateDir = path.join(resolved.commonDir, "dev-fast", "trace-hooks");
  const state = await readState(path.join(stateDir, "state.json"));

  if (!state) {
    return {
      repository: true,
      enabled: false,
      root: resolved.root,
      message: "Review trace hooks are not enabled for this repository.",
    };
  }

  const current = await configuredHooksPath(resolved.root);

  if (
    path.resolve(resolved.root, current.value || ".") ===
    path.resolve(state.managedHooksPath)
  ) {
    if (state.previousWasConfigured) {
      await gitAt(resolved.root, [
        "config",
        "--local",
        "core.hooksPath",
        state.previousHooksPath,
      ]);
    } else {
      await gitAt(
        resolved.root,
        ["config", "--local", "--unset", "core.hooksPath"],
        { allowFailure: true },
      );
    }
  }

  await rm(stateDir, { recursive: true, force: true });
  await unregisterRepository(input.homeDir, resolved.root);

  return {
    repository: true,
    enabled: false,
    root: resolved.root,
    message: "Review trace hooks are disabled for this repository.",
  };
}

async function traceRepositoryStatus(
  cwd: string,
): Promise<TraceRepositoryStatus> {
  const resolved = await resolveRepository(cwd);

  if (!resolved)
    return {
      repository: false,
      enabled: false,
      message: "Not inside a Git repository.",
    };

  const state = await readState(
    path.join(resolved.commonDir, "dev-fast", "trace-hooks", "state.json"),
  );

  const current = await configuredHooksPath(resolved.root);

  const enabled = Boolean(
    state &&
    path.resolve(resolved.root, current.value || ".") ===
      path.resolve(state.managedHooksPath),
  );

  const status: TraceRepositoryStatus = {
    repository: true,
    enabled,
    root: resolved.root,
    message: enabled
      ? "Review trace hooks are enabled for this repository."
      : "Review trace hooks are not enabled for this repository.",
  };

  if (state) {
    status.managedHooksPath = state.managedHooksPath;
    status.previousHooksPath = state.previousHooksPath;

    if (state.command !== undefined) status.command = state.command;
  }

  return status;
}

/** Disables registered hooks, preserving other live executables when scoped. */
export async function disableAllTraceRepositories(
  homeDir: string,
  expectedCommand?: string,
): Promise<{ disabled: string[]; kept: string[] }> {
  const registry = await readRegistry(homeDir);
  const disabled: string[] = [];
  const kept: string[] = [];

  for (const root of registry) {
    if (expectedCommand !== undefined) {
      const status = await traceRepositoryStatus(root).catch(() => null);

      if (
        keepTraceExecutable(
          traceCommandExecutable(status?.command),
          expectedCommand,
        )
      ) {
        kept.push(root);
        continue;
      }
    }

    const result = await disableTraceRepository({ cwd: root, homeDir }).catch(
      () => null,
    );

    if (result?.repository) disabled.push(root);
  }

  return { disabled, kept };
}

async function resolveRepository(
  cwd: string,
): Promise<{ root: string; commonDir: string } | null> {
  const rootResult = await gitAt(cwd, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });

  const commonResult = await gitAt(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowFailure: true },
  );

  if (!rootResult.ok || !commonResult.ok) return null;

  return {
    root: rootResult.stdout.trim(),
    commonDir: commonResult.stdout.trim(),
  };
}

async function configuredHooksPath(
  root: string,
): Promise<{ configured: boolean; value: string }> {
  const result = await gitAt(
    root,
    ["config", "--local", "--get", "core.hooksPath"],
    { allowFailure: true },
  );

  return {
    configured: result.ok && Boolean(result.stdout.trim()),
    value: result.stdout.trim(),
  };
}

async function readState(
  filePath: string,
): Promise<RepositoryHookState | null> {
  try {
    const parsed = repositoryHookStateSchema.safeParse(
      parseJsonText(await readFile(filePath, "utf8")),
    );

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writePrivateJson(
  filePath: string,
  value: string[],
): Promise<void> {
  await writeFileAtomicAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function registryPath(homeDir: string): string {
  return path.join(homeDir, ".config", "dev-trace", "repositories.json");
}

async function readRegistry(homeDir: string): Promise<string[]> {
  try {
    const value = parseJsonText(await readFile(registryPath(homeDir), "utf8"));

    return (jsonArray(value) ?? [])
      .map(jsonString)
      .filter((item) => item !== undefined);
  } catch {
    return [];
  }
}

async function unregisterRepository(
  homeDir: string,
  root: string,
): Promise<void> {
  await writePrivateJson(
    registryPath(homeDir),
    (await readRegistry(homeDir)).filter((entry) => entry !== root),
  );
}
