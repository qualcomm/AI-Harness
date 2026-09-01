/**
 * Child session key derivation — see design.md D1.
 *
 * WHY THIS EXISTS
 *
 * The planning docs (19th revision) impose a hard constraint: the delegation
 * metadata used for recursion protection must be "transport-layer information
 * set directly by host-side orchestration as structured parameters, never
 * derived from model-generated text or tool-call output" — otherwise a
 * downstream agent hit by indirect prompt injection could reset hopCount or
 * forge rootSessionKey and bypass the whole protection.
 *
 * `SubagentRunParams` has no field for custom metadata (see runtime-contract.ts).
 * So the only carrier that satisfies the constraint is one the host already
 * owns and the model cannot reach: the session key itself. This module encodes
 * the "this is a subtask delegation" marker into the child session key, and
 * delegation-meta.ts holds the numeric metadata keyed by that same key.
 *
 * Derivation shape mirrors the host's `buildAgentMainSessionKey`
 * (`agent:<agentId>:<mainKey>`) so keys stay recognizable to the host, with a
 * `dtsub-` prefixed hash segment as the marker.
 */

import { createHash } from "node:crypto";

/**
 * Marker prefix on the hash segment. Its presence in a session key IS the
 * "isSubtaskDelegation" signal — it cannot be forged by a model because the
 * model never sees or sets its own session key.
 */
export const SUBTASK_KEY_MARKER = "dtsub-";

/**
 * Hash digest length in hex chars. 32 hex chars = 128 bit, matching the length
 * the docs' 3rd revision settled on after noting that truncating SHA-256 too
 * aggressively degrades collision resistance. At the child-session volume this
 * plugin produces (top-level session x known agent count) 128 bit is ample.
 */
const DIGEST_HEX_LENGTH = 32;

/**
 * Derive the child session key for delegating to `targetAgentId` within the
 * delegation chain rooted at `rootSessionKey`.
 *
 * Always derived from the CHAIN ROOT, never from the previous hop's key. Hashing
 * a hop's key would produce "a hash of a hash", making the same target agent
 * reachable under different keys depending on the path taken — which would
 * reintroduce the unbounded child-session growth the reuse-by-agent design
 * exists to avoid. Rooting every derivation converges the set to
 * "top-level session x known agent count".
 *
 * `subtaskId` opts one delegation out of that reuse so same-agent subtasks in a
 * layer can run CONCURRENTLY. Sharing one session is what forced them to be
 * serialized (see pipeline.ts): the host queues per session — `resolveSessionLane`
 * keys its lane on the session key, not the agent — so two subtasks on one key were
 * unavoidably sequential. Measured cost of that: a layer with two `research`
 * subtasks took 5m45s where ~3m of concurrent work was available.
 *
 * The bound becomes "top-level session x subtasks in flight" instead of
 * "x known agent count". That is still bounded, because `maxSubtasks` caps it.
 *
 * Omit it for the re-routing hop (hooks.ts), which forwards one already-running
 * subtask and has no sibling to race with.
 */
export function childSessionKeyFor(
  rootSessionKey: string,
  targetAgentId: string,
  subtaskId?: number,
): string {
  const digest = createHash("sha256")
    .update(
      subtaskId === undefined
        ? `${rootSessionKey}:${targetAgentId}`
        : `${rootSessionKey}:${targetAgentId}:subtask:${subtaskId}`,
    )
    .digest("hex")
    .slice(0, DIGEST_HEX_LENGTH);
  return `agent:${targetAgentId}:${SUBTASK_KEY_MARKER}${digest}`;
}

/**
 * Derive the verifier session key for `verifierAgentId` within the delegation
 * chain rooted at `rootSessionKey`.
 *
 * Salted with `:verify:` so it never collides with `childSessionKeyFor`'s key
 * for the same agentId — necessary because the verifier's identity is
 * `cfg.defaultAgentId`, which a worker subtask can also be routed to. Without
 * this salt both would hash to the identical session key and the worker's own
 * session history would be mixed with the verifier's judgment turns. The
 * `dtsub-` marker prefix is preserved so `isSubtaskDelegationKey` still
 * recognizes it for recursion protection.
 *
 * `subtaskId` separates concurrent verifications for the same reason
 * `childSessionKeyFor` takes one: the verifier identity is always a single agent
 * (`defaultAgentId`), so every verify in a layer landed on ONE session and the
 * host queued them. Without this, making workers parallel just moves the
 * bottleneck to verification.
 */
export function verifierSessionKeyFor(
  rootSessionKey: string,
  verifierAgentId: string,
  subtaskId?: number,
): string {
  const digest = createHash("sha256")
    .update(
      subtaskId === undefined
        ? `${rootSessionKey}:verify:${verifierAgentId}`
        : `${rootSessionKey}:verify:${verifierAgentId}:subtask:${subtaskId}`,
    )
    .digest("hex")
    .slice(0, DIGEST_HEX_LENGTH);
  return `agent:${verifierAgentId}:${SUBTASK_KEY_MARKER}${digest}`;
}

/**
 * Whether `sessionKey` denotes a subtask delegation created by this plugin.
 *
 * This is the fail-safe half of recursion protection: even when the metadata
 * map lookup misses (different process — see design.md R2), recognizing the
 * marker is enough to skip the decomposition decision and execute in place.
 * Losing forwarding is acceptable; losing recursion protection is not.
 */
