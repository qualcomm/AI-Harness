// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for the PRD confirmation gate in handleDecomposedRequest.
 *
 * The gate holds a turn open while an operator answers, so these tests pin down
 * what runs before the answer (nothing), what each answer does, and that every
 * path terminates — a bug here hangs a real conversation rather than just
 * returning the wrong text.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetDelegationMetaStore } from "../src/delegation-meta.js";
import { handleDecomposedRequest } from "../src/orchestrator.js";
import {
  pendingApprovalCount,
  resetPrdApprovalStore,
  resolvePendingApproval,
} from "../src/prd-approval.js";
import type { SubagentRuntime } from "../src/runtime-contract.js";
import type { SubtaskPlan } from "../src/types.js";
import { testConfig } from "./test-helpers.js";

const decomposeTask = vi.fn();
// resolveAgentForSubtask is replaced so routing never makes a real model call;
// decomposeTask is replaced so the re-decomposition on "adjust" is observable.
// importOriginal keeps parseJsonObject intact, which verify.ts imports.
vi.mock("../src/resolve-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-agent.js")>()),
  resolveAgentForSubtask: vi.fn(async () => "coding"),
  decomposeTask: (...args: unknown[]) => decomposeTask(...args),
}));

/** True for the structure-only broadcast published before routing resolves. */
function isPreRouting(payload: Record<string, unknown>): boolean {
  const subtasks = payload.subtasks;
  return (
    Array.isArray(subtasks) &&
    subtasks.length > 0 &&
    subtasks.every((s) => (s as { agentId: string | null }).agentId === null)
  );
}

/**
 * Records every PRD broadcast so tests can assert on what the card was shown.
 *
 * `prdEvents` excludes the pre-routing broadcast so the gate assertions stay about
 * gate semantics rather than counting broadcasts; `allPrdEvents` keeps everything
 * for the tests that pin down the two-phase publish itself.
 */
function makeHarness() {
  const allPrdEvents: Array<Record<string, unknown>> = [];
  const prdEvents: Array<Record<string, unknown>> = [];
  const delegatedMessages: string[] = [];
  const subagent: SubagentRuntime = {
    run: vi.fn(async ({ message }) => {
      delegatedMessages.push(message);
      return { runId: `run-${delegatedMessages.length}` };
    }),
    waitForRun: vi.fn(async () => ({ status: "ok" as const })),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: "subtask output" }],
    })),
  };
  const emitEvent = (_type: string, payload: Record<string, unknown>) => {
    if (payload.kind !== "prd") return;
    allPrdEvents.push(payload);
    if (!isPreRouting(payload)) prdEvents.push(payload);
  };
  return { subagent, emitEvent, prdEvents, allPrdEvents, delegatedMessages };
}

function depsFor(
  harness: ReturnType<typeof makeHarness>,
  cfg: ReturnType<typeof testConfig>,
) {
  return {
    subagent: harness.subagent,
    cfg,
    rootSessionKey: "agent:main:default",
    knownAgentIds: new Set(["coding"]),
    agentDescriptions: new Map<string, string>(),
    orchestratorAgentId: "main",
    emitEvent: harness.emitEvent,
  };
}

const TWO_SUBTASKS = {
  subtasks: [
    { id: 0, title: "first", description: "first concern" },
    { id: 1, title: "second", description: "second concern" },
  ],
};

/** Wait until a confirmation is registered, then answer it. */
async function answerWhenPending(
  prdEvents: Array<Record<string, unknown>>,
  outcome: { decision: "confirm" | "cancel" | "adjust"; adjustment?: string },
): Promise<void> {
  for (let i = 0; i < 200 && pendingApprovalCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const approvalId = prdEvents.at(-1)?.approvalId;
  if (typeof approvalId !== "string") throw new Error("no approvalId broadcast");
  resolvePendingApproval(approvalId, outcome);
}

beforeEach(() => {
  resetDelegationMetaStore();
  resetPrdApprovalStore();
  decomposeTask.mockReset();
});

afterEach(() => {
  resetPrdApprovalStore();
});

describe("gate disabled (default)", () => {
  test("executes immediately and broadcasts a non-awaiting PRD", async () => {
    const harness = makeHarness();
    const result = await handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: false } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(typeof result).toBe("string");
    expect(harness.prdEvents).toHaveLength(1);
    expect(harness.prdEvents[0]!.awaitingConfirmation).toBe(false);
    expect(harness.prdEvents[0]!.approvalId).toBeNull();
    expect(pendingApprovalCount()).toBe(0);
  });
});

