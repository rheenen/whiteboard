import { readFile } from "node:fs/promises";
import path from "node:path";

import { shareBundleSchema } from "@dev.fast/review-share-protocol";
import { ReviewInputError } from "@dev.fast/whiteboard-document";
import type { LocalReviewData } from "@review/review-api/local-data.js";
import type { ReviewStore } from "@review/review-api/store.js";
import { readBoundedRequestJson } from "@review/server/hono-http.js";
import type { Hono } from "hono";
import { z } from "zod";

import { exportShare, validateShareSources } from "./export.js";
import {
  parseWhiteboardFile,
  whiteboardFileKey,
  whiteboardFileName,
  whiteboardFileText,
} from "./file.js";
import {
  MissingCheckoutError,
  type ShareImport,
  importShare,
  needsRepository,
} from "./import.js";
import {
  cloneForReader,
  readShareRepository,
  repositoryName,
} from "./repository.js";

const publishSchema = z.strictObject({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  requestId: z.uuid().optional(),
});

interface SharingHostOptions {
  readRepository?: typeof readShareRepository;
  remoteShare?: RemoteShare;
}

const importSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  /** Open without a checkout, on the lines the file carries. */
  readOnly: z.boolean().optional(),
});

const cloneSchema = z.strictObject({
  url: z.string().min(1).max(2048),
  /** The folder to clone into, and the new folder's name in it. */
  parent: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
});

interface ImportStatus {
  stage: "reading" | "fetching" | "validating" | "ready" | "error";
  /** The copy, once it is made. */
  reviewId?: string;
  error?: string;
  /** The file needs a checkout of this repository; Desktop offers to clone
   * it, or to open the file read-only. */
  missingCheckout?: { remote?: string; name: string };
}

/** Exports and opens `.whiteboard` files. Mounted behind local host
 * authentication. */
export function mountSharingHost(
  app: Hono,
  store: ReviewStore,
  data: LocalReviewData,
  options: SharingHostOptions = {},
) {
  mountSharingPublisher(app, store, data, options);

  const imports = new Map<string, ImportStatus>();

  // One import at a time, so two files of one repository fetch it once.
  let importing = Promise.resolve();

  const serially = (task: () => Promise<string>) => {
    const run = importing.then(task);

    importing = run.then(
      () => {},
      () => {},
    );

    return run;
  };

  app.get("/sharing/import/:id", (context) => {
    const id = context.req.param("id");

    const { reviewId = id, ...status } = imports.get(id) ?? {
      stage: "error" as const,
      error: "This whiteboard file is not being opened.",
    };

    return context.json({
      reviewId,
      ...status,
      ...(status.stage === "ready" && { title: store.read(reviewId).title }),
    });
  });

  const shareInput = (onStage: ShareImport["onStage"]): ShareImport => ({
    store,
    data,
    onStage,
  });

  // The remotes a file asked for, the only ones Desktop may clone here.
  const offeredRemotes = new Set<string>();

  const startImport = (
    id: string,
    receive: (onStage: ShareImport["onStage"]) => Promise<string>,
  ) => {
    const known = imports.get(id)?.stage;

    // A finished import may run again: the file may have changed.
    if (!known || known === "ready" || known === "error") {
      const status: ImportStatus = { stage: "reading" };

      imports.set(id, status);
      receive((stage) => {
        status.stage = stage;
      })
        .then((reviewId) => {
          status.reviewId = reviewId;
          status.stage = "ready";
        })
        .catch((error) => {
          status.stage = "error";

          if (error instanceof MissingCheckoutError) {
            if (error.remote) offeredRemotes.add(error.remote);
            status.missingCheckout = {
              ...(error.remote && { remote: error.remote }),
              name: error.remote ? repositoryName(error.remote) : "repository",
            };
          }

          status.error =
            error instanceof ReviewInputError
              ? error.message
              : "This whiteboard file could not be read.";
        });
    }

    const { reviewId: _reviewId, ...status } = imports.get(id)!;

    return { reviewId: id, ...status };
  };

  /** Clones a repository a file asked for into a folder the reader chose,
   * and opens it in Whiteboard. */
  app.post("/sharing/clone", async (context) => {
    const input = cloneSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!offeredRemotes.has(input.url))
      throw new ReviewInputError(
        "Open the whiteboard file again, then clone its repository.",
        409,
      );

    if (!path.isAbsolute(input.parent))
      throw new ReviewInputError("Use an absolute folder path.", 400);

    const root = await cloneForReader(input.parent, input.name, input.url);
    const repository = await data.register(root);

    return context.json({ path: root, repositoryId: repository.id });
  });

  app.post("/sharing/import", async (context) => {
    const input = importSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!path.isAbsolute(input.path))
      throw new ReviewInputError("Use an absolute file path.", 400);

    const text = await readFile(input.path, "utf8").catch(() => {
      throw new ReviewInputError(
        `Could not read ${path.basename(input.path)}. Check that the file still exists and Whiteboard can open it.`,
        400,
      );
    });

    // A read-only copy is its own: a later import on a checkout makes
    // an ordinary one.
    const key = `${whiteboardFileKey(text)}${input.readOnly ? ":read-only" : ""}`;
    const copy = () => store.copiesOf(key)[0]?.reviewId;

    return context.json(
      startImport(
        key,
        async (onStage) =>
          copy() ??
          serially(
            async () =>
              copy() ??
              importShare(
                {
                  ...shareInput(onStage),
                  readOnly: input.readOnly,
                },
                key,
                parseWhiteboardFile(text),
              ),
          ),
      ),
      202,
    );
  });
}

