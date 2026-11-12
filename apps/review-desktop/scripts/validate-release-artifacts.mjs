// Gate between a packaged, notarized build and the upload: verify the
// artifacts really are the release we think they are. This build has no
// update feed, so the packaged product.json must carry no updateUrl. Run from
// the release workflow after app:package:macos.
// Curated extension checks also read code-oss/package.json from this checkout.
//
//   node scripts/validate-release-artifacts.mjs \
//     --version 1.2.3 --commit <tag sha> [--channel stable|preview]
//     [--artifact-dir dist]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { parseGroupSelection } from "./curated-extensions.manifest.mjs";
import {
  selectExtensions,
  verifyCuratedExtensions,
} from "./curated-extensions.mjs";
import {
  assertReleaseChannel,
  darwinTarget,
  releaseIdentityFor,
  updateBundlesFor,
  updateZipName,
} from "./release-channel.mjs";
import {
  RUNTIME_DIRECTORY_NAME,
  assertPackagedArtifacts,
} from "./stage-review-runtime.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "..");

export { assertReleaseChannel };

// Squirrel renames an install to the update's CFBundleExecutable, so a zip
// served to <bundle>.app installs must carry exactly that bundle with an
// executable of the same name; anything else renames the install.
export function assertZipBundle(zip, bundle) {
  const folder = `${bundle}.app`;

  const roots = new Set(
    execFileSync(
      "sh",
      ["-c", 'unzip -Z1 "$1" | cut -d/ -f1 | sort -u', "sh", zip],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean),
  );

  if (roots.size !== 1 || !roots.has(folder)) {
    throw new Error(
      `${zip} must contain only ${folder}/, found ${[...roots].join(", ") || "nothing"}`,
    );
  }

  const executable = execFileSync(
    "sh",
    [
      "-c",
      'unzip -p "$1" "$2/Contents/Info.plist" | plutil -extract CFBundleExecutable raw -o - -',
      "sh",
      zip,
      folder,
    ],
    { encoding: "utf8" },
  ).trim();

  if (executable !== bundle) {
    throw new Error(
      `${zip}: ${folder} runs ${JSON.stringify(executable)}, so Squirrel would rename installs to ${executable}.app; expected ${bundle}`,
    );
  }
}

export function assertPackagedProduct(product, { commit, channel = "stable" }) {
  assertReleaseChannel(channel);

  const expectations = {
    commit,
    quality: channel,
    ...releaseIdentityFor(channel),
  };

  for (const [key, expected] of Object.entries(expectations)) {
    if (product[key] !== expected) {
      throw new Error(
        `packaged product.json ${key} is ${JSON.stringify(product[key])}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  // An update feed would make the app call a download service on its own.
  if (product.updateUrl !== undefined) {
    throw new Error(
      `packaged product.json has updateUrl ${JSON.stringify(product.updateUrl)}; this build has no update feed`,
    );
  }
}

export function assertUpdaterCompatibleApp(app) {
  const unwritable = [];

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      if ((lstatSync(absolute).mode & 0o200) === 0) {
        unwritable.push(path.relative(app, absolute));
      }
    }
  };

  walk(app);

  if (unwritable.length > 0) {
    const shown = unwritable.slice(0, 20).join("\n  ");
    const remaining = unwritable.length - Math.min(unwritable.length, 20);
    throw new Error(
      `packaged app contains files that the macOS updater cannot modify:\n  ${shown}${remaining > 0 ? `\n  ... and ${remaining} more` : ""}`,
    );
  }
}

const MACHO_ARCH = { arm64: "arm64", x64: "x86_64" };

// Codesign accepts a binary of either arch; only running it on the wrong Mac fails.
export function assertMachOArch(file, arch) {
  const expected = MACHO_ARCH[arch];

  const archs = execFileSync("lipo", ["-archs", file], { encoding: "utf8" })
    .trim()
    .split(/\s+/);

  if (!archs.includes(expected)) {
    throw new Error(`${file} is ${archs.join(" ")}, expected ${expected}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      channel: { type: "string", default: "stable" },
      "artifact-dir": { type: "string" },
    },
  });

  const { version, commit, channel } = values;

  if (!version || !commit) {
    console.error(
      "usage: validate-release-artifacts.mjs --version <semver> --commit <sha> [--channel stable|preview] [--artifact-dir <dir>]",
    );
    process.exit(2);
  }

  assertReleaseChannel(channel);

  const artifactDir = path.resolve(
    values["artifact-dir"] ?? path.join(APP_DIR, "dist"),
  );

  const target = darwinTarget();
  const arch = target.slice("darwin-".length);

  const sourceProduct = JSON.parse(
    readFileSync(path.join(APP_DIR, "code-oss", "product.json"), "utf8"),
  );

  const app = path.join(
    APP_DIR,
    `VSCode-${target}`,
    `${sourceProduct.nameShort}.app`,
  );

  const zips = updateBundlesFor(channel).map(({ bundle, artifact }) => ({
    bundle,
    artifact,
    file: path.join(artifactDir, updateZipName(artifact, version, target)),
  }));

  const dmg = path.join(artifactDir, `Whiteboard-${target}-${version}.dmg`);

  await assertPackagedArtifacts(app);
  assertUpdaterCompatibleApp(app);

  const product = JSON.parse(
    readFileSync(
      path.join(app, "Contents", "Resources", "app", "product.json"),
      "utf8",
    ),
  );

  assertPackagedProduct(product, { commit, channel });

  const extensionsDir = path.join(
    app,
    "Contents",
    "Resources",
    "app",
    "extensions",
  );

  verifyCuratedExtensions({ root: extensionsDir, target });

  assertMachOArch(
    path.join(app, "Contents", "MacOS", sourceProduct.nameShort),
    arch,
  );
  assertMachOArch(
    path.join(
      app,
      "Contents",
      "Resources",
      "app",
      RUNTIME_DIRECTORY_NAME,
      "node_modules",
      "@dev.fast",
      `diffr-darwin-${arch}`,
      "diffr",
    ),
    arch,
  );

  // rust-analyzer is downloaded at runtime, so only the bundled extensions are checked here.
  for (const { extension, targetKey } of selectExtensions(
    target,
    parseGroupSelection(),
  )) {
    for (const relative of extension.executables) {
      const executable = path.join(
        extensionsDir,
        extension.id,
        targetKey.startsWith("win32-") ? `${relative}.exe` : relative,
      );

      assertMachOArch(executable, arch);
    }
  }

  run("bash", [
    path.join(APP_DIR, "scripts/apple-notary.sh"),
    "stapler",
    "validate",
    app,
  ]);
  run("spctl", ["-a", "-vv", "--type", "exec", app]);
  run("bash", [
    path.join(APP_DIR, "scripts/apple-notary.sh"),
    "stapler",
    "validate",
    dmg,
  ]);

  for (const { bundle, file } of zips) {
    assertZipBundle(file, bundle);
  }

  const payloads = zips.map((zip) => ({ ...zip, sha256: sha256(zip.file) }));

  console.log(`Validated release artifacts for ${version} (${commit}):`);

  for (const { bundle, file, sha256 } of payloads) {
    console.log(`  ${file} (${bundle}.app) sha256=${sha256}`);
  }

  console.log(`  ${dmg} sha256=${sha256(dmg)}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
