// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Delegation metadata store — see design.md D1 and R2.
 *
 * Holds hopCount / rootSessionKey / hintedAgentId for in-flight delegations,
 * keyed by childSessionKey. Deliberately process-local and NOT part of any
 * message payload: these values drive recursion protection and session
 * isolation, so they must never be reachable by a model (docs, 19th revision).
 *
 * Concurrency: the host serializes `before_agent_reply` per parent session, so
 * no locking is needed. Entries are written by the delegating side just before
 * the call and read by the receiving side at hook entry.
 *
 * Cross-process caveat: if the receiving agent runs in a different process the
 * lookup misses. That degrades to marker-only recognition — skip decomposition,
 * execute in place, do not forward. Recursion protection survives; only
 * forwarding is lost. See session-key.ts `isSubtaskDelegationKey`.
 */

import type { DelegationMeta } from "./types.js";

/**
 * TTL backstop so an abandoned entry (thrown request, process kept alive) cannot
 * leak indefinitely. Callers still clear entries explicitly on the normal path;
 * this only bounds the failure case.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

type Entry = { meta: DelegationMeta; expiresAt: number };

const store = new Map<string, Entry>();

/** Drop every expired entry. Called opportunistically on read/write. */
function pruneExpired(nowMs: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= nowMs) store.delete(key);
  }
}

export function setDelegationMeta(
  childSessionKey: string,
  meta: DelegationMeta,
  options?: { ttlMs?: number; nowMs?: number },
): void {
  const nowMs = options?.nowMs ?? Date.now();
  pruneExpired(nowMs);
  store.set(childSessionKey, {
    meta,
    expiresAt: nowMs + (options?.ttlMs ?? DEFAULT_TTL_MS),
  });
}

/** Look up metadata, treating an expired entry as absent. */
export function getDelegationMeta(
  childSessionKey: string | undefined,
  options?: { nowMs?: number },
): DelegationMeta | undefined {
  if (!childSessionKey) return undefined;
  const entry = store.get(childSessionKey);
  if (!entry) return undefined;
  const nowMs = options?.nowMs ?? Date.now();
  if (entry.expiresAt <= nowMs) {
    store.delete(childSessionKey);
    return undefined;
  }
  return entry.meta;
}

/** Remove one entry. Called once the delegated run has been awaited. */
export function clearDelegationMeta(childSessionKey: string): void {
  store.delete(childSessionKey);
}

/** Test hook: wipe all state. */
export function resetDelegationMetaStore(): void {
  store.clear();
}

/** Test hook: current entry count (after pruning). */
export function delegationMetaSize(options?: { nowMs?: number }): number {
  pruneExpired(options?.nowMs ?? Date.now());
  return store.size;
}