describe("gate enabled", () => {
  const cfg = () => testConfig({ prdConfirmation: { enabled: true, timeoutMs: 60_000 } });

  test("broadcasts an awaiting PRD with an approvalId and delegates nothing until answered", async () => {
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });

    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    // Asserted after the answer is queued but reflects the pre-answer broadcast.
    expect(harness.prdEvents[0]!.awaitingConfirmation).toBe(true);
    expect(typeof harness.prdEvents[0]!.approvalId).toBe("string");

    await inFlight;
    expect(harness.delegatedMessages.length).toBeGreaterThan(0);
  });

  test("confirm runs the plan that was shown", async () => {
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    const result = await inFlight;

    expect(typeof result).toBe("string");
    expect(harness.delegatedMessages.some((m) => m.includes("first concern"))).toBe(true);
    expect(harness.delegatedMessages.some((m) => m.includes("second concern"))).toBe(true);
  });

  test("cancel delegates nothing and says so", async () => {
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(harness.prdEvents, { decision: "cancel" });
    const result = await inFlight;

    expect(result).toContain("取消");
    expect(harness.delegatedMessages).toHaveLength(0);
  });

  test("adjust re-decomposes with the operator's wording, then runs the revised plan", async () => {
    const harness = makeHarness();
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, title: "merged", description: "merged concern" },
        { id: 1, title: "kept", description: "kept concern" },
      ],
    });

    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });

    await answerWhenPending(harness.prdEvents, {
      decision: "adjust",
      adjustment: "把第 2 和第 3 个合并",
    });
    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    await inFlight;

    expect(decomposeTask).toHaveBeenCalledTimes(1);
    // 5th arg is the adjustment text.
    expect(decomposeTask.mock.calls[0]![4]).toBe("把第 2 和第 3 个合并");
    // Original awaiting, revised awaiting, then the close after confirm.
    expect(harness.prdEvents).toHaveLength(3);
    expect(harness.prdEvents.at(-1)!.awaitingConfirmation).toBe(false);
    expect(harness.delegatedMessages.some((m) => m.includes("merged concern"))).toBe(true);
    expect(harness.delegatedMessages.some((m) => m.includes("first concern"))).toBe(false);
  });

  test("a failed re-decomposition falls back to running the plan already shown", async () => {
    const harness = makeHarness();
    decomposeTask.mockRejectedValue(new Error("decomposer exploded"));

    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(harness.prdEvents, { decision: "adjust", adjustment: "改一下" });
    await inFlight;

    expect(harness.delegatedMessages.some((m) => m.includes("first concern"))).toBe(true);
  });

  test("an adjusted plan that collapses below 2 subtasks cancels instead of running the old one", async () => {
    const harness = makeHarness();
    decomposeTask.mockResolvedValue({
      subtasks: [{ id: 0, title: "only", description: "only one now" }],
    });

    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(harness.prdEvents, { decision: "adjust", adjustment: "合成一个" });
    const result = await inFlight;

    expect(result).toContain("取消");
    expect(harness.delegatedMessages).toHaveLength(0);
  });

  test("maxAdjustRounds:0 still gates once, and honours confirm", async () => {
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: true, maxAdjustRounds: 0 } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );
    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    await inFlight;

    // One awaiting broadcast, then the close once confirmed.
    expect(harness.prdEvents).toHaveLength(2);
    expect(harness.prdEvents[0]!.awaitingConfirmation).toBe(true);
    expect(harness.prdEvents[1]!.awaitingConfirmation).toBe(false);
    expect(harness.delegatedMessages.length).toBeGreaterThan(0);
  });

  test("rounds exhausted runs the revised plan and re-publishes it so the card matches", async () => {
    const harness = makeHarness();
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, title: "rev", description: "revised concern" },
        { id: 1, title: "rev2", description: "revised concern two" },
      ],
    });

    const inFlight = handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: true, maxAdjustRounds: 0 } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );
    await answerWhenPending(harness.prdEvents, { decision: "adjust", adjustment: "再改" });
    await inFlight;

    // Second broadcast is the revised plan, published without awaiting so the card
    // stops showing controls while it executes.
    expect(harness.prdEvents).toHaveLength(2);
    expect(harness.prdEvents[1]!.awaitingConfirmation).toBe(false);
    expect(harness.delegatedMessages.some((m) => m.includes("revised concern"))).toBe(true);
  });
});

