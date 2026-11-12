import { expect, it } from "vitest";

import {
  type ShareBundle,
  gitHubRepositoryUrlSchema,
  gitRemoteUrlSchema,
  normalizeGitHubRemote,
  normalizeGitRemote,
  repositoryIdentity,
  repositoryLabel,
  shareBundleSchema,
  sharePathSchema,
} from "./index.js";

it("rejects traversal paths and platform-specific separators", () => {
  for (const file of [
    "../secret",
    "a/../../secret",
    "/etc/passwd",
    "a\\b",
    "a//b",
    "./a",
    "a\0b",
  ])
    expect(sharePathSchema.safeParse(file).success).toBe(false);
  expect(sharePathSchema.parse("src/[route]/index.ts")).toBe(
    "src/[route]/index.ts",
  );
});

const bundle: ShareBundle = {
  format: "review-share/2",
  reviewId: "review",
  version: 1,
  title: "Title",
  snapshot: {},
  images: {},
  traces: {},
  maps: {},
  commits: [],
  selections: {},
  sources: [
    {
      kind: "excerpt",
      file: "src/a.ts",
      commit: "a".repeat(40),
      fromLine: 3,
      lines: ["const a = 1;"],
    },
  ],
  alignments: [{ file: "src/a.ts", head: "a".repeat(40), rows: [[null, 3]] }],
};

it("rejects an older format and an unknown source kind", () => {
  expect(
    shareBundleSchema.safeParse({ ...bundle, format: "review-share/1" })
      .success,
  ).toBe(false);
  expect(
    shareBundleSchema.safeParse({
      ...bundle,
      sources: [{ kind: "file", file: "a", commit: "a".repeat(40) }],
    }).success,
  ).toBe(false);
});

it("drops fields a newer sharer adds instead of rejecting the bundle", () => {
  const parsed = shareBundleSchema.parse({
    ...bundle,
    later: true,
    sources: [{ ...bundle.sources[0], later: true }],
    alignments: [{ ...bundle.alignments![0], later: true }],
  });

  expect(parsed).toEqual(bundle);
});

it("normalizes GitHub transports without publishing credentials", () => {
  for (const remote of [
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo",
    "https://user:secret@github.com/owner/repo.git",
    "https://github.com/owner/repo\n",
  ])
    expect(normalizeGitHubRemote(remote)).toBe(
      "https://github.com/owner/repo.git",
    );

  for (const remote of [
    "https://gitlab.com/owner/repo",
    "/tmp/repo",
    "https://github.com/owner/repo?token=secret",
    "https://github.com/owner/repo#main",
    "https://github.com:1234/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/extra",
  ])
    expect(() => normalizeGitHubRemote(remote)).toThrow(/GitHub|Invalid URL/);

  for (const remote of [
    "git@github.com:owner/repo.git",
    "https://user:secret@github.com/owner/repo.git",
    "https://github.com/owner/repo",
  ])
    expect(gitHubRepositoryUrlSchema.safeParse(remote).success).toBe(false);
});

it("gives every Azure DevOps remote form one https URL, spaces encoded", () => {
  const azure = "https://dev.azure.com/org/Payments%20Hub/_git/iac";

  for (const remote of [
    azure,
    "https://org@dev.azure.com/org/Payments%20Hub/_git/iac",
    "https://user:pat@dev.azure.com/org/Payments%20Hub/_git/iac/",
    "ssh://git@ssh.dev.azure.com/v3/org/Payments%20Hub/iac",
    "git@ssh.dev.azure.com:v3/org/Payments%20Hub/iac",
    "https://org.visualstudio.com/Payments%20Hub/_git/iac",
    "https://org.visualstudio.com/DefaultCollection/Payments%20Hub/_git/iac",
    "org@vs-ssh.visualstudio.com:v3/org/Payments%20Hub/iac",
  ])
    expect(normalizeGitRemote(remote)).toBe(azure);

  expect(normalizeGitRemote("https://dev.azure.com/org/_git/repo")).toBe(
    "https://dev.azure.com/org/repo/_git/repo",
  );

  // An encoded delimiter cannot merge or split the components.
  for (const remote of [
    "https://dev.azure.com/org/a%2Fb/_git/iac",
    "https://dev.azure.com/org/a%5Cb/_git/iac",
    "https://dev.azure.com/org/%2E%2E/_git/iac",
    "https://dev.azure.com/org/a%/_git/iac",
  ])
    expect(() => normalizeGitRemote(remote)).toThrow("https or ssh");
});

