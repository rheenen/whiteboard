# Create a review

Once you [connect an agent](connect-your-agent.md), ask it to review your
changes. Keep Whiteboard open and run your agent in the repository. For example:

```text
Review changes from my current branch against main and open the result in Whiteboard.
```

## Bare clones and worktrees

Whiteboard needs a checkout. If you use a bare clone with worktrees, your agent
can run in the clone's folder. Ask it to review a worktree. For example:

```text
Review worktrees/feature against main and open the result in Whiteboard.
```

## Read the review

The review appears in Whiteboard as your agent writes it. Select a diagram step
or code link to open its source.

![A sequence diagram beside the source code for its selected step](assets/diagram-to-code.webp)

## Comment on the review

Select a passage of the whiteboard or lines of code, then choose **Add
comment**. To comment on a part of a diagram, or on a call in a call tree,
select the node, message or call and choose **Add comment**. In an expanded
diagram, you can also select the pencil beside a step. The comment is on the
code behind that part, or on the diagram when the part has no code.

A comment icon marks each open comment: after its passage, at the corner of
its block or diagram part, and in the gutter beside its code. Select the icon
to read the comments there, and to edit, resolve or delete one. The
**Threads** tab lists every comment above the Ask threads, resolved ones too.

A tool that posts pull request comments can read them without a running
server:

```sh
whiteboard comments --review <id> --json
```

The output is `{"schema": 1, "reviewId", "sessionId", "comments": [...]}`. Each
comment has a Markdown `body`, its `author`, `resolved`, a `hash` that changes
when the body or anchor changes, and an `anchor`. A source anchor names the
repository remote, the `file`, the `side` (`head` or `base`), 1-based
`fromLine` and `toLine`, and the full `commit`; a document anchor names a
`blockId` and a `quote`. A comment on a diagram part also has a `part` with
the diagram's `blockId`, the step's `id` and its `label`. The
`session_comments_list` MCP tool returns the same comments.

## Plan and review a stack

When your agent plans work in Whiteboard, it keeps the plan and its changes
together automatically. For example:

```text
Plan this work in Whiteboard.
```

As the agent implements the plan, it adds a child board for each PR and puts the
children in dependency order. When reviewing an existing stack, ask:

```text
Review this PR stack in Whiteboard.
```

The agent creates an overview with one child per PR, each showing that PR's
changes. You do not need to specify the board structure or links.

Open a stack in the sidebar to see its children. Hover over a row, or move
keyboard focus to it, to reveal its controls. The chevron expands the children;
the title opens the board. The plus button creates and opens an empty child of
a top-level board.
