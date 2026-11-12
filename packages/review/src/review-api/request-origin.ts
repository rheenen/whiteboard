/** The Ask thread a request comes from. The CLI reads it from ASK_THREAD_ENV,
 * which Desktop sets for the thread's agent. */
export const REVIEW_THREAD_HEADER = "x-review-thread";

export const ASK_THREAD_ENV = "DEV_REVIEW_ASK_THREAD";

/** Set by Desktop and the canvas on a command a person gave, such as a new
 * board from the sidebar; its version is credited to them. */
export const REVIEW_PERSON_HEADER = "x-review-person";
