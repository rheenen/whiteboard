import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  hostedStoreDisabled,
  type runStoreLogin,
  writeStoreAuth,
} from "@dev.fast/trace-core";
import { ReviewInputError } from "@dev.fast/whiteboard-document";
import { runReviewCli } from "@review/cli-runner.js";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import {
  SHARING_DISABLED,
  SHARING_POLICY_FILE,
  applyDesktopSharingSetting,
  isSharingDisabled,
} from "./disabled.js";
import { mountSharingHost, mountSharingPublisher } from "./host.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const close of cleanup.splice(0).reverse()) await close();
});

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-disabled-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  return root;
}

it("turns sharing off by the environment, the install policy, or both", async () => {
  const root = await scratch();
  const home = { DEV_REVIEW_HOME: await scratch() };

  const policy = (text: string) =>
    writeFile(path.join(root, SHARING_POLICY_FILE), text);

  expect(isSharingDisabled(root, home)).toBe(false);

  for (const value of ["1", "true", "TRUE"])
    expect(
      isSharingDisabled(root, { ...home, DEV_REVIEW_SHARING_DISABLED: value }),
    ).toBe(true);

  for (const value of ["0", "false", ""])
    expect(
      isSharingDisabled(root, { ...home, DEV_REVIEW_SHARING_DISABLED: value }),
    ).toBe(false);

  await policy('{"sharing": "disabled"}');
  expect(isSharingDisabled(root, home)).toBe(true);
  expect(
    isSharingDisabled(root, { ...home, DEV_REVIEW_SHARING_DISABLED: "1" }),
  ).toBe(true);
  // The environment cannot undo the install policy.
  expect(
    isSharingDisabled(root, { ...home, DEV_REVIEW_SHARING_DISABLED: "0" }),
  ).toBe(true);

  for (const text of ["{", "[]", '{"sharing": "on"}', ""]) {
    await policy(text);
    expect(isSharingDisabled(root, home)).toBe(true);
  }

  await policy('{"sharing": "enabled"}');
  expect(isSharingDisabled(root, home)).toBe(false);
  expect(
    isSharingDisabled(root, { ...home, DEV_REVIEW_SHARING_DISABLED: "1" }),
  ).toBe(true);

  await rm(path.join(root, SHARING_POLICY_FILE));
  expect(isSharingDisabled(root, home)).toBe(false);
});

it("follows the Desktop setting through the user's marker, both ways", async () => {
  const root = await scratch();
  const env = { DEV_REVIEW_HOME: await scratch() };

  applyDesktopSharingSetting({ ...env, DEV_REVIEW_DESKTOP_SHARING: "off" });
  expect(isSharingDisabled(root, env)).toBe(true);
  // A process that the Desktop did not start, such as an agent's CLI call.
  expect(hostedStoreDisabled(env)).toBe(true);

  applyDesktopSharingSetting(env);
  expect(isSharingDisabled(root, env)).toBe(true);

  applyDesktopSharingSetting({ ...env, DEV_REVIEW_DESKTOP_SHARING: "on" });
  expect(isSharingDisabled(root, env)).toBe(false);
  expect(
    isSharingDisabled(root, { ...env, DEV_REVIEW_SHARING_DISABLED: "1" }),
  ).toBe(true);
});

it("refuses every upload and sign-in route without reaching the network, and still exports", async () => {
  const root = await scratch();
  const fixture = await createShareFixture(root);
  cleanup.push(() => fixture.store.close());
  cleanup.push(() => fixture.data.close());
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_REVIEW_SHARE_TOKEN", "ci-publish-token");
  await writeStoreAuth({
    origin: "https://app.dev.fast",
    token: "fixture",
    login: "fixture",
    savedAt: new Date().toISOString(),
  });

  const fetch = vi.fn<typeof globalThis.fetch>();
  const login = vi.fn<typeof runStoreLogin>(async () => 0);
  const api = new Hono();
  api.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof ReviewInputError ? error.status : 500,
    ),
  );
  mountSharingHost(api, fixture.store, fixture.data, {
    fetch,
    login,
    readRepository: async () => ({ repository: fixture.repository }),
    sharingDisabled: () => true,
  });

  const post = (route: string, body: Record<string, string>) =>
    api.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  expect(await (await api.request("/sharing/account")).json()).toEqual({
    disabled: true,
  });

  for (const response of [
    await post("/sharing/login", {}),
    await post("/sharing/publish", { reviewId: fixture.reviewId }),
    await post("/sharing/import", {
      url: `https://app.dev.fast/s/${"x".repeat(43)}`,
    }),
    await post("/sharing/revoke", {
      shareId: "00000000-0000-4000-8000-000000000000",
    }),
  ]) {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SHARING_DISABLED });
  }

  const exported = await post("/sharing/export", {
    reviewId: fixture.reviewId,
  });

  expect(exported.status).toBe(200);
  expect((await post("/sharing/logout", {})).status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
  expect(login).not.toHaveBeenCalled();
});

it("refuses to publish from a headless server even with a CI token, and still exports", async () => {
  const root = await scratch();
  const fixture = await createShareFixture(root);
  cleanup.push(() => fixture.store.close());
  cleanup.push(() => fixture.data.close());
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_REVIEW_SHARE_TOKEN", "ci-publish-token");
  vi.stubEnv("DEV_REVIEW_SHARING_DISABLED", "1");

  const fetch = vi.fn<typeof globalThis.fetch>();
  const api = new Hono();
  api.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof ReviewInputError ? error.status : 500,
    ),
  );
  // The default switch: the environment of the server.
  mountSharingPublisher(api, fixture.store, fixture.data, {
    fetch,
    readRepository: async () => ({ repository: fixture.repository }),
  });

  const post = (route: string) =>
    api.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId: fixture.reviewId }),
    });

  const published = await post("/sharing/publish");

  expect(published.status).toBe(403);
  expect(await published.json()).toEqual({ error: SHARING_DISABLED });
  expect((await post("/sharing/export")).status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["share", "--review", "any"],
  ["share", "revoke", "any"],
  ["login"],
  ["whoami"],
])("exits 2 before any network call: whiteboard %s", async (...argv) => {
  const stateDir = await scratch();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let diagnostic = "";
  stdout.on("data", (chunk) => {
    output += chunk;
  });
  stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });

  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);

  try {
    expect(
      await runReviewCli({
        argv: ["--state-dir", stateDir, ...argv, "--json"],
        env: {
          ...process.env,
          DEV_REVIEW_HOME: stateDir,
          DEV_REVIEW_SHARING_DISABLED: "1",
          DEV_REVIEW_SHARE_TOKEN: "ci-publish-token",
          DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
        },
        stdout,
        stderr,
      }),
    ).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }

  expect(JSON.parse(output)).toEqual({
    error: { code: "sharing_disabled", message: SHARING_DISABLED },
  });
  expect(diagnostic).toContain(SHARING_DISABLED);
  expect(fetch).not.toHaveBeenCalled();
});
