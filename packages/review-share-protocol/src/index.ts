import { z } from "zod";

export const SHARE_FORMAT = "review-share/2";

/** UTF-8 bytes of a bundle's JSON, as uploaded and as stored. */
export const MAX_SHARE_BYTES = 16 * 1024 * 1024;

export const shareIdSchema = z.uuid();

export const capabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const sharePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (file) =>
      !file.startsWith("/") &&
      !file.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(file) &&
      file
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a repository-relative file path.",
  );

/** The published identity is independent of the author's credential transport. */
export function normalizeGitHubRemote(remote: string): string {
  const url = new URL(
    remote.trim().replace(/^git@github\.com:/, "https://github.com/"),
  );

  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.hostname !== "github.com" ||
    url.port ||
    url.search ||
    url.hash ||
    (url.protocol === "ssh:" && url.username !== "git")
  )
    throw new Error("Sharing requires a GitHub repository remote.");

  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .slice(1);

  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
    )
  )
    throw new Error("Sharing requires a GitHub repository remote.");

  return `https://github.com/${parts.join("/")}.git`;
}

export const gitHubRepositoryUrlSchema = z.string().refine((value) => {
  try {
    return normalizeGitHubRemote(value) === value;
  } catch {
    return false;
  }
}, "Use a canonical GitHub HTTPS repository URL without credentials.");

const REMOTE_ERROR =
  "Use an https or ssh Git remote without a query, a fragment or credentials.";

/** A remote's host, port and decoded path segments. Known forges keep only
 * the segments that name the repository: Azure DevOps organization, project
 * and repository; Bitbucket and GitHub owner and repository. */
interface ParsedRemote {
  scheme: "https" | "ssh";
  user?: string;
  host: string;
  port?: string;
  segments: string[];
  forge?: "azure" | "bitbucket" | "github";
}

const HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

const USER = /^[A-Za-z0-9._~][A-Za-z0-9._~-]*$/;

function remoteError(): Error {
  return new Error(REMOTE_ERROR);
}

/** Decodes one path segment; refuses one that hides a delimiter. */
function decodeSegment(segment: string): string {
  let decoded: string;

  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw remoteError();
  }

  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.startsWith("-")
  )
    throw remoteError();

  return decoded;
}

const encodeSegment = (segment: string) =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const stripGit = (segment: string) => segment.replace(/\.git$/, "");

/** The forge a host and its segments name, with the segments that name
 * the repository; undefined for any other remote. */
