import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { type JsonObject, type JsonValue } from "@dev.fast/review-protocol";
import {
  type ShareBundle,
  repositoryLabel,
  shareBundleSchema,
} from "@dev.fast/review-share-protocol";
import {
  type Pins,
  ReviewInputError,
  checkReferences,
  documentSchema,
  lensSchema,
  pinsSchema,
  resourceReferences,
} from "@dev.fast/whiteboard-document";
import type { LocalReviewData } from "@review/review-api/local-data.js";
import { pullRequestUrl } from "@review/review-api/origin.js";
import type { ReviewStore } from "@review/review-api/store.js";
import {
  devReviewHome,
  safeStorageSegment,
} from "@review/review-home-paths.js";
import { softwareModelDataSchema } from "@review/software-map-model.js";
import {
  liftFileLenses,
  migrateStoredDocument,
  migrateStoredLenses,
} from "@review/stored-document-migration.js";
import { z } from "zod";

import { referenceCommits, validateShareSources } from "./export.js";
import {
  COMMIT_ID,
  assertCommitIds,
  fetchSharedCommits,
  repositoryName,
  sharedGit,
} from "./repository.js";

export const sharedSnapshotSchema = z.object({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative(),
  /** Empty for a board never named; it reads "Untitled". */
  title: z.string(),
  pins: pinsSchema
    .extend({
      base: z.string().regex(COMMIT_ID),
      head: z.string().regex(COMMIT_ID),
    })
    .optional(),
  document: documentSchema,
  lenses: z.array(lensSchema).optional(),
  createdAt: z.string(),
  origin: z
    .object({
      branch: z.string().optional(),
      baseRef: z.string().optional(),
      baseBranch: z.string().optional(),
      pullRequestNumber: z.number().int().positive().optional(),
      pullRequestUrl: pullRequestUrl.optional(),
      pullRequestTitle: z.string().optional(),
      pullRequestBaseBranch: z.string().optional(),
      revision: z.string().optional(),
    })
    .optional(),
});

const count = z.number().int().nonnegative();

const counts = z.object({ additions: count, deletions: count });

