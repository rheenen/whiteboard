import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { releaseIdentityFor } from "./release-channel.mjs";
import {
  assertMachOArch,
  assertPackagedProduct,
  assertUpdaterCompatibleApp,
} from "./validate-release-artifacts.mjs";

const temporaryRoots = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const PRODUCT = {
  ...releaseIdentityFor("stable"),
  commit: "abc123",
  quality: "stable",
};

test(
  "assertMachOArch rejects a binary built for the other arch",
  { skip: process.platform !== "darwin" },
  () => {
    const thin = path.join(mkdtempSync(path.join(tmpdir(), "macho-")), "true");
    execFileSync("lipo", ["/usr/bin/true", "-thin", "arm64e", "-output", thin]);

    assert.throws(
      () => assertMachOArch(thin, "x64"),
      /is arm64e, expected x86_64/,
    );
    assertMachOArch("/usr/bin/true", "x64");
  },
);

test("assertPackagedProduct accepts a correctly stamped product", () => {
  assertPackagedProduct(PRODUCT, { commit: "abc123" });
});

test("assertPackagedProduct accepts a preview-stamped product", () => {
  assertPackagedProduct(
    {
      ...PRODUCT,
      ...releaseIdentityFor("preview"),
      quality: "preview",
    },
    { commit: "abc123", channel: "preview" },
  );
});

test("assertPackagedProduct rejects stable identity on a preview build", () => {
  assert.throws(
    () =>
      assertPackagedProduct(
        { ...PRODUCT, quality: "preview" },
        { commit: "abc123", channel: "preview" },
      ),
    /nameShort/,
  );
});

test("assertPackagedProduct rejects a cross-channel product", () => {
  assert.throws(
    () =>
      assertPackagedProduct(PRODUCT, {
        commit: "abc123",
        channel: "preview",
      }),
    /quality/,
  );
});

test("assertPackagedProduct rejects a mismatched commit", () => {
  assert.throws(
    () => assertPackagedProduct(PRODUCT, { commit: "def456" }),
    /commit/,
  );
});

test("assertPackagedProduct rejects a build with an update feed", () => {
  assert.throws(
    () =>
      assertPackagedProduct(
        { ...PRODUCT, updateUrl: "https://updates.example" },
        { commit: "abc123" },
      ),
    /updateUrl/,
  );
});

test("assertUpdaterCompatibleApp rejects read-only package files", async () => {
  const app = await mkdtemp(path.join(os.tmpdir(), "review-update-app-"));
  temporaryRoots.push(app);
  const resources = path.join(app, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const object = path.join(resources, "git-object");
  await writeFile(object, "object");
  await chmod(object, 0o444);

  assert.throws(() => assertUpdaterCompatibleApp(app), /git-object/);

  await chmod(object, 0o644);
  assert.doesNotThrow(() => assertUpdaterCompatibleApp(app));
});