describe("timeout policy", () => {
  test("onTimeout:proceed runs the plan", async () => {
    const harness = makeHarness();
    const result = await handleDecomposedRequest(
      depsFor(
        harness,
        testConfig({ prdConfirmation: { enabled: true, timeoutMs: 1000, onTimeout: "proceed" } }),
      ),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(typeof result).toBe("string");
    expect(harness.delegatedMessages.length).toBeGreaterThan(0);
  });

  test("onTimeout:cancel abandons the plan", async () => {
    const harness = makeHarness();
    const result = await handleDecomposedRequest(
      depsFor(
        harness,
        testConfig({ prdConfirmation: { enabled: true, timeoutMs: 1000, onTimeout: "cancel" } }),
      ),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(result).toContain("取消");
    expect(harness.delegatedMessages).toHaveLength(0);
  });
});

describe("pass-through is unaffected by the gate", () => {
  test("a 1-subtask plan never registers a confirmation", async () => {
    const harness = makeHarness();
    const result = await handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: true } })),
      {
        originalPrompt: "one thing",
        rawPlan: { subtasks: [{ id: 0, title: "a", description: "one concern" } as SubtaskPlan] },
        promptTruncated: false,
      },
    );

    expect(result).toBeNull();
    expect(pendingApprovalCount()).toBe(0);
    expect(harness.prdEvents).toHaveLength(0);
    // Nothing at all is broadcast: the pass-through decision is made before any
    // plan is published, so no card should ever appear for it.
    expect(harness.allPrdEvents).toHaveLength(0);
  });
});

describe("a plan is published twice: structure first, routing second", () => {
  // Routing costs classifier model calls (tens of seconds in practice), and the card
  // used to wait for them before appearing at all. Layering is pure graph work, so
  // everything except the agent column can be shown immediately.
  test("the first broadcast carries structure with routing pending", async () => {
    const harness = makeHarness();
    await handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: false } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    const first = harness.allPrdEvents[0]!;
    expect(isPreRouting(first)).toBe(true);
    // Structure is fully populated even though routing is not.
    expect(first.totalLayers).toBe(1);
    expect((first.subtasks as Array<{ title: string }>).map((s) => s.title)).toEqual([
      "first",
      "second",
    ]);
  });

  test("the second broadcast fills in the resolved agents", async () => {
    const harness = makeHarness();
    await handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: false } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(harness.allPrdEvents).toHaveLength(2);
    const second = harness.allPrdEvents[1]!;
    expect(isPreRouting(second)).toBe(false);
    expect((second.subtasks as Array<{ agentId: string | null }>).map((s) => s.agentId)).toEqual([
      "coding",
      "coding",
    ]);
  });

  test("the pre-routing broadcast never opens the confirmation gate", async () => {
    // The operator must not be able to confirm a plan whose routing is unknown —
    // the card would be answering for assignments it cannot show.
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: true, timeoutMs: 60_000 } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    await inFlight;

    const preRouting = harness.allPrdEvents.filter((e) => isPreRouting(e));
    expect(preRouting.length).toBeGreaterThan(0);
    for (const event of preRouting) {
      expect(event.awaitingConfirmation).toBe(false);
      expect(event.approvalId).toBeNull();
    }
  });

  test("an adjusted plan also gets its own pre-routing broadcast", async () => {
    // Otherwise the revised plan's card would sit on the previous plan's routing
    // until the classifier re-ran.
    const harness = makeHarness();
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, title: "revised-a", description: "revised concern a" },
        { id: 1, title: "revised-b", description: "revised concern b" },
      ],
    });
    const inFlight = handleDecomposedRequest(
      depsFor(harness, testConfig({ prdConfirmation: { enabled: true, timeoutMs: 60_000 } })),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    await answerWhenPending(harness.prdEvents, { decision: "adjust", adjustment: "改一下" });
    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    await inFlight;

    const preRoutingTitles = harness.allPrdEvents
      .filter((e) => isPreRouting(e))
      .map((e) => (e.subtasks as Array<{ title: string }>).map((s) => s.title).join(","));
    expect(preRoutingTitles).toContain("first,second");
    expect(preRoutingTitles).toContain("revised-a,revised-b");
  });
});

