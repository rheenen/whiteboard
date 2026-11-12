import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/json";
import { z } from "zod";

import { devReviewHome } from "./trace-home";

const DEVICE_CODE_PATH = "/api/auth/device/code";

const DEVICE_TOKEN_PATH = "/api/auth/device/token";

const SESSION_PATH = "/api/auth/get-session";

const STORE_CLIENT_ID = "review-cli";

const storeErrorCodeSchema = z.enum([
  "unauthorized",
  "repository_authorization_required",
  "forbidden",
  "not_found",
  "invalid_request",
  "payload_too_large",
  "github_unavailable",
  "upload_incomplete",
  "stale_upload",
  "store_deleted",
  "upgrade_required",
  "internal",
]);

export type StoreErrorCode = z.infer<typeof storeErrorCodeSchema>;

const storeErrorEnvelopeSchema = z.object({
  error: z.object({ code: storeErrorCodeSchema, message: z.string() }),
});

const DEFAULT_TIMEOUT_MS = 30_000;

/** Largest answer the client reads. */
const MAX_STORE_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The message for a store whose responses do not match this client's
 * contract. */
export const STORE_UPGRADE_REQUIRED_MESSAGE =
  "The store does not support this version of Review. Update Review or use a matching store.";

/**
 * The OAuth device-flow error shape used by the Better Auth device
 * endpoints, e.g. `{"error":"invalid_grant","error_description":"..."}`.
 * This is distinct from the store's own `storeErrorEnvelopeSchema`.
 */
const oauthDeviceErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export class StoreApiError extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoreApiError";
  }
}

/** Thrown before any request when the installation turned sharing off. */
export class HostedStoreDisabledError extends StoreApiError {
  constructor() {
    super("forbidden", 403, "Sharing is disabled on this installation");
    this.name = "HostedStoreDisabledError";
  }
}

/** Set to `1` or `true` by an installation that turned sharing off. The
 * review runtime also sets it from its install policy file. */
export const SHARING_DISABLED_ENV = "DEV_REVIEW_SHARING_DISABLED";

/** A file in the Review home that says this user turned sharing off, for
 * example with the Desktop setting. Every process reads it, also the ones
 * the Desktop server did not start. */
export const SHARING_DISABLED_MARKER = "sharing-disabled";

export function sharingMarkerPath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(devReviewHome(env), SHARING_DISABLED_MARKER);
}

/** Writes the marker when `disabled`, and removes it otherwise. */
export function writeSharingMarker(
  disabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const marker = sharingMarkerPath(env);

  if (!disabled) {
    rmSync(marker, { force: true });

    return;
  }

  mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
  writeFileSync(marker, "", { mode: 0o600 });
}

/** Whether the environment or the user's marker turns the hosted store off. */
export function hostedStoreDisabled(env: NodeJS.ProcessEnv = process.env) {
  const flag = env[SHARING_DISABLED_ENV]?.trim().toLowerCase();

  return flag === "1" || flag === "true" || existsSync(sharingMarkerPath(env));
}

export interface StoreClientOptions {
  origin: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Read before every request, so a server that turns sharing off later
   * stops at once; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type DeviceTokenResult =
  | { access_token: string }
  | { pending: "authorization_pending" | "slow_down" };

interface SessionResponse {
  user: {
    id: string;
    name: string;
    email?: string;
    githubLogin?: string | null;
  };
}

export class StoreClient {
  private readonly origin: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: StoreClientOptions) {
    this.origin = options.origin;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }

  /** Every request to the hosted store passes here first. */
  private assertEnabled(): void {
    if (hostedStoreDisabled(this.env)) throw new HostedStoreDisabledError();
  }

