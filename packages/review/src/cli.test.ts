import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { REVIEW_REMOTE_WRAPPER_MARK } from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { runReviewCli } from "./cli-runner";
import {
  ReviewAppImportError,
  ReviewAppStateError,
  ReviewAppUsageError,
  runReviewAppPick as runReviewAppActual,
  runReviewAppImport as runReviewAppImportActual,
} from "./review-app";
import { runReviewAppLaunch as runReviewAppLaunchActual } from "./review-app-launcher";
import { runReviewInfo as runReviewInfoActual } from "./review-info";

describe("Whiteboard CLI", () => {
  it("routes Cursor install instructions without connecting to Desktop", async () => {
    const { code, stdout, stderr } = await runConnect(
      ["connect", "cursor", "--json"],
      installTestShim,
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(Object.keys(result.prompts)).toEqual(["cursor"]);
    const link = new URL(result.prompts.cursor.match(/cursor:\/\/\S+/)[0]);
    expect(link.hostname).toBe("anysphere.cursor-deeplink");
    expect(
      JSON.parse(
        Buffer.from(link.searchParams.get("config")!, "base64").toString(),
      ),
    ).toEqual({
      command: "sh",
      args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
    });
  });

  it("prints only scanner-owned cleanup paths", async () => {
    let owned = "";
    let plugin = "";
    let unrelated = "";

    const { code, stdout } = await runConnect(
      ["connect", "--json"],
      async (home) => {
        await installTestShim(home);
        owned = path.join(home, ".agents", "skills", "dev-review");
        unrelated = path.join(home, ".agents", "skills", "review");
        plugin = path.join(home, ".config", "opencode", "plugins", "review.ts");
        await mkdir(owned, { recursive: true });
        await mkdir(unrelated, { recursive: true });
        await mkdir(path.dirname(plugin), { recursive: true });
        await writeFile(
          path.join(owned, "SKILL.md"),
          '---\nmetadata:\n  review-managed-by: "Review Desktop"\n  review-generated: "Do not edit."\n  review-version: "development"\n---\n',
        );
        await writeFile(path.join(unrelated, "SKILL.md"), "User-owned skill");
        await writeFile(
          plugin,
          "// Managed by Review Desktop (@dev.fast/review).\n",
        );
      },
    );

    expect(code).toBe(0);

    for (const prompt of Object.values(JSON.parse(stdout).prompts)) {
      expect(prompt).toContain(JSON.stringify(owned));
      expect(prompt).toContain(JSON.stringify(plugin));
      expect(prompt).not.toContain(JSON.stringify(unrelated));
    }
  });

  it("prints every prompt with headings by default", async () => {
    const { code, stdout } = await runConnect(["connect"]);

    expect(code).toBe(0);
    expect(stdout).toContain("## Claude Code");
    expect(stdout).toContain("## Pi");
  });

  it("emits the selected prompts as one JSON event", async () => {
    const { code, stdout } = await runConnect([
      "connect",
      "claude-code",
      "--json",
    ]);

    const event = JSON.parse(stdout);

    expect(code).toBe(0);
    expect(event.event).toBe("connect");
    expect(Object.keys(event.prompts)).toEqual(["claude"]);
  });

  it("counts the launcher Desktop writes on a remote host as the managed command", async () => {
    const { code, stdout } = await runConnect(
      ["connect", "claude", "--json"],
      async (home) => {
        await mkdir(path.join(home, ".local", "bin"), { recursive: true });
        await writeFile(
          path.join(home, ".local", "bin", "whiteboard"),
          `#!/bin/sh\n${REVIEW_REMOTE_WRAPPER_MARK}\nexec '${home}/.dev/whiteboard-remote/versions/0.1.6/whiteboard' "$@"\n`,
        );
      },
    );

    expect(code).toBe(0);
    const prompt = JSON.parse(stdout).prompts.claude;
    expect(prompt).toContain("claude plugin install whiteboard@devfast");
    expect(prompt).not.toContain("install the whiteboard command");
  });

  it("lists the agents found here, as one JSON line", async () => {
    const { code, stdout } = await runConnect(
      ["connect", "--detect", "--json"],
      async (home) => {
        await fakeAgentCli(home, "codex");
        await mkdir(path.join(home, ".omp"));
      },
      { env: agentPath },
    );

    expect(code).toBe(0);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      event: "connect.detect",
      agents: [
        { id: "codex", name: "Codex", connected: false },
        { id: "omp", name: "oh-my-pi", connected: false },
      ],
    });
  });

  it("detects without changing any file", async () => {
    let before = "";
    let after = "";

    const { code, stdout } = await runConnect(
      ["connect", "--detect", "--json"],
      async (home) => {
        await installTestShim(home);
        await mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
        await writeFile(
          path.join(home, ".claude", "plugins", "installed_plugins.json"),
          "{}",
        );
        await fakeAgentCli(home, "claude");
        await fakeAgentCli(home, "pi");
        before = await fileTree(home);
      },
      {
        env: agentPath,
        after: async (home) => void (after = await fileTree(home)),
      },
    );

    expect(code).toBe(0);
    expect(
      JSON.parse(stdout).agents.map((agent: { id: string }) => agent.id),
    ).toEqual(["claude", "pi"]);
    expect(after).toBe(before);
  });

  it("refuses to run commands for an agent it cannot connect alone", async () => {
    const { code, stdout } = await runConnect([
      "connect",
      "--yes",
      "cursor",
      "--json",
    ]);

    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain(
      "claude, codex, opencode, pi, omp, copilot",
    );
  });

  it.each([
    ["trace", "hook", "SessionStart"],
    ["trace", "hook", "Stop", "--unknown"],
    ["trace", "git-hook", "pre-push", "origin", "git@example.com:a/b.git"],
  ])(
    "lets hooks from builds with trace capture succeed silently: %j",
    async (...argv) => {
      let output = "";
      const stdout = outputStream();
      const stderr = outputStream();
      stdout.on("data", (chunk) => (output += String(chunk)));
      stderr.on("data", (chunk) => (output += String(chunk)));

      await expect(runReviewCli({ argv, stdout, stderr })).resolves.toBe(0);
      expect(output).toBe("");
    },
  );

  it("prints the package version", async () => {
    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewCli({
        argv: ["version"],
        cliVersion: "1.2.3",
        stdout,
        stderr: outputStream(),
      }),
    ).resolves.toBe(0);
    expect(output).toBe("1.2.3\n");
  });

  // The JSON authoring verbs are the only remaining surface no other case
  // drives; both print the agent CLI help without contacting the Desktop.
  it.each([["api"], ["mcp", "--help"]])(
    "registers the JSON authoring verb %j",
    async (...argv) => {
      const stdout = outputStream();
      let output = "";
      stdout.on("data", (chunk) => (output += String(chunk)));

      await expect(
        runReviewCli({
          argv,
          stdout,
          stderr: outputStream(),
        }),
      ).resolves.toBe(0);
      expect(output).toContain("whiteboard api tools");
    },
  );

  it.each([
    [["app", "launch"], "launched", undefined, false],
    [["app"], "running", undefined, false],
    [["app", "launch", "--focus"], "running", true, false],
    [["app", "--focus"], "launched", true, false],
    [["app", "launch", "--no-sandbox"], "launched", undefined, true],
    [["app", "--no-sandbox"], "launched", undefined, true],
  ] as const)(
    "supports the app launch command and bare alias: %j",
    async (argv, state, focus, noSandbox) => {
      const runReviewAppLaunch = vi.fn<typeof runReviewAppLaunchActual>(
        async () => ({
          event: "app",
          action: "launch",
          state,
          instanceId: "desktop-1",
        }),
      );

      const stdout = outputStream();
      let output = "";
      stdout.on("data", (chunk) => (output += String(chunk)));

      await expect(
        runReviewCli({
          argv: [...argv, "--json"],
          cwd: "/outside-a-repository",
          stdin: Readable.from([]),
          stdout,
          stderr: outputStream(),
          runtime: { runReviewAppLaunch },
        }),
      ).resolves.toBe(0);
      expect(runReviewAppLaunch).toHaveBeenCalledWith({
        focus,
        noSandbox,
      });
      expect(JSON.parse(output)).toEqual({
        event: "app",
        action: "launch",
        state,
        instanceId: "desktop-1",
      });
    },
  );

  it("passes app import arguments and prints its JSON result", async () => {
    const runReviewAppImport = vi.fn<typeof runReviewAppImportActual>(
      async () => ({
        event: "app",
        action: "import",
        reviewUuid: "board",
        title: "Board",
      }),
    );

    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));
    expect(
      await runReviewCli({
        argv: [
          "app",
          "import",
          "file.whiteboard",
          "--repo",
          "repo",
          "--read-only",
          "--focus",
          "--timeout",
          "12",
          "--json",
        ],
        cwd: "/work",
        stdout,
        stderr: outputStream(),
        runtime: { runReviewAppImport },
      }),
    ).toBe(0);
    expect(runReviewAppImport).toHaveBeenCalledWith({
      cwd: "/work",
      file: "file.whiteboard",
      repo: "repo",
      readOnly: true,
      focus: true,
      timeoutMs: 12000,
    });
    expect(JSON.parse(output)).toEqual({
      event: "app",
      action: "import",
      reviewUuid: "board",
      title: "Board",
    });
  });

  it("emits an import error with its code and board id", async () => {
    const runReviewAppImport = vi.fn<typeof runReviewAppImportActual>(
      async () => {
        throw new ReviewAppImportError(
          "Could not open",
          "imported_not_opened",
          undefined,
          "board",
        );
      },
    );

    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));
    expect(
      await runReviewCli({
        argv: ["app", "import", "file.whiteboard", "--read-only", "--json"],
        stdout,
        stderr: outputStream(),
        runtime: { runReviewAppImport },
      }),
    ).toBe(1);
    expect(JSON.parse(output)).toEqual({
      event: "error",
      error: {
        name: "ReviewAppImportError",
        message: "Could not open",
        code: "imported_not_opened",
        reviewUuid: "board",
      },
    });
  });

  it("includes the remote in a missing checkout error", async () => {
    const runReviewAppImport = vi.fn<typeof runReviewAppImportActual>(
      async () => {
        throw new ReviewAppImportError(
          "Missing checkout",
          "missing_checkout",
          "https://example.test/repo",
        );
      },
    );

    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));
    expect(
      await runReviewCli({
        argv: ["app", "import", "file.whiteboard", "--read-only", "--json"],
        stdout,
        stderr: outputStream(),
        runtime: { runReviewAppImport },
      }),
    ).toBe(1);
    expect(JSON.parse(output)).toEqual({
      event: "error",
      error: {
        name: "ReviewAppImportError",
        message: "Missing checkout",
        code: "missing_checkout",
        remote: "https://example.test/repo",
      },
    });
  });

  it("passes --focus through app pick", async () => {
    const runReviewAppPick = vi.fn<typeof runReviewAppActual>(async () => ({
      event: "app",
      action: "pick",
      reviewUuid: "review-uuid",
      title: "Picked",
    }));

    await expect(
      runReviewCli({
        argv: ["app", "pick", "--session", "review-uuid", "--focus", "--json"],
        cwd: "/outside-a-repository",
        stdin: Readable.from([]),
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewAppPick },
      }),
    ).resolves.toBe(0);
    expect(runReviewAppPick).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid", focus: true }),
    );
  });

  it("supports the app pick subcommand", async () => {
    const argv = ["app", "pick", "--session", "review-uuid"];

    const runReviewAppPick = vi.fn<typeof runReviewAppActual>(async () => ({
      event: "app",
      action: "pick",
      reviewUuid: "review-uuid",
      title: "Review",
    }));

    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewCli({
        argv: [...argv, "--json"],
        stdout,
        stderr: outputStream(),
        runtime: { runReviewAppPick },
      }),
    ).resolves.toBe(0);
    expect(runReviewAppPick).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(JSON.parse(output)).toMatchObject({
      event: "app",
      action: "pick",
      reviewUuid: "review-uuid",
    });
  });

  it("rejects an invalid --view for app pick", async () => {
    await expect(
      runReviewCli({
        argv: ["app", "pick", "--session", "review-uuid", "--view", "files"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it.each([
    ["migrate", "apply"],
    ["migrate", "apply", "--force"],
    ["migrate", "apply", "--json"],
    ["migrate", "apply", "--force", "--json"],
  ])(
    "rejects retired migration without changing old reviews: %j",
    async (...argv) => {
      const record = '{"schemaVersion":4,"title":"Old review"}';

      const result = await runConnect(
        argv,
        async (home) => {
          const directory = path.join(
            home,
            ".dev",
            "reviews",
            "11111111-1111-4111-8111-111111111111",
          );

          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "review.json"), record);
        },
        {
          after: async (home) => {
            const directory = path.join(
              home,
              ".dev",
              "reviews",
              "11111111-1111-4111-8111-111111111111",
            );

            expect(
              await readFile(path.join(directory, "review.json"), "utf8"),
            ).toBe(record);
            expect(await readdir(directory)).toEqual(["review.json"]);
          },
        },
      );

      const guidance =
        "Markdown review migration is no longer supported. Ask your agent to migrate your old Whiteboard reviews.";

      const failure = argv.includes("--json")
        ? JSON.parse(result.stdout).error.message
        : result.stderr;

      expect(result.code).toBe(1);
      expect(failure).toContain(guidance);
    },
  );
});

function outputStream(): PassThrough {
  return new PassThrough();
}

async function fileTree(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  const lines = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(entry.parentPath, entry.name);
      const info = await stat(file);

      return `${path.relative(root, file)} ${info.size} ${info.mode} ${info.mtimeMs}`;
    }),
  );

  const top = await stat(root);

  return [`. ${top.mtimeMs}`, ...lines.sort()].join("\n");
}

async function installTestShim(home: string): Promise<void> {
  const bin = path.join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "whiteboard"), "# Managed by Whiteboard\n");
}

const agentPath = (home: string) => ({ PATH: path.join(home, "agent-bin") });

async function fakeAgentCli(home: string, name: string) {
  const file = path.join(home, "agent-bin", name);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o755);
}

async function runConnect(
  argv: string[],
  setup?: (homeDir: string) => Promise<void>,
  extra?: {
    env?: (homeDir: string) => NodeJS.ProcessEnv;
    after?: (homeDir: string) => Promise<void>;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "review-connect-"));

  const stdout = outputStream();
  const stderr = outputStream();

  let stdoutText = "";
  let stderrText = "";

  stdout.on("data", (chunk) => (stdoutText += String(chunk)));
  stderr.on("data", (chunk) => (stderrText += String(chunk)));

  try {
    await setup?.(homeDir);

    const code = await runReviewCli({
      argv,
      cwd: homeDir,
      env: {
        HOME: homeDir,
        DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
        ...extra?.env?.(homeDir),
      },
      stdout,
      stderr,
    });

    await extra?.after?.(homeDir);

    return { code, stdout: stdoutText, stderr: stderrText };
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}