function forgeOf(
  scheme: string,
  host: string,
  port: string | undefined,
  segments: string[],
): Pick<ParsedRemote, "forge" | "segments"> | undefined {
  if (port) return undefined;

  const [first, second, third, fourth] = segments;

  if (host === "dev.azure.com" && scheme === "https") {
    if (segments.length === 4 && third === "_git")
      return { forge: "azure", segments: [first!, second!, stripGit(fourth!)] };

    // A project named as its repository.
    if (segments.length === 3 && second === "_git")
      return {
        forge: "azure",
        segments: [first!, stripGit(third!), stripGit(third!)],
      };

    return undefined;
  }

  if (
    (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") &&
    scheme === "ssh" &&
    segments.length === 4 &&
    first === "v3"
  )
    return { forge: "azure", segments: [second!, third!, stripGit(fourth!)] };

  const visualStudio = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(host);

  if (
    visualStudio &&
    host !== "vs-ssh.visualstudio.com" &&
    scheme === "https"
  ) {
    const rest = first === "DefaultCollection" ? segments.slice(1) : segments;

    return rest.length === 3 && rest[1] === "_git"
      ? {
          forge: "azure",
          segments: [visualStudio[1]!, rest[0]!, stripGit(rest[2]!)],
        }
      : undefined;
  }

  if (
    (host === "bitbucket.org" || host === "github.com") &&
    segments.length === 2 &&
    stripGit(second!)
  )
    return {
      forge: host === "github.com" ? "github" : "bitbucket",
      segments: [first!, stripGit(second!)],
    };

  return undefined;
}

function parseRemote(input: string): ParsedRemote {
  if (input.length > 2048 || /[\s\u0000-\u001f\u007f?#\\]/.test(input))
    throw remoteError();

  let scheme: "https" | "ssh";
  let userinfo: string | undefined;
  let host: string;
  let port: string | undefined;
  let path: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const url =
      /^(https|ssh):\/\/(?:([^@/]*)@)?([^/:@]+)(?::(\d{1,5}))?(\/.*)$/i.exec(
        input,
      );

    if (!url) throw remoteError();
    scheme = url[1]!.toLowerCase() === "ssh" ? "ssh" : "https";
    userinfo = url[2];
    host = url[3]!;
    port = url[4];
    path = url[5]!;
  } else {
    // scp form: user@host:path. `ext::`, `file:` and bare paths have no
    // user and host.
    const scp = /^([^@/:]+)@([^/:@]+):([^:].*)$/.exec(input);

    if (!scp) throw remoteError();
    scheme = "ssh";
    userinfo = scp[1];
    host = scp[2]!;
    path = `/${scp[3]!}`;
  }

  host = host.toLowerCase();

  if (!HOST.test(host)) throw remoteError();

  if (port !== undefined) {
    const number = Number(port);

    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw remoteError();
    port =
      (scheme === "https" && number === 443) ||
      (scheme === "ssh" && number === 22)
        ? undefined
        : String(number);
  }

  // https credentials (an Azure organization, a token) never leave the
  // machine; ssh keeps only the user name, which the login needs.
  let user: string | undefined;

  if (scheme === "ssh" && userinfo !== undefined) {
    const name = userinfo.split(":")[0]!;

    if (!USER.test(name)) throw remoteError();
    user = name;
  }

  const segments = path
    .slice(1)
    .replace(/\/$/, "")
    .split("/")
    .map(decodeSegment);

  const forge = forgeOf(scheme, host, port, segments);

  return forge
    ? { scheme, host, ...forge }
    : {
        scheme,
        ...(user !== undefined && { user }),
        host,
        ...(port !== undefined && { port }),
        segments,
      };
}

function canonicalUrl(remote: ParsedRemote): string {
  const path = remote.segments.map(encodeSegment);

  switch (remote.forge) {
    case "azure":
      return `https://dev.azure.com/${path[0]}/${path[1]}/_git/${path[2]}`;
    case "bitbucket":
      return `https://bitbucket.org/${path.join("/")}.git`;
    case "github":
      return `https://github.com/${path.join("/")}.git`;
    default:
      return `${remote.scheme}://${remote.user ? `${encodeSegment(remote.user)}@` : ""}${remote.host}${remote.port ? `:${remote.port}` : ""}/${path.join("/")}`;
  }
}

/**
 * The canonical form of a Git remote a reader fetches from: https or ssh
 * (scp form becomes ssh), rebuilt from validated, percent-encoded parts.
 * https credentials are dropped. Azure DevOps, Bitbucket and GitHub remotes
 * take their forge's one https form, whatever form the author cloned with.
 */
export function normalizeGitRemote(remote: string): string {
  return canonicalUrl(parseRemote(remote));
}

/**
 * Names a repository across the forms of its remote, so a reader's checkout
 * matches a shared one. Known forges ignore case, as they do; any other host
 * keeps its port and path case. Undefined for a remote that does not parse.
 */
export function repositoryIdentity(remote: string): string | undefined {
  let parsed: ParsedRemote;

  try {
    parsed = parseRemote(remote);
  } catch {
    return undefined;
  }

  const segments = parsed.forge
    ? parsed.segments.map((segment) => segment.toLowerCase())
    : [...parsed.segments.slice(0, -1), stripGit(parsed.segments.at(-1)!)];

  const host =
    parsed.forge === "azure"
      ? "dev.azure.com"
      : `${parsed.host}${parsed.port ? `:${parsed.port}` : ""}`;

  return [host, ...segments.map(encodeSegment)].join("/");
}

/** "organization / project / repository", as a reader names it. */
export function repositoryLabel(remote: string): string | undefined {
  try {
    const parsed = parseRemote(remote);

    return [
      ...parsed.segments.slice(0, -1),
      stripGit(parsed.segments.at(-1)!),
    ].join(" / ");
  } catch {
    return undefined;
  }
}

export const gitRemoteUrlSchema = z.string().refine((value) => {
  try {
    return normalizeGitRemote(value) === value;
  } catch {
    return false;
  }
}, "Use a canonical https or ssh Git remote without credentials.");

const commitSchema = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);

const sideSchema = z.enum(["base", "head"]);

/** An excerpt is the lines a board references. */
export const shareSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("excerpt"),
    file: sharePathSchema,
    commit: commitSchema,
    fromLine: z.number().int().positive(),
    lines: z.array(z.string()).min(1),
  }),
]);