describe("the card is told when the gate closes", () => {
  // Regression: nothing else clears the confirm controls until the first layer
  // finishes, so without this broadcast the button stays live for minutes and
  // clicking it fails with "unknown or already-answered confirmation".
  const cfg = () => testConfig({ prdConfirmation: { enabled: true, timeoutMs: 60_000 } });

  test("confirm is followed by a non-awaiting broadcast", async () => {
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    await inFlight;

    expect(harness.prdEvents.at(-1)).toMatchObject({
      awaitingConfirmation: false,
      approvalId: null,
    });
  });

  test("cancel is followed by a non-awaiting broadcast", async () => {
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(depsFor(harness, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(harness.prdEvents, { decision: "cancel" });
    await inFlight;

    expect(harness.prdEvents.at(-1)).toMatchObject({ awaitingConfirmation: false });
  });

  test("a timeout also closes the gate on screen, so no dead button is left behind", async () => {
    const harness = makeHarness();
    await handleDecomposedRequest(
      depsFor(
        harness,
        testConfig({ prdConfirmation: { enabled: true, timeoutMs: 1000, onTimeout: "proceed" } }),
      ),
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(harness.prdEvents.at(-1)).toMatchObject({
      awaitingConfirmation: false,
      approvalId: null,
    });
  });

  test("the closing broadcast does not re-send the PRD text to chat", async () => {
    const notices: string[] = [];
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(
      { ...depsFor(harness, cfg()), notify: async (text: string) => (notices.push(text), true) },
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );
    await answerWhenPending(harness.prdEvents, { decision: "confirm" });
    await inFlight;

    // Exactly one 任务拆解 notice, despite two PRD broadcasts.
    expect(notices.filter((t) => t.includes("【任务拆解】"))).toHaveLength(1);
  });
});

describe("adjust announces itself before re-decomposing", () => {
  // decomposeTask takes ~62s while the RPC carrying the answer returns in ms, so
  // without this event the card sits on the superseded plan — controls still live —
  // for the whole minute, and a second click fails with "already-answered".
  const cfg = () => testConfig({ prdConfirmation: { enabled: true, timeoutMs: 60_000 } });

  function harnessWithKinds() {
    const harness = makeHarness();
    const kinds: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const emitEvent = (type: string, payload: Record<string, unknown>) => {
      harness.emitEvent(type, payload);
      if (typeof payload.kind === "string") kinds.push(payload.kind);
      events.push(payload);
    };
    return { ...harness, emitEvent, kinds, events };
  }

  test("emits redecomposing before the revised plan is published", async () => {
    const h = harnessWithKinds();
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, title: "revised-a", description: "revised concern a" },
        { id: 1, title: "revised-b", description: "revised concern b" },
      ],
    });
    const inFlight = handleDecomposedRequest(depsFor(h, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });

    await answerWhenPending(h.prdEvents, { decision: "adjust", adjustment: "把 2 和 3 合并" });
    await answerWhenPending(h.prdEvents, { decision: "confirm" });
    await inFlight;

    const at = h.kinds.indexOf("redecomposing");
    expect(at).toBeGreaterThan(-1);
    // A prd event must follow it — that is what clears the spinner on the card.
    expect(h.kinds.slice(at + 1)).toContain("prd");
  });

  test("the event carries the operator's wording back", async () => {
    const h = harnessWithKinds();
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, title: "a", description: "concern a" },
        { id: 1, title: "b", description: "concern b" },
      ],
    });
    const inFlight = handleDecomposedRequest(depsFor(h, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(h.prdEvents, { decision: "adjust", adjustment: "把 2 和 3 合并" });
    await answerWhenPending(h.prdEvents, { decision: "confirm" });
    await inFlight;

    const evt = h.events.find((e) => e.kind === "redecomposing");
    expect(evt).toMatchObject({ adjustment: "把 2 和 3 合并" });
  });

  test("confirm and cancel do not emit it", async () => {
    for (const decision of ["confirm", "cancel"] as const) {
      const h = harnessWithKinds();
      const inFlight = handleDecomposedRequest(depsFor(h, cfg()), {
        originalPrompt: "do two things",
        rawPlan: TWO_SUBTASKS,
        promptTruncated: false,
      });
      await answerWhenPending(h.prdEvents, { decision });
      await inFlight;
      expect(h.kinds).not.toContain("redecomposing");
    }
  });

  // An empty adjustment runs the plan already on screen instead of re-decomposing, so
  // announcing a re-decomposition that never happens would be a lie.
  test("an empty adjustment does not emit it", async () => {
    const h = harnessWithKinds();
    const inFlight = handleDecomposedRequest(depsFor(h, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(h.prdEvents, { decision: "adjust", adjustment: "   " });
    await inFlight;
    expect(h.kinds).not.toContain("redecomposing");
  });

  // Every failure path must still reach a prd event, or the card spins forever.
  test("a failed re-decomposition is still followed by a prd event", async () => {
    const h = harnessWithKinds();
    decomposeTask.mockRejectedValue(new Error("decomposer unavailable"));
    const inFlight = handleDecomposedRequest(depsFor(h, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(h.prdEvents, { decision: "adjust", adjustment: "改一下" });
    await inFlight;

    const at = h.kinds.indexOf("redecomposing");
    expect(at).toBeGreaterThan(-1);
    expect(h.kinds.slice(at + 1)).toContain("prd");
  });

  test("a revision that collapses below 2 subtasks is still followed by a prd event", async () => {
    const h = harnessWithKinds();
    decomposeTask.mockResolvedValue({ subtasks: [{ id: 0, title: "one", description: "one" }] });
    const inFlight = handleDecomposedRequest(depsFor(h, cfg()), {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });
    await answerWhenPending(h.prdEvents, { decision: "adjust", adjustment: "合成一个" });
    const result = await inFlight;

    expect(result).toContain("取消");
    const at = h.kinds.indexOf("redecomposing");
    expect(h.kinds.slice(at + 1)).toContain("prd");
  });
});

describe("the summarizing step announces itself", () => {
  // Summarizing was measured at 136s — 17% of an 819s request — and by then the card
  // shows every subtask finished. Without an announcement the user faces a
  // completed-looking view with no answer for over two minutes.
  const cfgOff = () => testConfig({ prdConfirmation: { enabled: false } });

  test("broadcasts a summarizing event before the summary is produced", async () => {
    const ordered: string[] = [];
    const harness = makeHarness();
    const deps = {
      ...depsFor(harness, cfgOff()),
      emitEvent: (_type: string, payload: Record<string, unknown>) => {
        if (typeof payload.kind === "string") ordered.push(payload.kind);
      },
    };

    await handleDecomposedRequest(deps, {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });

    expect(ordered).toContain("summarizing");
    // After the last layer, before anything else — the whole point is that it lands
    // while the summarizer call is still running.
    expect(ordered.lastIndexOf("layer_progress")).toBeLessThan(ordered.indexOf("summarizing"));
  });

  test("the event carries the success counts", async () => {
    const events: Array<Record<string, unknown>> = [];
    const harness = makeHarness();
    const deps = {
      ...depsFor(harness, cfgOff()),
      emitEvent: (_type: string, payload: Record<string, unknown>) => {
        if (payload.kind === "summarizing") events.push(payload);
      },
    };

    await handleDecomposedRequest(deps, {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ okCount: 2, totalCount: 2 });
  });

  // The card event only reaches the Control UI; a chat channel sees nothing but this.
  test("also sends a chat notice, for channels with no card", async () => {
    const notices: string[] = [];
    const harness = makeHarness();
    await handleDecomposedRequest(
      {
        ...depsFor(harness, cfgOff()),
        notify: async (text: string) => (notices.push(text), true),
      },
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(notices.filter((t) => t.includes("【整合中】"))).toHaveLength(1);
  });

  test("a cancelled plan never announces summarizing, because it never summarizes", async () => {
    const kinds: string[] = [];
    const harness = makeHarness();
    const inFlight = handleDecomposedRequest(
      {
        ...depsFor(harness, testConfig({ prdConfirmation: { enabled: true, timeoutMs: 60_000 } })),
        emitEvent: (_type: string, payload: Record<string, unknown>) => {
          if (payload.kind === "prd") harness.allPrdEvents.push(payload);
          if (!isPreRouting(payload) && payload.kind === "prd") harness.prdEvents.push(payload);
          if (typeof payload.kind === "string") kinds.push(payload.kind);
        },
      },
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );
    await answerWhenPending(harness.prdEvents, { decision: "cancel" });
    await inFlight;

    expect(kinds).not.toContain("summarizing");
  });
});

describe("per-subtask running signal reaches the card", () => {
  // The card cannot otherwise tell "queued" from "running": layer results only
  // arrive when a whole layer finishes.
  test("each subtask is bracketed by a start and an end status event", async () => {
    const statusEvents: Array<Record<string, unknown>> = [];
    const harness = makeHarness();
    const deps = {
      ...depsFor(harness, testConfig({ prdConfirmation: { enabled: false } })),
      emitEvent: (_type: string, payload: Record<string, unknown>) => {
        if (payload.kind === "subtask_status") statusEvents.push(payload);
      },
    };

    await handleDecomposedRequest(deps, {
      originalPrompt: "do two things",
      rawPlan: TWO_SUBTASKS,
      promptTruncated: false,
    });

    // Two subtasks, each start+end.
    expect(statusEvents).toHaveLength(4);
    for (const id of [0, 1]) {
      const forSubtask = statusEvents.filter((e) => e.subtaskId === id);
      expect(forSubtask.map((e) => e.phase)).toEqual(["start", "end"]);
    }
  });

  test("a failed subtask still emits its end, so no spinner is left running", async () => {
    const statusEvents: Array<Record<string, unknown>> = [];
    const harness = makeHarness();
    // Every delegated run fails.
    harness.subagent.waitForRun = vi.fn(async () => ({
      status: "error" as const,
      error: "boom",
    }));

    await handleDecomposedRequest(
      {
        ...depsFor(harness, testConfig({ prdConfirmation: { enabled: false } })),
        emitEvent: (_type: string, payload: Record<string, unknown>) => {
          if (payload.kind === "subtask_status") statusEvents.push(payload);
        },
      },
      { originalPrompt: "do two things", rawPlan: TWO_SUBTASKS, promptTruncated: false },
    );

    expect(statusEvents.filter((e) => e.phase === "end")).toHaveLength(2);
  });
});
