# dev.fast Whiteboard

The `@dev.fast/whiteboard` package provides the `whiteboard` CLI for headless review
authoring and sharing. It requires Node 24. An npm install
also provides `review` as an alias for `whiteboard`.
`whiteboard server` runs without installing or starting Desktop.
Whiteboard Desktop displays the review canvas; its server owns review
discovery, session state, and presentation. Legacy reviews
published with the removed MDX toolchain have a durable UUID directory under
`${DEV_REVIEW_HOME:-~/.dev}/reviews/<uuid>/` and are imported into the JSON
store when Home lists them or when they are opened.

## Workspace packages

- `@dev.fast/whiteboard`: Node runtime, CLI, and authoring tools. Its
  production dependencies are the external libraries used by the compiled Node
  code; workspace libraries bundled by tsdown are development dependencies.
- `@dev.fast/review-canvas` ([app](app/README.md)): private browser UI, layout
  libraries, and browser tests. It builds separately and is not included in npm.
- `@dev.fast/review-desktop`: installs the Node runtime and copies the built canvas.

### Imports

Import through `@review/*` (`src`) and `@canvas/*` (`app/src`) instead of
`../` paths; keep `./` for siblings. `pnpm lint` enforces this. tsx reads the
aliases from its working directory's tsconfig, so run it from this package or
set `TSX_TSCONFIG_PATH`. `node scripts/rewrite-relative-imports.mjs` (from the
repository root) converts a branch that predates the aliases.

## Migration

To migrate stored reviews with a compatible `whiteboard` command, run:

```sh
whiteboard migrate apply
```

The command normalizes stored review schema versions, regenerates presented
artifacts, converts Jujutsu repositories and Whiteboard-managed checkouts, and
removes legacy global CLI installs and catalog entries. It reports blockers
for items that need manual correction; fix each one and run the command
again. Use `--force` to restart interrupted state.

## Usage

Start or activate Whiteboard Desktop. You can run this command outside a
repository and without a terminal:

```sh
whiteboard app launch --json
```

Reviews are authored through the JSON API: `whiteboard api` calls a tool
directly, and `whiteboard mcp` serves the same catalog over stdio MCP for a
connected agent.

To select a review, run:

```sh
whiteboard app pick
```

Use `whiteboard app pick --session <uuid>` to select a specific review. Bare
`whiteboard app` is an alias for `whiteboard app launch`.

`whiteboard info` is read-only: it lists active reviews bound to the current
worktree, or every worktree in the repository with `--all`.

Whiteboard Desktop is the primary install path for Claude Code, Codex, Cursor,
Pi, and other coding agents. On startup it detects installed agents, offers to
install the CLI and connect them over MCP, and re-syncs after each app
update. It also writes a `whiteboard` shim to `~/.local/bin` that always resolves
to the app's bundled CLI. A standalone CLI defers to the app's bundled copy
whenever Whiteboard Desktop is running.

Agent setup installs only the Whiteboard CLI and the MCP connection.

This build has no agent trace capture. Setup and uninstall remove the agent
hooks and Git hooks that earlier builds installed for it, and restore each
repository's previous `core.hooksPath`; hooks that run another live
installation's command stay. Until then, `whiteboard trace hook` and
`whiteboard trace git-hook` exit successfully without output, so old hooks
never block an agent session, `git commit` or `git push`. Boards with trace
quotes still open; each quote shows that this build does not support it.

The app-managed command starts the exact macOS bundle that installed it. The
bundle does not need to be under `/Applications`. A repository or standalone
CLI uses the `dev.fast.review` macOS bundle identifier.

If `whiteboard` opens a browser or reports old options, another command shadows
the current CLI. Run `command -v whiteboard`, `whiteboard version`, and
`whiteboard --help`. Remove the legacy PATH entry, or put the app-managed
`~/.local/bin/whiteboard` command first on `PATH`.

To connect an agent by hand, run:

```sh
whiteboard connect <target>
```

for `claude`, `claude-code`, `codex`, `cursor`, `opencode`, `pi`, `omp`, or
`all`. It prints the plugin-install or MCP-registration steps for that agent;
Whiteboard Desktop runs the same steps automatically during agent setup.
