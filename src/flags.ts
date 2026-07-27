/**
 * TEMPORARY: build-time switches for the index experiments, resolved to literals
 * by the bundler so a disabled variant costs nothing at runtime (verified: the
 * minified build drops the branch entirely, and V8 folds the inlined `if (false)`
 * in the unminified one).
 *
 * They are compile-time rather than a runtime strategy object on purpose. A
 * pluggable index would make the scan loop's call site megamorphic across
 * variants, so every variant would be measured with dispatch overhead the winner
 * would never carry — the same effect that cost uFuzzy 17% in the old shared-
 * process bench. @see docs/measurement.md
 *
 * bench/variants.ts rewrites this file per build. Delete it, and every `if`
 * that reads it, once the experiments have picked a winner.
 */

/** Dispatch rescue variant families on which char classes the field is missing. */
export const MISSING_CLASS_DISPATCH: boolean = false;
