import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { jsonString } from "@dev.fast/json";
import {
  type JsonValue,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewCliInstallApplyResponse,
  ReviewConnectRequestSchema,
  type ReviewDesktopDiscovery,
  type ReviewGatewayHost,
  isJsonObject,
  isObjectValue,
  parseReviewCliInstallApplyRequest,
  reviewDiffrSummarizerInputSchema,
} from "@dev.fast/review-protocol";
import { shellQuote, writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { connectAgent, detectConnectAgents } from "@review/agent-connect";
import { type AskTools, cliAskTools } from "@review/ask/threads.js";
import {
  applyCliInstall,
  declineCliInstall,
  finishCliInstallUpdate,
  pathShimPath,
  removeCliInstall,
  removeLegacyReviewSkills,
  resetCliInstall,
  resolveCliInstallStatus,
  skipCliInstall,
} from "@review/cli-install";
import {
  REVIEW_INSTANCE_ENV,
  type ReviewInstanceIdentity,
} from "@review/desktop-discovery";
import { readReviewPackageVersion } from "@review/package-paths";
import type { LocalReviewData } from "@review/review-api/local-data.js";
import type { ReviewStore } from "@review/review-api/store.js";
import {
  devReviewHome,
  reviewInstanceDiscoveryPath,
  reviewLegacyDiscoveryPath,
} from "@review/review-home-paths";
import {
  readAnimationsEnabled,
  writeAnimationsEnabled,
} from "@review/review-preferences";
import { remoteShare } from "@review/sharing/host.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  migrateDiffrConfig,
  readDiffrConfig,
  saveDiffrSummarizer,
  setDiffrConfigValue,
  testDiffrSummarizer,
} from "./diffr-config";
import {
  GlobalReviewDesktopVerbRelay,
  type ReviewDesktopVerbRelay,
} from "./global-verb-relay";
import {
  type ReviewHonoEnv,
  createNodeRequestListener,
  readBoundedRequestJson,
} from "./hono-http";
import { ReviewServerError } from "./http-json";
import { type LoopbackTls, createLoopbackServer } from "./loopback-server";
import { createReviewGateway } from "./review-gateway";
import {
  answerErrorsAsJson,
  createWhiteboardCore,
  serverJson,
} from "./review-server-core";
import { invalidateStructuralComparisons } from "./structural-comparisons.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GlobalReviewServerInput {
  /** The desktop host owns this shared database and closes it after the server. */
  reviewStore: ReviewStore;
  /** `.whiteboard` file export and import. */
  sharing?: boolean;
  reviewData: LocalReviewData;
  appPid: number;
  packageRoot: string;
  toolingRoot: string;
  cliRuntimePath?: string;
  port: number;
  token?: string;
  instanceId?: string;
  identity?: ReviewInstanceIdentity;
  discoveryPath?: string;
  relay?: ReviewDesktopVerbRelay;
  tls?: LoopbackTls;
  onRemoteHostRestarted?(alias: string): void;
  log?(message: string): void;
}

export interface GlobalReviewServer {
  readonly discovery: ReviewDesktopDiscovery;
  readonly url: string;
  readonly secure: boolean;
  listen(): Promise<void>;
  close(reason?: "app-exit"): Promise<void>;
  setRemoteHosts(hosts: ReviewGatewayHost[]): void;
}