const lineRangeSchema = z.object({
  side: sideSchema,
  file: sharePathSchema,
  fromLine: z.number().int().positive(),
  toLine: z.number().int().positive(),
  pins: z
    .object({
      repositoryId: z.string(),
      head: z.string(),
      base: z.string().optional(),
    })
    .optional(),
});

/** 1-based base and head lines; null when a side lacks the line. */
const alignmentRowSchema = z.tuple([
  z.number().int().positive().nullable(),
  z.number().int().positive().nullable(),
]);

export const shareAlignmentSchema = z.object({
  file: sharePathSchema,
  previousFile: sharePathSchema.optional(),
  head: z.string(),
  base: z.string().optional(),
  rows: z.array(alignmentRowSchema).min(1),
});

/** Unknown fields drop, so a reader opens bundles from newer sharers. */
export const shareBundleSchema = z.object({
  format: z.literal(SHARE_FORMAT),
  reviewId: z.string().min(1).max(256),
  version: z.number().int().nonnegative(),
  title: z.string().max(4096),
  /** Validated against the document schema by the reader. */
  snapshot: z.record(z.string(), z.unknown()),
  images: z.record(z.string(), z.object({ png: z.base64() })),
  traces: z.record(z.string(), z.unknown()),
  maps: z.record(z.string(), z.unknown()),
  commits: z.array(z.unknown()),
  /** Each reference's lines, resolved where the board was shared. */
  selections: z.record(z.string(), z.array(lineRangeSchema)),
  sources: z.array(shareSourceSchema),
  /** The sharer's diff over the selections, since 0.4. */
  alignments: z.array(shareAlignmentSchema).optional(),
  repository: z.object({ cloneUrl: gitHubRepositoryUrlSchema }).optional(),
  /** Where a reader's checkout fetches the board's commits, for a
   * repository not on GitHub. Readers before 0.6 drop it. */
  remote: z.object({ url: gitRemoteUrlSchema }).optional(),
  /** Quotes uncommitted changes: view only, never imported. Since 0.6. */
  frozen: z.literal(true).optional(),
});

export type ShareBundle = z.infer<typeof shareBundleSchema>;

export type ShareSource = z.infer<typeof shareSourceSchema>;

export type ShareAlignment = z.infer<typeof shareAlignmentSchema>;

export const createShareSchema = z.object({
  requestId: z.uuid(),
  bundle: shareBundleSchema,
});

export const shareCreatedSchema = z.strictObject({
  shareId: shareIdSchema,
  url: z.url(),
});

const shareSizeSchema = z.number().int().positive().max(MAX_SHARE_BYTES);

export const shareRevisionRefSchema = z.object({
  id: shareIdSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.number(),
});

export const shareRevisionSchema = shareRevisionRefSchema.extend({
  size: shareSizeSchema,
  url: z.url(),
});

export const shareRevisionsSchema = z.object({
  latest: shareIdSchema,
  items: z.array(shareRevisionSchema),
});

export type ShareRevisions = z.infer<typeof shareRevisionsSchema>;

export const sharedMetaSchema = z.object({
  sender: z.strictObject({ login: z.string().min(1).max(256) }),
  sharedAt: z.number(),
  size: shareSizeSchema,
  revision: shareRevisionRefSchema,
  latest: shareIdSchema,
});

export type SharedMeta = z.infer<typeof sharedMetaSchema>;

export function shareLink(
  origin: string,
  capability: string,
  revision?: string,
): string {
  const url = new URL(`/s/${capabilitySchema.parse(capability)}`, origin);

  if (revision !== undefined)
    url.searchParams.set("rev", shareIdSchema.parse(revision));

  return url.href;
}

export type ShareLink = {
  origin: string;
  capability: string;
  revision?: string;
};

export function parseShareLink(value: string): ShareLink {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "app" && key !== "rev")
  )
    throw new Error("Use an HTTPS Whiteboard share link.");

  const link: ShareLink = {
    origin: url.origin,
    capability: capabilitySchema.parse(
      /^\/s\/([^/]+)$/.exec(url.pathname)?.[1],
    ),
  };

  const revision = url.searchParams.get("rev");

  if (revision !== null) link.revision = shareIdSchema.parse(revision);

  return link;
}
