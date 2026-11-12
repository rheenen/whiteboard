#!/usr/bin/env node
/** Installs this checkout's remote tarball on an SSH host by hand, as Settings' hand-install lines do; see docs/remote-hosts.md. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  REMOTE_TARGETS,
  buildDevRemoteTarball,
} from "./build-remote-tarball.mjs";

const INSTALL_SCRIPT = fileURLToPath(
  new URL("../../../packages/review/remote/install.sh", import.meta.url),
);

const TARGETS = { x86_64: "linux-x64", aarch64: "linux-arm64" };

const sshArgs = (sshConfig) => [
  ...(sshConfig ? ["-F", sshConfig] : []),
  "-o",
  "BatchMode=yes",
];

const ssh = (alias, sshConfig, command) =>
  execFileSync("ssh", [...sshArgs(sshConfig), alias, command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

function hostTarget(alias, { sshConfig } = {}) {
  const machine = ssh(alias, sshConfig, "uname -m");
  const target = TARGETS[machine];

  if (!target)
    throw new Error(
      `${alias} runs ${machine}; Whiteboard needs x86_64 or aarch64.`,
    );

  return target;
}

/** The version directory the script's DONE line names. */
export function installedFrom(said) {
  const done = /^WHITEBOARD-INSTALL DONE (.*)$/m.exec(said);
  const cli = done && JSON.parse(done[1]).cli;

  return cli ? path.posix.dirname(path.posix.dirname(cli)) : undefined;
}

/** Installs this checkout's tarball with install.sh, as Desktop does; `commit` rewrites its VS Code server's commit. */
export async function remoteDevInstall(
  alias,
  { target, sshConfig, version, commit, stdio = "inherit" } = {},
) {
  target ??= hostTarget(alias, { sshConfig });

  const built = await buildDevRemoteTarball({ target, version, stdio });
  const copy = `/tmp/whiteboard-remote-${randomBytes(4).toString("hex")}.tar.xz`;

  try {
    execFileSync(
      "scp",
      [...sshArgs(sshConfig), "-q", built.file, `${alias}:${copy}`],
      { stdio: ["ignore", "inherit", "inherit"] },
    );

    const args = [
      "install",
      "--version",
      built.version,
      "--sha256",
      built.sha256,
      "--file",
      copy,
    ];

    let said;

    try {
      said = execFileSync("ssh", [...sshArgs(sshConfig), alias, "sh", "-s"], {
        encoding: "utf8",
        input: `set -- ${args.map((arg) => `'${arg}'`).join(" ")}\n${await readFile(INSTALL_SCRIPT, "utf8")}`,
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch (error) {
      said = error.stdout ?? "";
    }

    const installed = installedFrom(said);

    if (!installed)
      throw new Error(
        `install.sh did not install on ${alias}:\n${said.trim()}`,
      );

    return ssh(
      alias,
      sshConfig,
      [
        "set -e",
        ...(commit
          ? [
              `sed -i 's/"commit": "[0-9a-f]*"/"commit": "${commit}"/' ${installed}/vscode-server/product.json`,
            ]
          : []),
        `${installed}/whiteboard version --json`,
      ].join("\n"),
    );
  } finally {
    try {
      ssh(alias, sshConfig, `rm -f ${copy}`);
    } catch {}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string" },
      "ssh-config": { type: "string" },
    },
  });

  const [alias] = positionals;
  const sshConfig = values["ssh-config"];

  if (!alias || positionals.length > 1)
    throw new Error(
      "usage: remote-dev-install.mjs <ssh-alias> [--target linux-x64|linux-arm64] [--ssh-config <file>]",
    );

  if (values.target && !REMOTE_TARGETS.includes(values.target))
    throw new Error(`--target must be one of ${REMOTE_TARGETS.join(", ")}`);

  console.log(
    await remoteDevInstall(alias, {
      target: values.target,
      sshConfig,
      stdio: ["ignore", process.stderr, process.stderr],
    }),
  );
}
