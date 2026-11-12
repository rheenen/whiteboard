/**
 * Earlier builds installed agent harness hooks that run
 * `whiteboard trace hook <event>` and Git hooks that run
 * `whiteboard trace git-hook <hook>`. Trace capture is gone, but a hook left
 * behind must never fail an agent event or a commit: these invocations read
 * nothing, print nothing and exit 0. Installs remove the hooks themselves.
 *
 * Imports nothing, so the bootstrap can check it before anything else runs.
 */
export function isRetiredTraceHook(argv: readonly string[]): boolean {
  return argv[0] === "trace" && (argv[1] === "hook" || argv[1] === "git-hook");
}
