# Privacy

Whiteboard reads source code and agent-authored documents on your machine. This
page covers what stays local, what Whiteboard sends, and what you choose to
share. The [dev.fast privacy policy](https://dev.fast/privacy) is the policy
governing Whiteboard.

## This build

This build of Whiteboard sends no telemetry, no error reports and no crash
dumps, and has no setting to turn them on. Sharing is always off: the Share
button, sign-in and the Desktop sharing setting are gone, and the runtime ships
a `sharing-policy.json` that turns sharing off for the server and the CLI.
It has no agent trace capture either. Exporting and opening `.whiteboard` files still work. The
sections below describe what the upstream Whiteboard does.

## What stays local

Whiteboard keeps whiteboards, including copies opened from share links and
your comments on them, in `~/.dev/review-api.db`, repositories it clones for
share links in `~/.dev/shared-repositories/`, and app state in
`~/.dev/review-desktop/`. These names predate the Whiteboard rename.

## Telemetry and error reports

Anonymous telemetry is on by default. It records feature use as categories,
counts, durations and versions, under a random installation ID. It never
includes source code, diffs, paths, repository names, refs, whiteboard text,
prompts, model output, or your email, username or hostname. Signing in with
GitHub links your installations through a one-way hash of your account ID.

Whiteboard also reports its own errors, with paths, addresses and secrets
removed on your machine first. After a crash, the next launch uploads Electron's
crash dump, which can contain process memory, including open source text. It
is kept for 30 days.

To turn both off, open Settings and disable **Share anonymous usage data**, or
set `DO_NOT_TRACK=1`. This build has no such setting and needs neither,
because it never sends them. With telemetry off, crash dumps are deleted without
upload. The [telemetry reference](telemetry.md) lists every event.

## Bug reports

**Report a bug** sends nothing until you select **Send**. You choose whether to
attach the whiteboard (its text, pinned commits, branch and pull request),
the diffs it shows, and a screenshot. Every report also includes your
description and the app version and platform. Reports are kept in private
storage for 90 days, and are sent even with telemetry off.

## Sharing

Sharing is explicit. `whiteboard share` uploads an immutable copy of one saved
whiteboard version to the /dev/fast share service and returns a link. The copy
includes the document text, software maps, the source lines the whiteboard references, the commits it is
pinned to, your GitHub login, and the repository's remote URL without
credentials. Anyone with the link can read the copy in a browser. Opening it in
Whiteboard Desktop makes a copy you can edit and fetches the pinned commits
from the repository's remote with the recipient's own access.

`whiteboard export` writes the same copy to a `.whiteboard` file and uploads
nothing. Whiteboard Desktop opens such a file on a checkout of its repository
that you already have. Without one, it asks whether to clone the repository
into a folder you choose (by default `~/projects`), or to open the file
read-only. A read-only board shows the source lines the file carries, and
keeps them in `~/.dev/review-api.db`; it has no commits, diffs or maps.
`whiteboard share revoke <share-id>` stops future downloads.

### Turning sharing off

An installation can turn sharing off in any of these ways:

- set `DEV_REVIEW_SHARING_DISABLED=1` in the environment of the Whiteboard
  server and CLI;
- put a `sharing-policy.json` file that holds `{"sharing": "disabled"}` next to
  the runtime's `package.json`. In a system install, make it root-owned;
- in Desktop, turn off the `review.sharing.enabled` setting, or set the
  `WhiteboardSharingEnabled` policy to false. This build has no such setting:
  its Desktop always tells the server, the CLI and remote hosts that sharing
  is off.

Off always wins: no source can turn sharing on again while another one turns it
off. A policy file that Whiteboard cannot read or parse also turns sharing off.

The Desktop setting writes a `sharing-disabled` file in `~/.dev/`, so the CLI
and the commands agents run follow it too, also the ones that Desktop did not
start. Turning the setting on again removes the file. Desktop also writes the
file on each remote host it attaches to, when the Whiteboard version there
knows the setting. An older version on a remote host does not, so set
`DEV_REVIEW_SHARING_DISABLED=1` or install the policy file there.

With sharing off, Whiteboard sends nothing to the share service. It does not
sign in, upload or revoke a whiteboard, or open share links. `whiteboard share`,
`whiteboard share revoke`, `whiteboard login` and `whiteboard whoami` exit with
status 2, and Desktop hides the Share button and the sign-in in Settings.
`whiteboard export`, **Export file…**, opening `.whiteboard` files and
`whiteboard logout` still work.

Turning sharing off does not change telemetry, error reports or bug reports.
Each of them has its own switch, described above.

## Agent traces

Whiteboard does not capture agent sessions, upload transcripts or read them
from a trace store. Setup removes the agent and Git hooks that earlier builds
installed for trace capture. Trace settings, S3/R2 credentials and local
trace files that earlier builds wrote stay on disk until you delete them,
for example `~/.dev/trace`, `~/.dev/trace-search` and `~/.config/dev-trace`.
A `.whiteboard` file that still carries traces opens without them.
