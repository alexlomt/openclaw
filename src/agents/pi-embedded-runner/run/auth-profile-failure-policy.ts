import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  providerStarted?: boolean;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs, transport/server failures, missing-model responses, empty
  // responses, and request-shape ("format") rejections should not poison shared
  // provider auth health. These are route, endpoint, payload, or transcript-shape
  // signals rather than credential-health signals. Cascading them to a profile
  // cooldown blocks every other healthy session sharing the same auth profile and,
  // when all profiles share the same fault, takes down the entire provider for
  // the configured backoff window (#77228).
  if (
    params.policy === "local" ||
    !params.failoverReason ||
    params.failoverReason === "model_not_found" ||
    params.failoverReason === "server_error" ||
    params.failoverReason === "empty_response" ||
    params.failoverReason === "format"
  ) {
    return null;
  }
  if (params.failoverReason === "timeout" && params.providerStarted !== true) {
    return null;
  }
  return params.failoverReason;
}