const preparedShareSchema = z.strictObject({
  title: z.string(),
  version: z.number().int().nonnegative(),
  bundle: shareBundleSchema,
  needsRepository: z.boolean(),
});

type PreparedShare = z.infer<typeof preparedShareSchema>;

/** `undefined` for a board on this machine. */
export type RemoteShare = (
  input: z.infer<typeof publishSchema>,
) => Promise<PreparedShare> | undefined;

export function remoteShare(
  isRemote: (reviewId: string) => boolean,
  fetch: (request: Request) => Response | Promise<Response>,
): RemoteShare {
  return ({ reviewId, version }) =>
    isRemote(reviewId)
      ? (async () => {
          const response = await fetch(
            new Request(
              `http://whiteboard/reviews-api/${encodeURIComponent(reviewId)}/share-bundle`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ version }),
              },
            ),
          );

          const body: unknown = await response.json().catch(() => undefined);

          if (!response.ok)
            throw new ReviewInputError(
              z.object({ error: z.string() }).safeParse(body).data?.error ??
                "Could not read the board from its host.",
              response.status === 400 ? 400 : 409,
            );

          return preparedShareSchema.parse(body);
        })()
      : undefined;
}

/** Exporting needs only an authored store, never Desktop or recipient workspaces. */
export function mountSharingPublisher(
  app: Hono,
  store: ReviewStore,
  data: LocalReviewData,
  options: Pick<SharingHostOptions, "readRepository" | "remoteShare"> = {},
) {
  const prepareLocal = async (
    input: z.infer<typeof publishSchema>,
  ): Promise<PreparedShare> => {
    const snapshot = store.read(input.reviewId, input.version);

    if (snapshot.target?.kind !== "worktree") validateShareSources(snapshot);

    const repositoryId =
      snapshot.pins?.repositoryId ?? snapshot.target?.repositoryId;

    const root = repositoryId ? store.repositoryPath(repositoryId) : undefined;

    // Recipients learn about unpushed commits when they fetch them.
    const repository = root
      ? (options.readRepository ?? readShareRepository)(root).catch(
          () => undefined,
        )
      : undefined;

    const bundle = await exportShare({
      store,
      data,
      reviewId: snapshot.reviewId,
      version: snapshot.version,
    });

    const verified = await repository;

    if (verified) Object.assign(bundle, verified);

    return {
      title: snapshot.title,
      version: snapshot.version,
      bundle,
      needsRepository: needsRepository(bundle, snapshot),
    };
  };

  const prepare = (input: z.infer<typeof publishSchema>) =>
    options.remoteShare?.(input) ?? prepareLocal(input);

  // A remote board's host prepares it; Desktop writes the file.
  app.post("/:id/share-bundle", async (context) => {
    const { version } = publishSchema
      .pick({ version: true })
      .parse(await readBoundedRequestJson(context.req.raw));

    return context.json(
      await prepareLocal({ reviewId: context.req.param("id"), version }),
    );
  });
  app.post("/sharing/export", async (context) => {
    const { title, bundle, needsRepository } = await prepare(
      publishSchema.parse(await readBoundedRequestJson(context.req.raw)),
    );

    if (bundle.frozen)
      throw new ReviewInputError(
        "Commit your changes to export this whiteboard as a file.",
      );
    else if (!bundle.repository && !bundle.remote && needsRepository)
      throw new ReviewInputError(
        "Exporting pinned code needs an https or ssh origin remote the file's reader can fetch from.",
      );

    return context.json({
      filename: whiteboardFileName(title),
      text: whiteboardFileText(bundle),
    });
  });
}
