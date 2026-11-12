import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/json";
import { describe, expect, it, vi } from "vitest";

import {
  HostedStoreDisabledError,
  STORE_UPGRADE_REQUIRED_MESSAGE,
  StoreApiError,
  StoreClient,
  hostedStoreDisabled,
  writeSharingMarker,
} from "./store-client";

function jsonResponse(body: JsonValue, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("StoreClient", () => {
  it("sends nothing once the installation turns sharing off", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    const env: NodeJS.ProcessEnv = {};

    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
      env,
    });

    env.DEV_REVIEW_SHARING_DISABLED = "1";

    await expect(client.session()).rejects.toBeInstanceOf(
      HostedStoreDisabledError,
    );
    await expect(client.deviceToken("code")).rejects.toBeInstanceOf(
      HostedStoreDisabledError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows the user's sharing marker, also after it was removed", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sharing-marker-"));

    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ user: { id: "u", name: "n" } }),
    );

    const env: NodeJS.ProcessEnv = { DEV_REVIEW_HOME: home };

    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
      env,
    });

    try {
      writeSharingMarker(true, env);
      expect(hostedStoreDisabled(env)).toBe(true);
      await expect(client.session()).rejects.toBeInstanceOf(StoreApiError);
      expect(fetch).not.toHaveBeenCalled();

      writeSharingMarker(false, env);
      expect(hostedStoreDisabled(env)).toBe(false);
      await client.session();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("sends the bearer token and parses the envelope on error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: "no" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );

    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });

    await expect(client.session()).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer tok",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      new URL("/api/auth/get-session", "https://app.dev.fast").toString(),
    );
  });

  it("maps device polling errors to pending states", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "authorization_pending",
            error_description: "",
          }),
          { status: 400 },
        ),
    );

    const client = new StoreClient({ origin: "https://app.dev.fast", fetch });
    expect(await client.deviceToken("dc")).toEqual({
      pending: "authorization_pending",
    });

    const rejectingFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "The device code is invalid.",
          }),
          { status: 400 },
        ),
    );

    const rejectingClient = new StoreClient({
      origin: "https://app.dev.fast",
      fetch: rejectingFetch,
    });

    await expect(rejectingClient.deviceToken("dc")).rejects.toSatisfy(
      (error) => {
        expect(error).toBeInstanceOf(StoreApiError);
        expect((error as StoreApiError).message).toMatch(/invalid/i);

        return true;
      },
    );
  });

  it("maps a response outside the contract to upgrade_required", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ nonsense: true }),
    );

    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });

    await expect(client.session()).rejects.toMatchObject({
      code: "upgrade_required",
      status: 200,
      message: STORE_UPGRADE_REQUIRED_MESSAGE,
    });
  });
});
