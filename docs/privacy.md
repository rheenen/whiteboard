# Privacy

Whiteboard reads source code and agent-authored documents on your machine. This
page covers what stays local, what Whiteboard sends, and what you choose to
share. The [dev.fast privacy policy](https://dev.fast/privacy) is the policy
governing Whiteboard.

## This build

This build of Whiteboard sends no telemetry, no error reports and no crash
dumps, and has no setting to turn them on. Sharing is always off: the Share
button, sign-in and the Desktop sharing setting are gone, and the runtime ships
a `sharing-policy.json` that turns sharing off for the server, the CLI and the
agent trace hooks. Exporting and opening `.whiteboard` files still work. The
sections below describe what the upstream Whiteboard does.

## What stays local

Whiteboard keeps whiteboards, including copies opened from share links, in
`~/.dev/review-api.db`, repositories it clones for share links in
`~/.dev/shared-repositories/`, and app state in `~/.dev/review-desktop/`. These
names predate the Whiteboard rename.

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
includes the document text, software maps, complete trace
conversations, the source lines the whiteboard references, the commits it is
pinned to, your GitHub login, and the repository's remote URL without
credentials. Anyone with the link can read the copy in a browser. Opening it in
Whiteboard Desktop makes a copy you can edit and fetches the pinned commits
from the repository's remote with the recipient's own access.

`whiteboard export` writes the same copy to a `.whiteboard` file and uploads
nothing. Whiteboard Desktop opens such a file on a checkout of its repository
that you already have, and never clones one for it.
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
and the agent trace hooks follow it too, also the ones that Desktop did not
start. Turning the setting on again removes the file. Desktop also writes the
file on each remote host it attaches to, when the Whiteboard version there
knows the setting. An older version on a remote host does not, so set
`DEV_REVIEW_SHARING_DISABLED=1` or install the policy file there.

With sharing off, Whiteboard sends nothing to the share service or the hosted
trace store. It does not sign in, upload or revoke a whiteboard, open share
links, or capture traces to the hosted store. `whiteboard share`,
`whiteboard share revoke`, `whiteboard login` and `whiteboard whoami` exit with
status 2, and Desktop hides the Share button and the sign-in in Settings.
`whiteboard export`, **Export file…**, opening `.whiteboard` files and
`whiteboard logout` still work.

Turning sharing off does not change telemetry, error reports or bug reports.
Each of them has its own switch, described above.

## Hosted trace store

Trace capture is off by default and needs your consent for each repository.
Once you allow a repository (`whiteboard trace allow`) with the hosted store
selected, Whiteboard uploads complete agent session transcripts for that
repository to the /dev/fast hosted store. Transcripts can contain prompts,
model output, source code, file paths, URLs and email addresses. Each upload
also records the branch and the Git author name.

Only GitHub users with push access to the repository can find or read its
traces. Read-only collaborators, former contributors and the public cannot,
even for a public repository. Traces are encrypted with keys /dev/fast
controls, so /dev/fast can decrypt them. The GitHub app requests the `repo`
scope to check access.

- `whiteboard trace deny` stops uploads from this machine and keeps earlier
  ones.
- `whiteboard trace store delete` deletes the repository's hosted traces
  (repository admins only). Deletion is not instant: issued download links and
  stored copies expire on a set schedule.
- `whiteboard logout` forgets the local login only.

A store in your own S3 or R2 bucket sends nothing to /dev/fast.
