/**
 * Pending PRD-confirmation store.
 *
 * WHY THIS SHAPE
 *
 * The confirmation gate works by having `before_agent_reply` simply AWAIT the
 * user's answer. That is only viable because the host applies no timeout to
 * plugin hooks (there is no timeout/race in `src/plugins/hooks.ts`), so the turn
 * can legitimately stay in flight while the operator looks at the card. It also
 * means no cross-turn state is needed: one pending entry lives exactly as long as
 * one hook invocation.
 *
 * The answer arrives on a completely different path from the one that is waiting
 * — the Control UI calls this plugin's own registered gateway method (see
 * index.ts), which lands on a different call stack. This store is the rendezvous
 * point between the two, holding the `resolve` of the promise the hook awaits.
 *
 * Process-local and never persisted, matching delegation-meta.ts and the
 * "PRD 载体…不落盘" decision in docs/verifier-prd-progress-plan.md.
 */

import { randomUUID } from "node:crypto";

/** What the operator decided about a proposed decomposition. */
export type PrdDecision = "confirm" | "cancel" | "adjust";

export type PrdApprovalOutcome = {
  decision: PrdDecision;
  /** Free-text adjustment request; only meaningful for `decision: "adjust"`. */
  adjustment?: string;
};

type Entry = {
  rootSessionKey: string;
  /** Settles the promise the awaiting hook holds. */
  settle: (outcome: PrdApprovalOutcome | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const store = new Map<string, Entry>();

/**
 * Finish an entry exactly once: drop it from the store and clear its timer
 * before settling, so a late duplicate resolve (double-click, retry) cannot
 * settle the same promise twice and a resolved entry cannot still fire its
 * timeout.
 */
function settleEntry(approvalId: string, outcome: PrdApprovalOutcome | null): boolean {
  const entry = store.get(approvalId);
  if (!entry) return false;
  store.delete(approvalId);
  clearTimeout(entry.timer);
  entry.settle(outcome);
  return true;
}

/**
 * Register a pending confirmation for `rootSessionKey` and return the id to
 * publish plus the promise to await.
 *
 * Resolves to `null` on timeout — a distinct value from every real decision, so
 * the caller can apply its configured timeout policy rather than having to guess
 * whether "cancel" came from the user or from the clock.
 *
 * Any still-pending entry for the same session is cancelled first. Sessions are
 * serialized per turn, so an older entry can only exist if its hook is gone
 * (abandoned turn); leaving it would keep a dead promise and its timer alive, and
 * would let a stale card resolve a confirmation nobody is waiting on.
 */
export function createPendingApproval(
  rootSessionKey: string,
  timeoutMs: number,
): { approvalId: string; promise: Promise<PrdApprovalOutcome | null> } {
  for (const [id, entry] of store) {
    if (entry.rootSessionKey === rootSessionKey) {
      settleEntry(id, { decision: "cancel" });
    }
  }

  const approvalId = randomUUID();
  let settle!: (outcome: PrdApprovalOutcome | null) => void;
  const promise = new Promise<PrdApprovalOutcome | null>((resolve) => {
    settle = resolve;
  });

  // `unref` so a pending confirmation never keeps the process alive on its own.
  const timer = setTimeout(() => settleEntry(approvalId, null), timeoutMs);
  timer.unref?.();

  store.set(approvalId, { rootSessionKey, settle, timer });
  return { approvalId, promise };
}

/**
 * Answer a pending confirmation. Returns false when `approvalId` is unknown —
 * already answered, or timed out — which the gateway handler reports back so the
 * UI can say so instead of appearing to succeed.
 */
export function resolvePendingApproval(
  approvalId: string,
  outcome: PrdApprovalOutcome,
): boolean {
  return settleEntry(approvalId, outcome);
}

/** Test hook: cancel everything pending and wipe the store. */
export function resetPrdApprovalStore(): void {
  for (const id of [...store.keys()]) {
    settleEntry(id, { decision: "cancel" });
  }
  store.clear();
}

/** Test hook: number of confirmations currently awaiting an answer. */
export function pendingApprovalCount(): number {
  return store.size;
}
