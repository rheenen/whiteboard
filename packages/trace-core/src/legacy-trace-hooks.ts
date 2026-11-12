import os from "node:os";

import {
  AGENT_TRACE_HOOK_AGENTS,
  type AgentTraceHookAgent,
  removeAgentTraceHook,
} from "./agent-trace-hooks";
import { disableAllTraceRepositories } from "./trace-repository-hooks";

/** What one cleanup removed: harness hooks, and repositories whose Git hook
 * path it restored. */
export interface LegacyTraceHookRemoval {
  hooks: AgentTraceHookAgent[];
  repositories: string[];
}

/**
 * Removes the agent harness hooks and Git repository hooks that earlier
 * builds installed for trace capture, and restores each known repository's
 * previous core.hooksPath. Idempotent, and writes nothing when no hook is
 * installed. Hooks that run another live installation's executable, other
 * than `ownCommand`, stay.
 */
export async function removeLegacyTraceHooks(
  input: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    ownCommand?: string;
  } = {},
): Promise<LegacyTraceHookRemoval> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const hooks: AgentTraceHookAgent[] = [];

  for (const agent of AGENT_TRACE_HOOK_AGENTS)
    if (await removeAgentTraceHook(agent, homeDir, env, input.ownCommand))
      hooks.push(agent);

  const { disabled } = await disableAllTraceRepositories(
    homeDir,
    input.ownCommand,
  );

  return { hooks, repositories: disabled };
}
