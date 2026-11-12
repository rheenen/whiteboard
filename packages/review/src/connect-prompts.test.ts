import { describe, expect, it } from "vitest";

import {
  REVIEW_MCP_LAUNCH,
  WINDOWS_MCP_LAUNCH,
  connectPrompt,
  launchCommand,
  reviewMcpLaunch,
} from "./connect-prompts";
import { ALL_INSTALL_TARGETS } from "./install";

const input = {
  hasShim: true,
  legacyPaths: [],
};

describe("reviewMcpLaunch", () => {
  it("is the shared sh form with a shim and a bare whiteboard without one", () => {
    expect(reviewMcpLaunch(true)).toEqual(REVIEW_MCP_LAUNCH);
    expect(reviewMcpLaunch(false)).toEqual({
      command: "whiteboard",
      args: ["mcp"],
    });
  });

  it("launches through cmd on Windows, which has no sh", () => {
    for (const hasShim of [true, false])
      expect(reviewMcpLaunch(hasShim, "win32")).toEqual(WINDOWS_MCP_LAUNCH);
  });
});

describe("connectPrompt", () => {
  it("registers the Claude plugin's MCP server directly on Windows instead of the plugin", () => {
    for (const [target, add] of [
      [
        "claude",
        "claude mcp add -s user whiteboard -- cmd /d /c whiteboard mcp",
      ],
      ["copilot", "copilot mcp add whiteboard -- cmd /d /c whiteboard mcp"],
    ] as const) {
      const prompt = connectPrompt(target, { ...input, platform: "win32" });

      expect(prompt).toContain(add);
      expect(prompt).not.toContain(`${target} plugin install`);
      expect(connectPrompt(target, { ...input, platform: "darwin" })).toContain(
        `${target} plugin install whiteboard@devfast`,
      );
    }
  });

  it("registers the shared MCP launch in Pi, oh-my-pi and OpenCode", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const launch = reviewMcpLaunch(true, platform);

      expect(connectPrompt("opencode", { ...input, platform })).toContain(
        `opencode mcp add --global whiteboard -- ${launchCommand(launch)}\n`,
      );

      expect(connectPrompt("pi", { ...input, platform })).toContain(
        `pi mcp add whiteboard -- ${launchCommand(launch)}\n`,
      );
      expect(connectPrompt("omp", { ...input, platform })).toContain(
        JSON.stringify({ whiteboard: launch }, null, 2),
      );
    }
  });

  it("quotes the sh launch so Pi stores it unchanged", () => {
    expect(launchCommand(reviewMcpLaunch(true, "darwin"))).toBe(
      `sh -c 'exec "$HOME/.local/bin/whiteboard" mcp'`,
    );
  });
});
