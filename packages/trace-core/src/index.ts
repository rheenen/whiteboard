// General utilities shared by the Whiteboard CLI and server, the hosted
// service login, and the cleanup of earlier builds' trace hooks.

export {
  DEFAULT_STORE_ORIGIN,
  readStoreAuth,
  clearStoreAuth,
  runStoreLogin,
  openUrlInBrowser,
  runStoreLogout,
  runStoreWhoami,
  writeStoreAuth,
} from "./store-auth";

export {
  HostedStoreDisabledError,
  hostedStoreDisabled,
  SHARING_DISABLED_ENV,
  SHARING_DISABLED_MARKER,
  sharingMarkerPath,
  writeSharingMarker,
  StoreApiError,
  StoreClient,
} from "./store-client";

export { shellQuote } from "./trace-command";

export {
  type CliInputStream,
  collectingWritable,
  jsonRequestedInArgv,
  type CliJsonEvent,
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
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

export { normalizeStoreOrigin } from "./store-origin";

export {
  type LegacyTraceHookRemoval,
  removeLegacyTraceHooks,
} from "./legacy-trace-hooks";