const mapSchema = softwareModelDataSchema.extend({
  commit: z.string().regex(COMMIT_ID),
  side: z.enum(["base", "head"]),
  countsByElementPath: z.record(z.string(), counts),
  unmappedByElementPath: z.record(
    z.string(),
    counts.extend({
      files: z.array(
        counts.extend({
          file: z.string(),
          hunks: z.array(
            z.object({
              startLine: count,
              lines: z.array(
                z.object({
                  kind: z.enum(["add", "remove"]),
                  oldLine: count.nullable(),
                  newLine: count.nullable(),
                  text: z.string(),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const sharePresentationSchema = z.object({
  maps: z.record(z.string(), mapSchema),
});

/** Commits live in a checkout; a document alone needs none. A bundle's
 * `traces` are ignored: this build has no trace capture. */
export function needsRepository(
  _bundle: ShareBundle,
  snapshot: Parameters<typeof referenceCommits>[0],
) {
  return Boolean(snapshot.pins || referenceCommits(snapshot).length);
}

export function validateShareBundle(input: ShareBundle) {
  const bundle = shareBundleSchema.parse(input);

  if (bundle.frozen)
    throw new ReviewInputError(
      "This whiteboard is a read-only snapshot of uncommitted changes. View it in the browser.",
      409,
    );
  // SAFETY: a bundle is parsed from JSON, so its snapshot is a JSON object.
  const stored = bundle.snapshot as JsonObject;

  // Bundles shared before a field was retired still open; only the parsed
  // document drops the retired form. Lenses shared as document blocks read
  // as the snapshot's lenses.
  const snapshot = sharedSnapshotSchema.parse(
    stored.document === undefined
      ? stored
      : liftSharedLenses(stored, migrateStoredDocument(stored.document)),
  );

  if (
    snapshot.reviewId !== bundle.reviewId ||
    snapshot.version !== bundle.version ||
    snapshot.title !== bundle.title
  )
    throw new Error("Shared snapshot does not match its bundle.");
  checkReferences(snapshot.document);
  validateShareSources(snapshot);
  // Every commit it quotes reaches git as an argument.
  assertCommitIds(referenceCommits(snapshot));

  const maps = z.record(z.string(), mapSchema).parse(bundle.maps);

  if (!snapshot.pins && Object.keys(maps).length)
    throw new Error("Shared maps require source pins.");

  for (const block of resourceReferences(snapshot.document)) {
    if (block.type === "software_map") {
      const map = Object.hasOwn(maps, block.mapVersionId)
        ? maps[block.mapVersionId]
        : undefined;

      if (!map || map.commit !== snapshot.pins?.[map.side])
        throw new Error("Shared map pins do not match.");
    }
  }

  return { bundle, snapshot, maps };
}

function liftSharedLenses(stored: JsonObject, migrated: JsonValue): JsonObject {
  const { document, lenses } = liftFileLenses(migrated);

  // SAFETY: migration returns the array it was given, rewritten.
  const kept = Array.isArray(stored.lenses)
    ? (migrateStoredLenses(stored.lenses) as JsonValue[])
    : [];

  return {
    ...stored,
    document,
    ...((kept.length || lenses.length) && { lenses: [...kept, ...lenses] }),
  };
}

export interface ShareImport {
  store: ReviewStore;
  data: LocalReviewData;
  onStage?: (stage: "fetching" | "validating") => void;
  /** A file opened without a checkout: its peeks read the lines the file
   * carries, and its code cannot change. */
  readOnly?: boolean;
}

/** A file needs a checkout of its repository that is not open in
 * Whiteboard; `remote` is where to clone one from. */
export class MissingCheckoutError extends ReviewInputError {
  constructor(
    message: string,
    readonly remote?: string,
  ) {
    super(message, 409);
  }
}

/** Imports a `.whiteboard` file's bundle as an ordinary board. A file is
 * opened on a checkout the reader already has, never on a clone: whoever
 * wrote it chose its remote. */
export async function importShare(
  input: ShareImport,
  key: string,
  received: ShareBundle,
): Promise<string> {
  const { store, data } = input;
  const { bundle, snapshot, maps } = validateShareBundle(received);
  const remote = bundle.repository?.cloneUrl ?? bundle.remote?.url;
  const needed = needsRepository(bundle, snapshot);
  let repositoryId: string | undefined;

  if (input.readOnly && needed)
    repositoryId = await readOnlyRepository(input, key, remote, bundle);
  // A document is filed on a checkout the receiver already has; it is not
  // worth a clone.
  else if (needed || (remote && store.checkoutsOfRemote(remote).length)) {
    input.onStage?.("fetching");
    repositoryId = await shareRepository(
      input,
      remote,
      snapshot.pins,
      referenceCommits(snapshot),
      key,
    );
  }

  const pins =
    snapshot.pins && repositoryId
      ? { ...snapshot.pins, repositoryId }
      : undefined;

  input.onStage?.("validating");

  const ranges = Object.values(maps).flatMap((map) =>
    map.elements.flatMap((element) =>
      (element.sourceRanges ?? []).map((range) => ({
        ...range,
        side: map.side,
      })),
    ),
  );

  if (pins && ranges.length && !input.readOnly)
    await data.validateSources(pins, ranges);

  // The copy's resources are its own: the sender's ids may be in this store.
  // Shared traces are dropped; their quotes stay as stored placeholders.
  const ids = new Map(Object.keys(maps).map((id) => [id, randomUUID()]));

  if (repositoryId) {
    for (const [
      id,
      { commit, side, elements, relationships },
    ] of Object.entries(maps))
      store.putResource(
        ids.get(id)!,
        repositoryId,
        "map",
        "application/json",
        Buffer.from(JSON.stringify({ commit, side, elements, relationships })),
      );
  }

  let document = JSON.stringify(snapshot.document);

  for (const [id, copy] of ids) document = document.replaceAll(id, copy);

  const create = {
    operation: {
      type: "create",
      ...(snapshot.title && { title: snapshot.title }),
      ...(pins
        ? { target: { kind: "commits", ...pins } }
        : repositoryId && {
            target: { kind: "project", repositoryId },
          }),
    },
  };

  const seed = {
    document: JSON.parse(document),
    lenses: snapshot.lenses,
    origin: snapshot.origin,
    shared: { ...(remote && { cloneUrl: remote }), key },
    copiedFrom: snapshot.reviewId,
  };

  const { reviewId } = await store.execute(create, seed, { kind: "person" });

  return reviewId;
}

/** Whether the checkout at `root` already holds every commit. */
async function holdsCommits(root: string, commits: readonly string[]) {
  try {
    for (const commit of commits)
      await sharedGit(root, ["cat-file", "-e", { rev: `${commit}^{commit}` }]);

    return true;
  } catch {
    return false;
  }
}

/** A checkout of the file's repository with every commit it reads at: the
 * receiver's own when they have one, else a checkout that already holds
 * every commit. */
async function shareRepository(
  input: ShareImport,
  remote: string | undefined,
  pins: Pick<Pins, "base" | "head"> | undefined,
  commits: string[],
  key: string,
) {
  const { store } = input;
  const all = [...(pins ? [pins.base, pins.head] : []), ...commits];

  const matches = remote ? store.checkoutsOfRemote(remote) : [];
  let repositoryId = matches[0];

  if (!repositoryId && all.length)
    for (const { id, path: root } of store.repositories())
      if (existsSync(root) && (await holdsCommits(root, all))) {
        repositoryId = id;
        break;
      }

  if (!repositoryId)
    throw new MissingCheckoutError(
      remote
        ? `Open a checkout of ${repositoryLabel(remote) ?? remote} in Whiteboard first, then open this file again.`
        : "Open a checkout of this whiteboard's repository in Whiteboard first, then open this file again.",
      remote,
    );

  // Only from the checkout's own origin, with its owner's credentials.
  await fetchSharedCommits(store.repositoryPath(repositoryId), all, key);

  return repositoryId;
}

/** A stand-in for the checkout of a file opened read-only: an empty folder
 * named after the repository, and the lines the file carries. */
async function readOnlyRepository(
  { store }: ShareImport,
  key: string,
  remote: string | undefined,
  bundle: ShareBundle,
) {
  const name = remote ? repositoryName(remote) : "whiteboard";

  const root = path.join(
    devReviewHome(),
    "read-only",
    key.slice(0, 16),
    safeStorageSegment(name),
  );

  await mkdir(root, { recursive: true, mode: 0o700 });

  const { id } = store.registerRepository(await realpath(root));

  store.excerpts.put(id, bundle.sources);

  return id;
}