  async deviceCode(): Promise<DeviceCodeResponse> {
    return this.requestJson(
      DEVICE_CODE_PATH,
      { client_id: STORE_CLIENT_ID, scope: "identity" },
      undefined,
    );
  }

  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    this.assertEnabled();
    const url = new URL(DEVICE_TOKEN_PATH, this.origin);

    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: STORE_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 400) {
      // The device token endpoint answers with an OAuth device-flow error
      // body, not the store's own error envelope. Read the body once here,
      // since the response stream cannot be read a second time.
      const raw = await this.readJsonBody(response);
      const oauthError = oauthDeviceErrorSchema.safeParse(raw);

      if (
        oauthError.success &&
        (oauthError.data.error === "authorization_pending" ||
          oauthError.data.error === "slow_down")
      ) {
        return { pending: oauthError.data.error };
      }

      throw this.oauthOrEnvelopeError(raw, response.status);
    }

    if (!response.ok) {
      throw await this.toStoreApiError(response);
    }

    // SAFETY: a 2xx from the device token endpoint carries the OAuth
    // device-flow success body, which this client does not validate against
    // a zod schema because it is not part of the store contract.
    return (await response.json()) as { access_token: string };
  }

  async session(): Promise<SessionResponse> {
    return this.get(
      SESSION_PATH,
      z.object({
        user: z.object({
          id: z.string().min(1),
          name: z.string(),
          email: z.string().optional(),
          githubLogin: z.string().nullish(),
        }),
      }),
    );
  }

  private jsonHeaders(): Record<string, string> {
    return this.token
      ? {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        }
      : { "content-type": "application/json" };
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T> | undefined,
    query?: URLSearchParams,
  ): Promise<T> {
    return this.send("GET", path, undefined, schema, query);
  }

  private async requestJson<T, Body>(
    path: string,
    body: Body,
    schema: z.ZodType<T> | undefined,
  ): Promise<T> {
    return this.send("POST", path, body, schema);
  }

  private async send<T, Body>(
    method: "GET" | "POST",
    path: string,
    body: Body | undefined,
    schema: z.ZodType<T> | undefined,
    query?: URLSearchParams,
  ): Promise<T> {
    this.assertEnabled();
    const url = new URL(path, this.origin);

    if (query) {
      for (const [key, value] of query) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {};

    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) throw await this.toStoreApiError(response);

    const contentLength = Number(response.headers.get("content-length") ?? "0");

    if (contentLength > MAX_STORE_RESPONSE_BYTES) {
      throw new StoreApiError(
        "internal",
        response.status,
        `The store answered ${contentLength} bytes; the client accepts at most ${MAX_STORE_RESPONSE_BYTES}.`,
      );
    }

    return this.parseJson(response, schema);
  }

  private async parseJson<T>(
    response: Response,
    schema: z.ZodType<T> | undefined,
  ): Promise<T> {
    const raw = await response.json();

    if (!schema) {
      // SAFETY: only session() omits a schema. The caller defines that private
      // response because it is not part of the store contract.
      return raw as T;
    }

    const result = schema.safeParse(raw);

    if (!result.success) {
      // A well-formed answer that misses a field comes from a store that
      // speaks a different protocol version. The user must align the two.
      throw new StoreApiError(
        "upgrade_required",
        response.status,
        STORE_UPGRADE_REQUIRED_MESSAGE,
      );
    }

    return result.data;
  }

  private async toStoreApiError(response: Response): Promise<StoreApiError> {
    const raw = await this.readJsonBody(response);

    return this.oauthOrEnvelopeError(raw, response.status);
  }

  /**
   * Reads a response body once, as text, and parses it as JSON. Returns
   * `undefined` if the body cannot be read or is not valid JSON.
   */
  private async readJsonBody(
    response: Response,
  ): Promise<JsonValue | undefined> {
    let text: string;

    try {
      text = await response.text();
    } catch {
      return undefined;
    }

    try {
      return parseJsonText(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Builds a StoreApiError from an already-parsed body, which is either the
   * store's own `{ error: { code, message } }` envelope or the OAuth
   * device-flow error shape `{ error, error_description }` used by the
   * Better Auth device endpoints.
   */
  private oauthOrEnvelopeError(
    raw: JsonValue | undefined,
    status: number,
  ): StoreApiError {
    if (raw === undefined) {
      return new StoreApiError(
        "internal",
        status,
        "The store returned an unreadable response.",
      );
    }

    const oauthError = oauthDeviceErrorSchema.safeParse(raw);

    if (oauthError.success) {
      const knownCode = storeErrorCodeSchema.safeParse(oauthError.data.error);

      return new StoreApiError(
        knownCode.success ? knownCode.data : "invalid_request",
        status,
        oauthError.data.error_description ?? oauthError.data.error,
      );
    }

    const result = storeErrorEnvelopeSchema.safeParse(raw);

    if (!result.success) {
      return new StoreApiError(
        "internal",
        status,
        "The store returned an error response that does not match the contract.",
      );
    }

    return new StoreApiError(
      result.data.error.code,
      status,
      result.data.error.message,
    );
  }
}