export function createGlobalReviewServer(
  input: GlobalReviewServerInput,
): GlobalReviewServer {
  const instanceId = input.instanceId ?? crypto.randomUUID();
  const token = input.token ?? crypto.randomBytes(32).toString("base64url");
  // Port 0 asks the OS to choose, so nothing may assume the requested port is
  // the bound one until listen() has resolved.
  let boundPort = input.port;
  const urlForBoundPort = () => `http://127.0.0.1:${boundPort}`;
  const identity = input.identity ?? { key: "stable", channel: "stable" };

  // Stable also writes the pre-instance server.json, so a CLI or shim that
  // predates instances still finds it.
  const discoveryPaths = input.discoveryPath
    ? [input.discoveryPath]
    : identity.key === "stable"
      ? [reviewInstanceDiscoveryPath("stable"), reviewLegacyDiscoveryPath()]
      : [reviewInstanceDiscoveryPath(identity.key)];

  // Each window attaches its own stream; one at a time keeps a verb from
  // opening in every window, and the next takes over when it goes.
  const relay =
    input.relay ?? new GlobalReviewDesktopVerbRelay({ maxClients: 1 });

  const askTools = cliAskTools(() => discovery.cliPath, {
    name: REVIEW_INSTANCE_ENV,
    value: identity.key,
  });

  const reviewStore = input.reviewStore;

  let closing = false;
  const cliPath = path.join(input.packageRoot, "dist", "cli.js");

  // The animations preference, read once at listen and kept current by the
  // settings endpoint below: this server is the only writer while it runs.
  let animationsEnabled = false;

  const discovery: ReviewDesktopDiscovery = {
    version: REVIEW_DESKTOP_DISCOVERY_VERSION,
    instanceId,
    url: urlForBoundPort(),
    appPid: input.appPid,
    serverPid: process.pid,
    token,
    startedAt: Date.now(),
    ...identity,
  };

  // A source-run dev server has no built CLI to advertise.
  if (existsSync(cliPath)) {
    discovery.cliPath = cliPath;
    discovery.cliVersion = readReviewPackageVersion(
      pathToFileURL(cliPath).href,
    );

    if (input.cliRuntimePath && existsSync(input.cliRuntimePath)) {
      discovery.cliRuntimePath = input.cliRuntimePath;
    }
  }

  const core = createWhiteboardCore({
    profile: {
      store: reviewStore,
      data: input.reviewData,
    },
    sharing: input.sharing,
    relay,
    token,
    instanceId,
    animations: () => animationsEnabled,
    status: () => {
      const { key, channel, checkout, appVersion, cliVersion, instanceId } =
        discovery;

      return {
        key: key ?? null,
        channel: channel ?? null,
        checkout: checkout ?? null,
        appVersion: appVersion ?? null,
        cliVersion: cliVersion ?? null,
        instanceId,
        url: urlForBoundPort(),
        home: devReviewHome(),
      };
    },
    hooks: {
      sharing: {
        remoteShare: remoteShare(
          (reviewId) => gateway.isRemote(reviewId),
          (request) => gateway.fetch(request),
        ),
      },
    },
    ask: { tools: askTools },
  });

  const { app } = core;

  const localApi = new Hono<ReviewHonoEnv>();
  answerErrorsAsJson(localApi);

  localApi.route("/reviews-api", core.api);

  const gateway = createReviewGateway({
    local: (request) => localApi.fetch(request),
    isLocal: (reviewId) => reviewStore.has(reviewId),
    version: readReviewPackageVersion(import.meta.url),
    home: devReviewHome(),
    relay,
    restarted: (alias) => input.onRemoteHostRestarted?.(alias),
    log: input.log,
  });

  app.all("/reviews-api", (context) => gateway.fetch(context.req.raw));
  app.all("/reviews-api/*", (context) => gateway.fetch(context.req.raw));
  app.get("/remote-hosts", () => serverJson(200, gateway.hosts()));
  app.get("/preferences/animations", () =>
    serverJson(200, { enabled: animationsEnabled }),
  );
  app.put("/preferences/animations", async (context) => {
    const request = z
      .object({ enabled: z.boolean() })
      .safeParse(await readBoundedRequestJson(context.req.raw));

    if (!request.success)
      throw new ReviewServerError("enabled must be a boolean.", 400);
    animationsEnabled = await writeAnimationsEnabled(request.data.enabled);

    return serverJson(200, { enabled: animationsEnabled });
  });
  app.post("/app/focus", async () => {
    const result = await relay.dispatch({
      name: "focusWindow",
      args: {},
    });

    return serverJson(result.ok ? 200 : 409, result);
  });
  app.get("/diffr-config", async () =>
    serverJson(200, await readDiffrConfig()),
  );
  app.put("/diffr-config", async (context) => {
    const body = await readBoundedRequestJson(context.req.raw);

    const key = isJsonObject(body) ? jsonString(body.key) : undefined;

    const value = isJsonObject(body) ? body.value : undefined;

    if (key === undefined || value === undefined) {
      throw new ReviewServerError("key and value are required.", 400);
    }

    return serverJson(200, await setDiffrConfigValue(key, value));
  });
  app.put("/diffr-config/summarizer", async (context) => {
    const input = reviewDiffrSummarizerInputSchema.safeParse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!input.success)
      throw new ReviewServerError("Invalid summary settings.", 400);

    return serverJson(200, await saveDiffrSummarizer(input.data));
  });
  app.post("/diffr-config/summarizer/test", async (context) => {
    const input = reviewDiffrSummarizerInputSchema.safeParse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!input.success)
      throw new ReviewServerError("Invalid summary settings.", 400);

    return serverJson(200, {
      summary: await testDiffrSummarizer(
        input.data,
        undefined,
        context.req.raw.signal,
      ),
    });
  });
  app.get("/install/status", async () =>
    serverJson(
      200,
      await resolveCliInstallStatus({ packageRoot: input.packageRoot }),
    ),
  );
  app.post("/install/apply", async (context) => {
    const request = parseReviewCliInstallApplyRequest(
      await readBoundedRequestJson(context.req.raw),
    );

    const applyInput: Parameters<typeof applyCliInstall>[0] = {
      packageRoot: input.packageRoot,
    };

    if (request.shim !== undefined) applyInput.shim = request.shim;

    if (request.autoUpdate) applyInput.autoUpdate = true;

    if (discovery.cliPath) applyInput.cliPath = discovery.cliPath;

    if (discovery.cliRuntimePath) {
      applyInput.cliRuntimePath = discovery.cliRuntimePath;
    }

    const result = await applyCliInstall(applyInput);

    const body: ReviewCliInstallApplyResponse = {
      ok: result.code === 0,
      output: result.output,
    };

    if (result.shimPath) body.shimPath = result.shimPath;

    return serverJson(result.code === 0 ? 200 : 500, body);
  });
  app.post("/install/remove", async (context) => {
    const request = parseReviewCliInstallApplyRequest(
      await readBoundedRequestJson(context.req.raw),
    );

    const removeInput: Parameters<typeof removeCliInstall>[0] = {};

    if (request.shim) removeInput.shim = true;
    const result = await removeCliInstall(removeInput);

    return serverJson(200, { ok: true, output: result.output });
  });
  app.post("/install/legacy-skills/remove", async () => {
    const { removed } = await removeLegacyReviewSkills();

    return serverJson(200, { ok: true, removed });
  });
  app.post("/install/finish-update", async () => {
    await finishCliInstallUpdate();

    return serverJson(200, { ok: true });
  });
  app.post("/install/decline", async () => {
    await declineCliInstall();

    return serverJson(200, { ok: true });
  });
  app.post("/install/skip", async () => {
    await skipCliInstall();

    return serverJson(200, { ok: true });
  });
  app.post("/install/reset", async () => {
    await resetCliInstall();

    return serverJson(200, { ok: true });
  });
  // The harnesses first run connects for the user, instead of asking them
  // to paste a prompt into each one.
  app.get("/install/agents", async () =>
    serverJson(200, { agents: await detectConnectAgents() }),
  );
  app.post("/install/connect", async (context) => {
    const request = ReviewConnectRequestSchema.safeParse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!request.success) throw new ReviewServerError("Invalid agent.", 400);

    return serverJson(
      200,
      await connectAgent(request.data.target, {
        hasShim: existsSync(pathShimPath()),
      }),
    );
  });

  const loopback = createLoopbackServer(
    createNodeRequestListener(app),
    input.tls,
    input.log,
  );

  return {
    discovery,
    secure: loopback.secure,
    get url() {
      return urlForBoundPort();
    },
    listen: async () => {
      await migrateDiffrConfig();
      animationsEnabled = await readAnimationsEnabled();
      boundPort = await listen(loopback.server, input.port);
      discovery.url = urlForBoundPort();

      for (const discoveryPath of discoveryPaths)
        await writePrivateJsonAtomic(discoveryPath, discovery);
    },
    close: async () => {
      if (closing) return;
      closing = true;
      core.close();

      for (const discoveryPath of discoveryPaths)
        await removeMatchingDiscovery(discoveryPath, discovery);
      relay.close();

      await loopback.close();
      await gateway.close();
    },
    setRemoteHosts: (hosts) => gateway.setHosts(hosts),
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();

      if (!isTcpAddress(address)) {
        reject(new Error("The Whiteboard server did not bind a TCP port."));

        return;
      }

      resolve(address.port);
    });
  });
}

async function removeMatchingDiscovery(
  filePath: string,
  discovery: ReviewDesktopDiscovery,
): Promise<void> {
  try {
    const current: JsonValue = JSON.parse(await readFile(filePath, "utf8"));

    if (
      isJsonObject(current) &&
      current.instanceId === discovery.instanceId &&
      current.appPid === discovery.appPid
    ) {
      await rm(filePath, { force: true });
    }
  } catch (error) {
    // SAFETY: fs/promises rejects with a Node ErrnoException carrying `code`.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** `server.address()` is a string for pipe and socket listeners. */
function isTcpAddress(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return isObjectValue(address);
}
