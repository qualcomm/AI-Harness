// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for child session key derivation (task 2.3).
 *
 * The key doubles as the delegation marker carrier, so these tests guard two
 * properties the recursion protection depends on: derivation is rooted at the
 * chain root (no "hash of a hash"), and the marker is recognizable.
 */

import { describe, expect, test } from "vitest";
import {
  childSessionKeyFor,
  CLASSIFIER_AGENT_ID,
  classifierSessionKeyFor,
  DECOMPOSER_AGENT_ID,
  decomposerSessionKeyFor,
  INTERNAL_AGENT_IDS,
  isClassifierSessionKey,
  isSubtaskDelegationKey,
  SUBTASK_KEY_MARKER,
  SUMMARIZER_AGENT_ID,
  summarizerSessionKeyFor,
  verifierSessionKeyFor,
} from "../src/session-key.js";

const ROOT = "agent:main:default";

describe("childSessionKeyFor", () => {
  test("is stable for the same (root, agent) pair", () => {
    expect(childSessionKeyFor(ROOT, "coding")).toBe(childSessionKeyFor(ROOT, "coding"));
  });

  test("differs per target agent under the same root", () => {
    expect(childSessionKeyFor(ROOT, "coding")).not.toBe(childSessionKeyFor(ROOT, "research"));
  });

  test("differs per root for the same target agent", () => {
    expect(childSessionKeyFor("agent:main:userA", "coding")).not.toBe(
      childSessionKeyFor("agent:main:userB", "coding"),
    );
  });

  test("embeds the target agent id so the key names its actual user", () => {
    expect(childSessionKeyFor(ROOT, "coding")).toMatch(/^agent:coding:/);
  });

  test("carries the subtask marker", () => {
    expect(childSessionKeyFor(ROOT, "coding")).toContain(SUBTASK_KEY_MARKER);
  });

  test("uses a 128-bit (32 hex char) digest", () => {
    const key = childSessionKeyFor(ROOT, "coding");
    const digest = key.slice(key.indexOf(SUBTASK_KEY_MARKER) + SUBTASK_KEY_MARKER.length);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  test("converges on the chain root, not the previous hop (no hash of a hash)", () => {
    // A -> B -> C and A -> C must land on the same child session for C, because
    // every hop derives from the chain root rather than the key it received.
    const hop1 = childSessionKeyFor(ROOT, "research");
    const viaTwoHops = childSessionKeyFor(ROOT, "coding"); // forwarded, still rooted at ROOT
    const direct = childSessionKeyFor(ROOT, "coding");
    expect(viaTwoHops).toBe(direct);
    // And deriving from the hop key instead would NOT converge — guard the mistake.
    expect(childSessionKeyFor(hop1, "coding")).not.toBe(direct);
  });

  test("bounds the child session set to root x agent count", () => {
    const agents = ["coding", "research", "writing", "default"];
    const keys = new Set(agents.map((a) => childSessionKeyFor(ROOT, a)));
    expect(keys.size).toBe(agents.length);
    // Repeated derivations add nothing new.
    for (const a of agents) childSessionKeyFor(ROOT, a);
    expect(new Set(agents.map((a) => childSessionKeyFor(ROOT, a))).size).toBe(agents.length);
  });
});

describe("verifierSessionKeyFor", () => {
  test("differs from childSessionKeyFor for the same (root, agent) pair", () => {
    expect(verifierSessionKeyFor(ROOT, "coding")).not.toBe(childSessionKeyFor(ROOT, "coding"));
  });

  test("is stable for the same (root, agent) pair", () => {
    expect(verifierSessionKeyFor(ROOT, "coding")).toBe(verifierSessionKeyFor(ROOT, "coding"));
  });

  test("still satisfies isSubtaskDelegationKey", () => {
    expect(isSubtaskDelegationKey(verifierSessionKeyFor(ROOT, "coding"))).toBe(true);
  });
});

describe("isSubtaskDelegationKey", () => {
  test("recognizes a derived key", () => {
    expect(isSubtaskDelegationKey(childSessionKeyFor(ROOT, "coding"))).toBe(true);
  });

  test("rejects an ordinary agent session key", () => {
    expect(isSubtaskDelegationKey("agent:main:default")).toBe(false);
  });

  test("rejects undefined and empty input", () => {
    expect(isSubtaskDelegationKey(undefined)).toBe(false);
    expect(isSubtaskDelegationKey("")).toBe(false);
  });

  test("does not match the marker appearing in a non-trailing segment", () => {
    // A peer id that happens to contain the marker must not be read as a delegation.
    expect(isSubtaskDelegationKey("agent:main:dtsub-fake:peer")).toBe(false);
  });
});

describe("internal one-shot session keys", () => {
  const CASES = [
    ["decomposerSessionKeyFor", decomposerSessionKeyFor, DECOMPOSER_AGENT_ID],
    ["classifierSessionKeyFor", classifierSessionKeyFor, CLASSIFIER_AGENT_ID],
    ["summarizerSessionKeyFor", summarizerSessionKeyFor, SUMMARIZER_AGENT_ID],
  ] as const;

  for (const [name, derive, agentId] of CASES) {
    describe(name, () => {
      test("is stable for the same root", () => {
        expect(derive(ROOT)).toBe(derive(ROOT));
      });

      test("differs per root", () => {
        expect(derive("agent:main:userA")).not.toBe(derive("agent:main:userB"));
      });

      test("embeds its dedicated agent id", () => {
        expect(derive(ROOT)).toMatch(new RegExp(`^agent:${agentId}:`));
      });

      test("is recognized as an internal session, exempting it from decomposition", () => {
        expect(isClassifierSessionKey(derive(ROOT))).toBe(true);
      });

      test("is not mistaken for a subtask delegation", () => {
        expect(isSubtaskDelegationKey(derive(ROOT))).toBe(false);
      });

      test("never collides with a worker delegation to the same agent id", () => {
        expect(derive(ROOT)).not.toBe(childSessionKeyFor(ROOT, agentId));
      });
    });
  }

  test("the three purposes never share a session under one root", () => {
    const keys = new Set(CASES.map(([, derive]) => derive(ROOT)));
    expect(keys.size).toBe(CASES.length);
  });
});

describe("INTERNAL_AGENT_IDS", () => {
  test("covers every id the plugin uses for its own model calls", () => {
    expect([...INTERNAL_AGENT_IDS].sort()).toEqual(
      [DECOMPOSER_AGENT_ID, CLASSIFIER_AGENT_ID, SUMMARIZER_AGENT_ID].sort(),
    );
  });
});


describe("classifierSessionKeyFor discriminator", () => {
  // Regression: all routing classifications shared one session key, so the host's
  // per-session queue serialized a Promise.all. Observed on a 3-subtask request:
  // the 2nd and 3rd calls waited 30s and 39s for nothing.
  test("different discriminators yield different sessions, so calls can run concurrently", () => {
    const a = classifierSessionKeyFor(ROOT, "0");
    const b = classifierSessionKeyFor(ROOT, "1");
    expect(a).not.toBe(b);
  });

  test("the same discriminator is stable", () => {
    expect(classifierSessionKeyFor(ROOT, "0")).toBe(classifierSessionKeyFor(ROOT, "0"));
  });

  test("omitting it keeps the original single-session key", () => {
    expect(classifierSessionKeyFor(ROOT)).toBe(classifierSessionKeyFor(ROOT));
    // And is distinct from any discriminated one, so a lone classification never
    // collides with per-subtask routing.
    expect(classifierSessionKeyFor(ROOT)).not.toBe(classifierSessionKeyFor(ROOT, "0"));
  });

  test("still carries the classifier agent id and internal marker", () => {
    const key = classifierSessionKeyFor(ROOT, "7");
    expect(key).toMatch(new RegExp(`^agent:${CLASSIFIER_AGENT_ID}:`));
    expect(isClassifierSessionKey(key)).toBe(true);
    expect(isSubtaskDelegationKey(key)).toBe(false);
  });

  test("discriminated keys stay distinct across roots", () => {
    expect(classifierSessionKeyFor("agent:main:a", "0")).not.toBe(
      classifierSessionKeyFor("agent:main:b", "0"),
    );
  });
});

describe("per-subtask child and verifier sessions", () => {
  // Regression: same-agent subtasks shared one child session, and every verification
  // shared one verifier session. The host queues per session, so both collapsed
  // concurrency into a queue — a layer with two `research` subtasks took 5m45s where
  // ~3m of concurrent work was available.
  test("childSessionKeyFor separates subtasks on the same agent", () => {
    const a = childSessionKeyFor(ROOT, "research", 0);
    const b = childSessionKeyFor(ROOT, "research", 1);
    expect(a).not.toBe(b);
    // Still names the agent that runs it, and still carries the delegation marker.
    expect(a).toMatch(/^agent:research:/);
    expect(isSubtaskDelegationKey(a)).toBe(true);
  });

  test("verifierSessionKeyFor separates verifications for different subtasks", () => {
    const a = verifierSessionKeyFor(ROOT, "coding", 0);
    const b = verifierSessionKeyFor(ROOT, "coding", 1);
    expect(a).not.toBe(b);
    expect(isSubtaskDelegationKey(a)).toBe(true);
  });

  test("a subtask's worker and verifier sessions never collide", () => {
    // Both can resolve to the same agent id (defaultAgentId), so the `:verify:` salt
    // still has to hold with the subtask discriminator in play.
    expect(childSessionKeyFor(ROOT, "coding", 0)).not.toBe(verifierSessionKeyFor(ROOT, "coding", 0));
  });

  test("both stay stable for the same inputs", () => {
    expect(childSessionKeyFor(ROOT, "coding", 2)).toBe(childSessionKeyFor(ROOT, "coding", 2));
    expect(verifierSessionKeyFor(ROOT, "coding", 2)).toBe(verifierSessionKeyFor(ROOT, "coding", 2));
  });

  test("omitting the id keeps the original reuse-by-agent key", () => {
    // The re-routing hop in hooks.ts relies on this: it forwards one already-running
    // subtask and must land on the agent's shared key, not invent a new session.
    expect(childSessionKeyFor(ROOT, "coding")).toBe(childSessionKeyFor(ROOT, "coding"));
    expect(childSessionKeyFor(ROOT, "coding")).not.toBe(childSessionKeyFor(ROOT, "coding", 0));
    expect(verifierSessionKeyFor(ROOT, "coding")).not.toBe(verifierSessionKeyFor(ROOT, "coding", 0));
  });

  test("the session set stays bounded by subtask count", () => {
    const keys = new Set([0, 1, 2, 3].map((id) => childSessionKeyFor(ROOT, "coding", id)));
    expect(keys.size).toBe(4);
    // Repeated derivation adds nothing.
    for (const id of [0, 1, 2, 3]) childSessionKeyFor(ROOT, "coding", id);
    expect(new Set([0, 1, 2, 3].map((id) => childSessionKeyFor(ROOT, "coding", id))).size).toBe(4);
  });
});
