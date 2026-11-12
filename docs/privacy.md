# Privacy

Whiteboard reads source code and agent-authored documents on your machine. This
page covers what stays local and what Whiteboard sends over the network.

## This build sends nothing to dev.fast

This build of Whiteboard has no connection to dev.fast or any other service of
the upstream vendor. It has:

- no sign-in: no `whiteboard login`, `logout` or `whoami`, and no account in
  Settings;
- no share service: whiteboards are never uploaded, and share links are not
  created, opened or revoked;
- no **Report a bug** and no crash dump uploads;
- no feedback form;
- no usage data or error reports, and no setting for them;
- no update feed: the app never checks for or downloads updates;
- no remote host downloads from dev.fast: Desktop installs Whiteboard on an SSH
  host only from a release base you host yourself (see
  [Remote hosts](remote-hosts.md)).

Settings that earlier builds stored for these features are ignored.

## What stays local

Whiteboard keeps whiteboards and your comments on them in
`~/.dev/review-api.db`, repositories it clones for `.whiteboard` files where you
choose, and app state in `~/.dev/review-desktop/`. These names predate the
Whiteboard rename.

## .whiteboard files

`whiteboard export` and **Export file…** write a whiteboard to a `.whiteboard`
file and upload nothing. The file holds the document text, software maps, the
source lines the whiteboard references, the commits it is pinned to, and the
repository's remote URL without credentials. Anyone you give the file to can
read all of that.

Whiteboard Desktop opens such a file on a checkout of its repository that you
already have. Without one, it asks whether to clone the repository into a
folder you choose (by default `~/projects`), or to open the file read-only.
Cloning fetches from the repository's remote with your own Git access. A
read-only board shows the source lines the file carries, and keeps them in
`~/.dev/review-api.db`; it has no commits, diffs or maps.

## What Whiteboard does send

Whiteboard reaches the network only for work you ask of it:

- Git fetches and clones from your repositories' own remotes;
- pull request data from GitHub, GitHub Enterprise or Azure DevOps, with your
  own credentials;
- language extensions and servers, with pinned checksums, from Open VSX and
  their publishers;
- the project's release notes from GitHub.

## Agent traces

Whiteboard does not capture agent sessions, upload transcripts or read them
from a trace store. Setup removes the agent and Git hooks that earlier builds
installed for trace capture. Trace settings, S3/R2 credentials and local
trace files that earlier builds wrote stay on disk until you delete them,
for example `~/.dev/trace`, `~/.dev/trace-search` and `~/.config/dev-trace`.
A `.whiteboard` file that still carries traces opens without them.

## Files earlier builds left

Files that earlier builds wrote for sign-in, sharing or telemetry stay on disk
until you delete them, for example `~/.dev/auth.json`, `~/.dev/sharing-disabled`
and the telemetry state in `~/.dev/`. This build does not read them.