it("gives Bitbucket and GitHub remotes their https form", () => {
  for (const remote of [
    "git@bitbucket.org:team/repo.git",
    "ssh://git@bitbucket.org/team/repo.git",
    "https://user@bitbucket.org/team/repo.git",
    "https://bitbucket.org/team/repo",
  ])
    expect(normalizeGitRemote(remote)).toBe(
      "https://bitbucket.org/team/repo.git",
    );
  expect(normalizeGitRemote("git@github.com:owner/repo.git")).toBe(
    "https://github.com/owner/repo.git",
  );
});

it("keeps a generic host's port, path case and ssh user, never a password", () => {
  expect(
    normalizeGitRemote("ssh://git:secret@git.example.com:2222/Team/Repo.git"),
  ).toBe("ssh://git@git.example.com:2222/Team/Repo.git");
  expect(normalizeGitRemote("git@Git.Example.com:Team/Repo.git")).toBe(
    "ssh://git@git.example.com/Team/Repo.git",
  );
  expect(normalizeGitRemote("https://token:x@git.example.com:443/a/b")).toBe(
    "https://git.example.com/a/b",
  );
});

it("refuses remotes a reader must not fetch from", () => {
  for (const remote of [
    "http://git.example.com/a/b",
    "file:///tmp/repo",
    "ext::sh -c touch% /tmp/pwned",
    "git://git.example.com/a/b",
    "/tmp/repo",
    "../repo",
    "https://git.example.com/a/b?x=1",
    "https://git.example.com/a/b#main",
    "https://git.example.com/a b",
    "https://git.example.com/a/b\n",
    "https://git.example.com/a/\u0001b",
    "ssh://-oProxyCommand=x/a/b",
    "git@-oProxyCommand=x:a/b",
    "ssh://-user@host/a/b",
    "https://git.example.com:99999/a/b",
    "https://git.example.com/",
    "https://git.example.com/a//b",
    "https://git.example.com/a/../b",
  ])
    expect(() => normalizeGitRemote(remote)).toThrow("https or ssh");
});

it("validates the remote field and drops it for old readers", () => {
  const remote = { url: "https://dev.azure.com/org/Payments%20Hub/_git/iac" };

  expect(shareBundleSchema.parse({ ...bundle, remote }).remote).toEqual(remote);

  for (const url of [
    "git@ssh.dev.azure.com:v3/org/Payments%20Hub/iac",
    "https://org@dev.azure.com/org/Payments%20Hub/_git/iac",
    "http://git.example.com/a/b",
  ]) {
    expect(gitRemoteUrlSchema.safeParse(url).success).toBe(false);
    expect(
      shareBundleSchema.safeParse({ ...bundle, remote: { url } }).success,
    ).toBe(false);
  }

  expect(
    shareBundleSchema.omit({ remote: true }).parse({ ...bundle, remote }),
  ).not.toHaveProperty("remote");
});

it("names a repository across its remote forms", () => {
  expect(
    repositoryIdentity("git@ssh.dev.azure.com:v3/Org/Payments%20Hub/IAC"),
  ).toBe(
    repositoryIdentity("https://dev.azure.com/org/payments%20hub/_git/iac.git"),
  );
  expect(repositoryIdentity("git@bitbucket.org:Team/Repo.git")).toBe(
    "bitbucket.org/team/repo",
  );
  expect(
    repositoryIdentity("ssh://git@git.example.com:2222/Team/Repo.git"),
  ).toBe("git.example.com:2222/Team/Repo");
  expect(repositoryIdentity("https://git.example.com/Team/Repo")).not.toBe(
    repositoryIdentity("https://git.example.com/team/repo"),
  );
  expect(repositoryIdentity("https://git.example.com:8443/a/b")).not.toBe(
    repositoryIdentity("https://git.example.com/a/b"),
  );
  expect(repositoryIdentity("file:///tmp/repo")).toBeUndefined();
  expect(
    repositoryLabel("https://dev.azure.com/org/Payments%20Hub/_git/iac"),
  ).toBe("org / Payments Hub / iac");
});