export function isSubtaskDelegationKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  const segments = sessionKey.split(":");
  // Only the trailing segment carries the marker; a peer id containing
  // "dtsub-" elsewhere must not be mistaken for a delegation.
  const last = segments[segments.length - 1];
  return segments.length >= 3 && last !== undefined && last.startsWith(SUBTASK_KEY_MARKER);
}

/**
 * Marker prefix for the orchestrator's own one-shot model-call sessions
 * (decompose / classify / summarize). Distinct from SUBTASK_KEY_MARKER so
 * `isSubtaskDelegationKey` never mistakes these orchestrator-internal calls for
 * a subtask delegation — they are the orchestrator's own judgment calls, not a
 * hand-off to another agent.
 */
const CLASSIFIER_KEY_MARKER = "dtcls-";

/**
 * Dedicated agent ids for the orchestrator's three one-shot model calls.
 *
 * WHY EACH CALL NEEDS ITS OWN IDENTITY
 *
 * The host's only true full-system-prompt-override mechanism is
 * `resolveSystemPromptOverride`, which short-circuits `buildEmbeddedSystemPrompt`
 * entirely (see attempt.ts) — but it is keyed by AGENT ID and read from static
 * config (`agents.list[].systemPromptOverride`). A single shared identity could
 * therefore only carry ONE static prompt, while these three calls need three
 * different ones. Passing them per-call via `extraSystemPrompt` is the mechanism
 * this replaces: that only APPENDS to the ~31K-char default prompt, which in
 * practice buried the "return ONLY JSON" instruction and had the model answer the
 * request with real tools instead.
 *
 * Each id must also be configured with `tools: { deny: ["*"] }`: an override
 * replaces prompt TEXT only, while the tool list is handed to the model
 * separately, so without the deny these agents keep web_fetch/write and can still
 * go off and perform the request. Note `allow: []` does NOT work for this — an
 * empty allowlist is read as "unrestricted" (see host tool-policy-match.ts).
 */
export const DECOMPOSER_AGENT_ID = "dt-decomposer";
export const CLASSIFIER_AGENT_ID = "dt-classifier";
export const SUMMARIZER_AGENT_ID = "dt-summarizer";

/**
 * Every agent id this plugin owns for its own internal model calls.
 *
 * Callers deriving the routable-agent set (index.ts `getKnownAgentIds` /
 * `getAgentDescriptions`) MUST exclude all of these. They exist only to carry a
 * system prompt override and have no tools, so routing a real subtask to one
 * would produce a guaranteed failure that is very hard to trace back.
 */
export const INTERNAL_AGENT_IDS: ReadonlySet<string> = new Set([
  DECOMPOSER_AGENT_ID,
  CLASSIFIER_AGENT_ID,
  SUMMARIZER_AGENT_ID,
]);

/**
 * Derive an internal one-shot call's session key.
 *
 * Rooted at the chain root (like childSessionKeyFor) so repeated calls within one
 * request converge on a single reused session instead of growing unbounded, and
 * salted per `purpose` so the three call types never share a session — sharing one
 * is what let a previous call's tool results accumulate as history and pollute the
 * next call's judgment. Keeps the `dtcls-` marker so `isClassifierSessionKey`
 * recognizes it and `before_agent_reply` skips reclassifying it (see hooks.ts).
 */
function internalSessionKeyFor(rootSessionKey: string, agentId: string, purpose: string): string {
  const digest = createHash("sha256")
    .update(`${rootSessionKey}:${purpose}`)
    .digest("hex")
    .slice(0, DIGEST_HEX_LENGTH);
  return `agent:${agentId}:${CLASSIFIER_KEY_MARKER}${digest}`;
}

export function decomposerSessionKeyFor(rootSessionKey: string): string {
  return internalSessionKeyFor(rootSessionKey, DECOMPOSER_AGENT_ID, "decompose");
}

/**
 * Session key for one routing classification.
 *
 * `discriminator` MUST differ per concurrent call, because the host serializes runs
 * per session: routing for N subtasks is issued with `Promise.all`, but a shared
 * session key collapsed that into a queue. Measured on a 3-subtask request, the
 * second and third calls waited 30s and 39s respectively for no reason — they are
 * independent one-shot judgments that share nothing.
 *
 * Passing no discriminator keeps the old single-session behaviour, which is correct
 * for a lone classification (the re-routing path in hooks.ts).
 */
export function classifierSessionKeyFor(rootSessionKey: string, discriminator?: string): string {
  return internalSessionKeyFor(
    rootSessionKey,
    CLASSIFIER_AGENT_ID,
    discriminator === undefined ? "classify" : `classify:${discriminator}`,
  );
}

export function summarizerSessionKeyFor(rootSessionKey: string): string {
  return internalSessionKeyFor(rootSessionKey, SUMMARIZER_AGENT_ID, "summarize");
}

/**
 * Whether `sessionKey` belongs to one of the orchestrator's own one-shot calls.
 *
 * Needed so `before_agent_reply` does not recurse: without this check, a
 * decompose/classify/summarize turn would itself be decomposed, splitting the
 * orchestrator's own output and potentially looping. Recognized the same way as
 * isSubtaskDelegationKey — by the marker on the trailing segment, which the model
 * never sees or sets.
 */
export function isClassifierSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  const segments = sessionKey.split(":");
  const last = segments[segments.length - 1];
  return segments.length >= 3 && last !== undefined && last.startsWith(CLASSIFIER_KEY_MARKER);
}
