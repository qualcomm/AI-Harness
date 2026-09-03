// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for the delegation metadata store (task 2.4).
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  clearDelegationMeta,
  delegationMetaSize,
  getDelegationMeta,
  resetDelegationMetaStore,
  setDelegationMeta,
} from "../src/delegation-meta.js";

const KEY = "agent:coding:dtsub-abc123";
const META = { hopCount: 0, rootSessionKey: "agent:main:default", hintedAgentId: "coding" };

describe("delegation metadata store", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
  });

  test("round-trips metadata", () => {
    setDelegationMeta(KEY, META);
    expect(getDelegationMeta(KEY)).toEqual(META);
  });

  test("returns undefined for an unknown key", () => {
    expect(getDelegationMeta("agent:coding:dtsub-missing")).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(getDelegationMeta(undefined)).toBeUndefined();
  });

  test("clear removes the entry", () => {
    setDelegationMeta(KEY, META);
    clearDelegationMeta(KEY);
    expect(getDelegationMeta(KEY)).toBeUndefined();
  });

  test("an expired entry reads as absent", () => {
    setDelegationMeta(KEY, META, { ttlMs: 1000, nowMs: 0 });
    expect(getDelegationMeta(KEY, { nowMs: 500 })).toEqual(META);
    expect(getDelegationMeta(KEY, { nowMs: 1000 })).toBeUndefined();
  });

  test("expired entries are pruned rather than retained", () => {
    setDelegationMeta(KEY, META, { ttlMs: 1000, nowMs: 0 });
    expect(delegationMetaSize({ nowMs: 0 })).toBe(1);
    expect(delegationMetaSize({ nowMs: 2000 })).toBe(0);
  });

  test("writing prunes other expired entries so abandoned rows cannot accumulate", () => {
    setDelegationMeta("agent:a:dtsub-1", META, { ttlMs: 1000, nowMs: 0 });
    setDelegationMeta("agent:b:dtsub-2", META, { ttlMs: 1000, nowMs: 5000 });
    expect(delegationMetaSize({ nowMs: 5000 })).toBe(1);
  });

  test("distinct keys hold independent metadata", () => {
    setDelegationMeta("agent:a:dtsub-1", { ...META, hopCount: 1, hintedAgentId: "a" });
    setDelegationMeta("agent:b:dtsub-2", { ...META, hopCount: 2, hintedAgentId: "b" });
    expect(getDelegationMeta("agent:a:dtsub-1")?.hopCount).toBe(1);
    expect(getDelegationMeta("agent:b:dtsub-2")?.hintedAgentId).toBe("b");
  });

  test("rootSessionKey survives round-trip so forwarding stays rooted", () => {
    setDelegationMeta(KEY, { ...META, hopCount: 2, rootSessionKey: "agent:main:origin" });
    expect(getDelegationMeta(KEY)?.rootSessionKey).toBe("agent:main:origin");
  });
});
