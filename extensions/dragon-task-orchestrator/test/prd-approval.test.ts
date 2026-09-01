/**
 * Tests for the pending PRD-confirmation store.
 *
 * The store is the rendezvous between the hook that awaits an answer and the
 * gateway call that supplies one, so the properties under test are the ones that
 * keep a turn from hanging or being settled twice.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPendingApproval,
  pendingApprovalCount,
  resetPrdApprovalStore,
  resolvePendingApproval,
} from "../src/prd-approval.js";

const ROOT = "agent:main:default";

afterEach(() => {
  resetPrdApprovalStore();
  vi.useRealTimers();
});

describe("createPendingApproval / resolvePendingApproval", () => {
  test("an answer resolves the awaited promise with the decision", async () => {
    const pending = createPendingApproval(ROOT, 10_000);
    expect(resolvePendingApproval(pending.approvalId, { decision: "confirm" })).toBe(true);
    await expect(pending.promise).resolves.toEqual({ decision: "confirm" });
  });

  test("an adjustment carries its text through", async () => {
    const pending = createPendingApproval(ROOT, 10_000);
    resolvePendingApproval(pending.approvalId, { decision: "adjust", adjustment: "把 2 和 3 合并" });
    await expect(pending.promise).resolves.toEqual({
      decision: "adjust",
      adjustment: "把 2 和 3 合并",
    });
  });

  test("an unknown id is reported rather than silently accepted", () => {
    expect(resolvePendingApproval("not-a-real-id", { decision: "confirm" })).toBe(false);
  });

  test("a second answer for the same id is rejected, so a double click cannot re-settle", async () => {
    const pending = createPendingApproval(ROOT, 10_000);
    expect(resolvePendingApproval(pending.approvalId, { decision: "confirm" })).toBe(true);
    expect(resolvePendingApproval(pending.approvalId, { decision: "cancel" })).toBe(false);
    await expect(pending.promise).resolves.toEqual({ decision: "confirm" });
  });

  test("distinct ids per call, so two sessions never collide", () => {
    const a = createPendingApproval("agent:main:userA", 10_000);
    const b = createPendingApproval("agent:main:userB", 10_000);
    expect(a.approvalId).not.toBe(b.approvalId);
    expect(pendingApprovalCount()).toBe(2);
  });

  test("answering removes the entry", () => {
    const pending = createPendingApproval(ROOT, 10_000);
    expect(pendingApprovalCount()).toBe(1);
    resolvePendingApproval(pending.approvalId, { decision: "cancel" });
    expect(pendingApprovalCount()).toBe(0);
  });
});

describe("timeout", () => {
  test("resolves to null — distinct from a user cancel, so policy can decide", async () => {
    vi.useFakeTimers();
    const pending = createPendingApproval(ROOT, 5_000);
    vi.advanceTimersByTime(5_000);
    await expect(pending.promise).resolves.toBeNull();
    expect(pendingApprovalCount()).toBe(0);
  });

  test("an answered entry does not later fire its timeout", async () => {
    vi.useFakeTimers();
    const pending = createPendingApproval(ROOT, 5_000);
    resolvePendingApproval(pending.approvalId, { decision: "confirm" });
    vi.advanceTimersByTime(10_000);
    // Still the decision, not null: the timer was cleared when the entry settled.
    await expect(pending.promise).resolves.toEqual({ decision: "confirm" });
  });
});

describe("stale entries for the same session", () => {
  test("a new confirmation cancels the previous one on that session", async () => {
    const first = createPendingApproval(ROOT, 10_000);
    const second = createPendingApproval(ROOT, 10_000);
    // The abandoned hook must not be left awaiting forever.
    await expect(first.promise).resolves.toEqual({ decision: "cancel" });
    expect(pendingApprovalCount()).toBe(1);
    expect(resolvePendingApproval(second.approvalId, { decision: "confirm" })).toBe(true);
  });

  test("a pending confirmation on a different session is left alone", async () => {
    const other = createPendingApproval("agent:main:other", 10_000);
    createPendingApproval(ROOT, 10_000);
    expect(pendingApprovalCount()).toBe(2);
    expect(resolvePendingApproval(other.approvalId, { decision: "confirm" })).toBe(true);
    await expect(other.promise).resolves.toEqual({ decision: "confirm" });
  });
});

describe("resetPrdApprovalStore", () => {
  test("cancels everything pending so no test leaves a hanging promise", async () => {
    const pending = createPendingApproval(ROOT, 10_000);
    resetPrdApprovalStore();
    await expect(pending.promise).resolves.toEqual({ decision: "cancel" });
    expect(pendingApprovalCount()).toBe(0);
  });
});
