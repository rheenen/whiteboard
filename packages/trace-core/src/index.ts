// General utilities shared by the Whiteboard CLI and server, and the cleanup
// of earlier builds' trace hooks.

export { shellQuote } from "./trace-command";

export {
  type CliInputStream,
  collectingWritable,
  jsonRequestedInArgv,
  type CliJsonEvent,
  type CliJsonOutput,
  emitJsonEvent,
  humanStream,
} from "./cli-output";

export { DEV_REVIEW_HOME_ENV, devReviewHome } from "./trace-home";

export { findPackageRoot } from "./package-root";

export {
  liveLockOwner,
  pidReused,
  processIsAlive,
  processStartIdentity,
  withFileLock,
} from "./with-file-lock";

export {
  writeFileAtomic,
  writeFileAtomicAsync,
  writePrivateJsonAtomic,
} from "./atomic-write";

export { errorMessage } from "./error-message";

export {
  type LegacyTraceHookRemoval,
  removeLegacyTraceHooks,
} from "./legacy-trace-hooks";
