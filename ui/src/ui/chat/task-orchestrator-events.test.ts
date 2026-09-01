import { describe, expect, it } from "vitest";
import {
  applyTaskOrchestratorEvent,
  findProgressForSession,
  type TaskOrchestratorProgress,
} from "./task-orchestrator-events.ts";

const PRD = {
  plugin: "dragon-task-orchestrator",
  type: "dragon_task_progress",
  kind: "prd",
  rootSessionKey: "agent:main:main",
  totalLayers: 2,
  subtasks: [
    {
      id: 0,
      title: "查资料",
      description: "查资料",
      agentId: "research",
      acceptanceCriteria: null,
      needsPriorResults: [],
      layer: 1,
    },
    {
      id: 1,
      title: "写代码",
      description: "写代码",
      agentId: "coding",
      acceptanceCriteria: "review",
      needsPriorResults: [0],
      layer: 2,
    },
  ],
};

function layerEvent(layer: number, results: unknown[], totalLayers = 2) {
  return {
    plugin: "dragon-task-orchestrator",
    type: "dragon_task_progress",
    kind: "layer_progress",
    rootSessionKey: "agent:main:main",
    layer,
    totalLayers,
    results,
  };
}

const OK_RESULT = { id: 0, agentId: "research", status: "ok", verifyAttempts: 1, error: null };

function apply(
  state: Map<string, TaskOrchestratorProgress>,
  payload: unknown,
  now = 1,
): Map<string, TaskOrchestratorProgress> {
  const next = applyTaskOrchestratorEvent(state, payload, now);
  expect(next).not.toBeNull();
  return next!;
}

describe("applyTaskOrchestratorEvent", () => {
  it("stores the PRD subtasks with their routing", () => {
    const state = apply(new Map(), PRD);
    const entry = state.get("agent:main:main")!;
    expect(entry.subtasks).toHaveLength(2);
    expect(entry.subtasks[1]).toMatchObject({
      agentId: "coding",
      acceptanceCriteria: "review",
      needsPriorResults: [0],
      layer: 2,
    });
    expect(entry.layers).toEqual([]);
  });

  // Regression: a null agentId used to make parseSubtask discard the whole subtask,
  // which would have made the plugin's pre-routing broadcast render an empty card.
  it("keeps subtasks whose routing has not resolved yet", () => {
    const state = apply(new Map(), {
      ...PRD,
      subtasks: PRD.subtasks.map((s) => ({ ...s, agentId: null })),
    });
    const entry = state.get("agent:main:main")!;
    expect(entry.subtasks).toHaveLength(2);
    expect(entry.subtasks.map((s) => s.agentId)).toEqual([null, null]);
    // Everything else still arrives, which is what makes publishing early worthwhile.
    expect(entry.subtasks[1]).toMatchObject({ layer: 2, needsPriorResults: [0] });
  });

  it("a later broadcast with resolved routing replaces the pending state", () => {
    let state = apply(
      new Map(),
      { ...PRD, subtasks: PRD.subtasks.map((s) => ({ ...s, agentId: null })) },
      1,
    );
    state = apply(state, PRD, 2);
    expect(state.get("agent:main:main")!.subtasks.map((s) => s.agentId)).toEqual([
      "research",
      "coding",
    ]);
  });

  it("stores the planned layer count from the PRD event", () => {
    const state = apply(new Map(), PRD);
    expect(state.get("agent:main:main")!.plannedTotalLayers).toBe(2);
  });

  it("returns a new map so Lit's reference comparison re-renders", () => {
    const before = new Map<string, TaskOrchestratorProgress>();
    const after = apply(before, PRD);
    expect(after).not.toBe(before);
    expect(before.size).toBe(0);
  });

  // The whole reason this is not modeled like `privacyStatus`: layer 2 arriving
  // must not erase layer 1.
  it("accumulates layers instead of replacing them", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, layerEvent(1, [OK_RESULT]));
    state = apply(
      state,
      layerEvent(2, [{ id: 1, agentId: "coding", status: "error", error: "校验未通过" }]),
    );
    const entry = state.get("agent:main:main")!;
    expect(entry.layers.map((l) => l.layer)).toEqual([1, 2]);
    expect(entry.layers[0]!.results[0]).toMatchObject({ status: "ok" });
    expect(entry.layers[1]!.results[0]).toMatchObject({ status: "error", error: "校验未通过" });
  });

  it("orders layers by index even if they arrive out of order", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, layerEvent(2, [OK_RESULT]));
    state = apply(state, layerEvent(1, [OK_RESULT]));
    expect(state.get("agent:main:main")!.layers.map((l) => l.layer)).toEqual([1, 2]);
  });

  it("ignores a duplicate broadcast of the same layer", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, layerEvent(1, [OK_RESULT]));
    expect(applyTaskOrchestratorEvent(state, layerEvent(1, [OK_RESULT]), 2)).toBeNull();
  });

  it("drops progress for a session that never sent a PRD", () => {
    expect(applyTaskOrchestratorEvent(new Map(), layerEvent(1, [OK_RESULT]), 1)).toBeNull();
  });

  it("a new PRD on the same session clears the previous run's layers", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, layerEvent(1, [OK_RESULT]));
    state = apply(state, PRD, 2);
    expect(state.get("agent:main:main")!.layers).toEqual([]);
  });

  it("ignores events from other plugins and other event types", () => {
    expect(
      applyTaskOrchestratorEvent(new Map(), { ...PRD, plugin: "guardclaw" }, 1),
    ).toBeNull();
    expect(
      applyTaskOrchestratorEvent(new Map(), { ...PRD, type: "privacy_activated" }, 1),
    ).toBeNull();
    expect(applyTaskOrchestratorEvent(new Map(), { ...PRD, kind: "something-else" }, 1)).toBeNull();
  });

  it("rejects malformed payloads rather than storing partial state", () => {
    expect(applyTaskOrchestratorEvent(new Map(), undefined, 1)).toBeNull();
    expect(applyTaskOrchestratorEvent(new Map(), "nonsense", 1)).toBeNull();
    expect(applyTaskOrchestratorEvent(new Map(), { ...PRD, rootSessionKey: "" }, 1)).toBeNull();
    expect(applyTaskOrchestratorEvent(new Map(), { ...PRD, subtasks: "no" }, 1)).toBeNull();
    // Every subtask unusable -> nothing worth rendering.
    expect(
      applyTaskOrchestratorEvent(new Map(), { ...PRD, subtasks: [{ id: "x" }, {}] }, 1),
    ).toBeNull();
  });

  it("keeps usable subtasks and drops only the unusable ones", () => {
    const state = apply(new Map(), {
      ...PRD,
      subtasks: [PRD.subtasks[0]!, { id: 1 }, null],
    });
    expect(state.get("agent:main:main")!.subtasks).toHaveLength(1);
  });

  // Usability is "has something to render", not "has an agent" — agentId is
  // legitimately null before routing resolves, so it cannot be the gate.
  it("drops a subtask with neither title nor description even when routing is pending", () => {
    const state = apply(new Map(), {
      ...PRD,
      subtasks: [
        { id: 0, agentId: null, title: "", description: "" },
        { id: 1, agentId: null, title: "有标题", description: "" },
        { id: 2, agentId: null, title: "", description: "只有描述" },
      ],
    });
    expect(state.get("agent:main:main")!.subtasks.map((s) => s.id)).toEqual([1, 2]);
  });

  describe("redecomposing", () => {
    const AWAITING = {
      ...PRD,
      approvalId: "abc-123",
      awaitingConfirmation: true,
    };
    const REDECOMPOSING = {
      plugin: "dragon-task-orchestrator",
      type: "dragon_task_progress",
      kind: "redecomposing",
      rootSessionKey: "agent:main:main",
      adjustment: "把 2 和 3 合并",
    };

    it("records the state with the operator's wording", () => {
      let state = apply(new Map(), AWAITING);
      state = apply(state, REDECOMPOSING, 2);
      expect(state.get("agent:main:main")!.redecomposing).toEqual({
        adjustment: "把 2 和 3 合并",
      });
    });

    // The superseded plan's approvalId has already been consumed by the plugin, so
    // leaving the controls live means a second click fails with "already-answered".
    it("settles the gate, so the stale confirm controls disappear", () => {
      let state = apply(new Map(), AWAITING);
      expect(state.get("agent:main:main")!.awaitingConfirmation).toBe(true);
      state = apply(state, REDECOMPOSING, 2);
      const entry = state.get("agent:main:main")!;
      expect(entry.awaitingConfirmation).toBe(false);
      expect(entry.approvalId).toBeNull();
    });

    // Every outcome of re-decomposition reaches a prd event, which is what guarantees
    // the spinner cannot get stuck.
    it("is cleared by the next PRD", () => {
      let state = apply(new Map(), AWAITING);
      state = apply(state, REDECOMPOSING, 2);
      state = apply(state, PRD, 3);
      expect(state.get("agent:main:main")!.redecomposing).toBeNull();
    });

    it("is ignored without a plan on screen", () => {
      expect(applyTaskOrchestratorEvent(new Map(), REDECOMPOSING, 1)).toBeNull();
    });

    it("keeps the superseded plan visible as context", () => {
      let state = apply(new Map(), AWAITING);
      state = apply(state, REDECOMPOSING, 2);
      expect(state.get("agent:main:main")!.subtasks).toHaveLength(2);
    });

    it("tolerates a missing adjustment rather than dropping the event", () => {
      let state = apply(new Map(), AWAITING);
      state = apply(state, { ...REDECOMPOSING, adjustment: undefined }, 2);
      expect(state.get("agent:main:main")!.redecomposing).toEqual({ adjustment: "" });
    });
  });

  describe("summarizing", () => {
    const SUMMARIZING = {
      plugin: "dragon-task-orchestrator",
      type: "dragon_task_progress",
      kind: "summarizing",
      rootSessionKey: "agent:main:main",
      okCount: 2,
      totalCount: 2,
    };

    it("records the summarizing state with its counts", () => {
      let state = apply(new Map(), PRD);
      state = apply(state, SUMMARIZING, 2);
      expect(state.get("agent:main:main")!.summarizing).toEqual({ okCount: 2, totalCount: 2 });
    });

    // Summarizing starts only after every subtask settled, so a spinner left on a
    // subtask row here would be stuck for the whole (~2 minute) summarizing window.
    it("clears running subtasks, since none can still be running", () => {
      let state = apply(new Map(), PRD);
      state = apply(
        state,
        {
          plugin: "dragon-task-orchestrator",
          type: "dragon_task_progress",
          kind: "subtask_status",
          rootSessionKey: "agent:main:main",
          subtaskId: 0,
          agentId: "research",
          phase: "start",
        },
        2,
      );
      expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([0]);
      state = apply(state, SUMMARIZING, 3);
      expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([]);
    });

    it("is ignored without a PRD, which would render a card with no task list", () => {
      expect(applyTaskOrchestratorEvent(new Map(), SUMMARIZING, 1)).toBeNull();
    });

    it("is ignored when the counts are not usable indices", () => {
      const state = apply(new Map(), PRD);
      expect(
        applyTaskOrchestratorEvent(state, { ...SUMMARIZING, okCount: "two" }, 2),
      ).toBeNull();
      expect(
        applyTaskOrchestratorEvent(state, { ...SUMMARIZING, totalCount: null }, 2),
      ).toBeNull();
    });

    it("keeps the plan and layers intact", () => {
      let state = apply(new Map(), PRD);
      state = apply(state, layerEvent(1, [OK_RESULT]), 2);
      state = apply(state, SUMMARIZING, 3);
      const entry = state.get("agent:main:main")!;
      expect(entry.subtasks).toHaveLength(2);
      expect(entry.layers).toHaveLength(1);
    });
  });

  it("drops result entries with an unknown status", () => {
    let state = apply(new Map(), PRD);
    state = apply(
      state,
      layerEvent(1, [OK_RESULT, { id: 1, agentId: "coding", status: "maybe" }]),
    );
    expect(state.get("agent:main:main")!.layers[0]!.results).toHaveLength(1);
  });

  it("caps tracked sessions, keeping the most recently updated", () => {
    let state = new Map<string, TaskOrchestratorProgress>();
    for (let i = 0; i < 25; i++) {
      state = apply(state, { ...PRD, rootSessionKey: `agent:main:s${i}` }, i + 1);
    }
    expect(state.size).toBe(20);
    expect(state.has("agent:main:s24")).toBe(true);
    expect(state.has("agent:main:s0")).toBe(false);
  });
});

describe("findProgressForSession", () => {
  it("matches an exact session key", () => {
    const state = apply(new Map(), PRD);
    expect(findProgressForSession(state, "agent:main:main")).toBeDefined();
  });

  // The default Control UI state holds the bare alias until session defaults
  // arrive; an exact-match-only lookup would render nothing in that case.
  it("matches the bare `main` alias against the host-resolved key", () => {
    const state = apply(new Map(), PRD);
    expect(findProgressForSession(state, "main")).toBeDefined();
  });

  it("does not fall back for a fully-qualified key that simply has no entry", () => {
    const state = apply(new Map(), PRD);
    expect(findProgressForSession(state, "agent:coding:main")).toBeUndefined();
  });

  it("prefers the most recently updated match when several share the tail", () => {
    let state = apply(new Map(), { ...PRD, rootSessionKey: "agent:coding:main" }, 1);
    state = apply(
      state,
      {
        ...PRD,
        rootSessionKey: "agent:research:main",
        subtasks: [{ ...PRD.subtasks[0]!, agentId: "newest" }],
      },
      2,
    );
    expect(findProgressForSession(state, "main")!.subtasks[0]!.agentId).toBe("newest");
  });

  it("returns undefined for an empty map or empty key", () => {
    expect(findProgressForSession(new Map(), "main")).toBeUndefined();
    expect(findProgressForSession(null, "main")).toBeUndefined();
    expect(findProgressForSession(apply(new Map(), PRD), "")).toBeUndefined();
  });
});

describe("confirmation gate fields", () => {
  it("defaults to not awaiting when the payload omits them", () => {
    const state = apply(new Map(), PRD);
    const entry = state.get("agent:main:main")!;
    expect(entry.awaitingConfirmation).toBe(false);
    expect(entry.approvalId).toBeNull();
  });

  it("records the approvalId when awaiting confirmation", () => {
    const state = apply(new Map(), {
      ...PRD,
      approvalId: "abc-123",
      awaitingConfirmation: true,
    });
    const entry = state.get("agent:main:main")!;
    expect(entry.awaitingConfirmation).toBe(true);
    expect(entry.approvalId).toBe("abc-123");
  });

  it("ignores awaitingConfirmation without an approvalId, since there is nothing to answer with", () => {
    const state = apply(new Map(), { ...PRD, awaitingConfirmation: true });
    const entry = state.get("agent:main:main")!;
    expect(entry.awaitingConfirmation).toBe(false);
    expect(entry.approvalId).toBeNull();
  });

  it("clears the awaiting state once a layer reports, so the controls disappear", () => {
    let state = apply(new Map(), { ...PRD, approvalId: "abc-123", awaitingConfirmation: true });
    expect(state.get("agent:main:main")!.awaitingConfirmation).toBe(true);
    state = apply(state, layerEvent(1, [OK_RESULT]));
    const entry = state.get("agent:main:main")!;
    expect(entry.awaitingConfirmation).toBe(false);
    expect(entry.approvalId).toBeNull();
  });

  it("a revised PRD replaces the previous approvalId rather than keeping both", () => {
    let state = apply(new Map(), { ...PRD, approvalId: "first", awaitingConfirmation: true });
    state = apply(state, { ...PRD, approvalId: "second", awaitingConfirmation: true }, 2);
    expect(state.get("agent:main:main")!.approvalId).toBe("second");
  });

  it("a non-awaiting PRD after an awaiting one drops the id", () => {
    let state = apply(new Map(), { ...PRD, approvalId: "first", awaitingConfirmation: true });
    state = apply(state, PRD, 2);
    const entry = state.get("agent:main:main")!;
    expect(entry.awaitingConfirmation).toBe(false);
    expect(entry.approvalId).toBeNull();
  });
});

describe("subtask tool activity", () => {
  function toolEvent(over: Record<string, unknown> = {}) {
    return {
      plugin: "dragon-task-orchestrator",
      type: "dragon_task_progress",
      kind: "subtask_tool",
      rootSessionKey: "agent:main:main",
      subtaskId: 0,
      agentId: "research",
      role: "work",
      toolName: "web_fetch",
      phase: "start",
      summary: "url=https://x.dev",
      error: null,
      ...over,
    };
  }

  it("appends a running call for the named subtask", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent(), 2);
    const calls = state.get("agent:main:main")!.toolCalls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      subtaskId: 0,
      toolName: "web_fetch",
      phase: "start",
      summary: "url=https://x.dev",
    });
  });

  it("a result collapses into its pending start rather than adding a row", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent(), 2);
    state = apply(state, toolEvent({ phase: "result", summary: "ok" }), 3);
    const calls = state.get("agent:main:main")!.toolCalls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: "result", summary: "ok" });
  });

  it("keeps calls for different subtasks separate", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent({ subtaskId: 0 }), 2);
    state = apply(state, toolEvent({ subtaskId: 1, toolName: "write" }), 3);
    const calls = state.get("agent:main:main")!.toolCalls!;
    expect(calls.map((c) => c.subtaskId)).toEqual([0, 1]);
  });

  it("records a verifier's calls with the verify role", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent({ role: "verify" }), 2);
    expect(state.get("agent:main:main")!.toolCalls![0]!.role).toBe("verify");
  });

  it("carries an error through on the result phase", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent({ phase: "result", summary: null, error: "404" }), 2);
    expect(state.get("agent:main:main")!.toolCalls![0]).toMatchObject({ error: "404" });
  });

  it("drops activity that arrives with no PRD to attach to", () => {
    expect(applyTaskOrchestratorEvent(new Map(), toolEvent(), 1)).toBeNull();
  });

  it("drops activity naming a subtask that is not in the plan", () => {
    const state = apply(new Map(), PRD);
    expect(applyTaskOrchestratorEvent(state, toolEvent({ subtaskId: 99 }), 2)).toBeNull();
  });

  it("drops a malformed phase", () => {
    const state = apply(new Map(), PRD);
    expect(applyTaskOrchestratorEvent(state, toolEvent({ phase: "weird" }), 2)).toBeNull();
  });

  it("caps activity per subtask so one busy subtask cannot starve another", () => {
    let state = apply(new Map(), PRD);
    for (let i = 0; i < 40; i++) {
      state = apply(state, toolEvent({ subtaskId: 0, toolName: `t${i}` }), 2 + i);
    }
    state = apply(state, toolEvent({ subtaskId: 1, toolName: "kept" }), 100);
    const calls = state.get("agent:main:main")!.toolCalls!;
    expect(calls.filter((c) => c.subtaskId === 0).length).toBe(30);
    // The other subtask's single call survives.
    expect(calls.filter((c) => c.subtaskId === 1).length).toBe(1);
    // Oldest dropped, newest kept.
    expect(calls.some((c) => c.toolName === "t0")).toBe(false);
    expect(calls.some((c) => c.toolName === "t39")).toBe(true);
  });

  it("a new PRD clears prior activity, whose subtask ids refer to a dead plan", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent(), 2);
    state = apply(state, PRD, 3);
    expect(state.get("agent:main:main")!.toolCalls).toEqual([]);
  });

  it("layer progress preserves activity", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, toolEvent(), 2);
    state = apply(state, layerEvent(1, [OK_RESULT]), 3);
    expect(state.get("agent:main:main")!.toolCalls).toHaveLength(1);
  });
});

describe("subtask running status", () => {
  function statusEvent(subtaskId: number, phase: "start" | "end") {
    return {
      plugin: "dragon-task-orchestrator",
      type: "dragon_task_progress",
      kind: "subtask_status",
      rootSessionKey: "agent:main:main",
      subtaskId,
      agentId: "research",
      phase,
    };
  }

  it("records a subtask as running on start", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, statusEvent(0, "start"), 2);
    expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([0]);
  });

  it("clears it on end", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, statusEvent(0, "start"), 2);
    state = apply(state, statusEvent(0, "end"), 3);
    expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([]);
  });

  it("tracks concurrent subtasks independently", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, statusEvent(0, "start"), 2);
    state = apply(state, statusEvent(1, "start"), 3);
    expect(state.get("agent:main:main")!.runningSubtaskIds!.sort()).toEqual([0, 1]);
    state = apply(state, statusEvent(0, "end"), 4);
    expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([1]);
  });

  it("a duplicate start does not double-count", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, statusEvent(0, "start"), 2);
    state = apply(state, statusEvent(0, "start"), 3);
    expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([0]);
  });

  it("a finished layer clears running flags even if an end event was lost", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, statusEvent(0, "start"), 2);
    // No "end" — the layer result is what clears it, so no spinner can get stuck.
    state = apply(state, layerEvent(1, [OK_RESULT]), 3);
    expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([]);
  });

  it("a new PRD clears running flags from the superseded plan", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, statusEvent(0, "start"), 2);
    state = apply(state, PRD, 3);
    expect(state.get("agent:main:main")!.runningSubtaskIds).toEqual([]);
  });

  it("drops status for an unknown subtask or with no PRD", () => {
    expect(applyTaskOrchestratorEvent(new Map(), statusEvent(0, "start"), 1)).toBeNull();
    const state = apply(new Map(), PRD);
    expect(applyTaskOrchestratorEvent(state, statusEvent(99, "start"), 2)).toBeNull();
  });

  it("drops a malformed phase", () => {
    const state = apply(new Map(), PRD);
    expect(
      applyTaskOrchestratorEvent(state, { ...statusEvent(0, "start"), phase: "weird" }, 2),
    ).toBeNull();
  });
});

describe("startedAt marks which turn a plan belongs to", () => {
  it("is set when the PRD arrives", () => {
    const state = apply(new Map(), PRD, 500);
    expect(state.get("agent:main:main")!.startedAt).toBe(500);
  });

  it("survives layer progress, which only moves updatedAt", () => {
    let state = apply(new Map(), PRD, 500);
    state = apply(state, layerEvent(1, [OK_RESULT]), 900);
    const entry = state.get("agent:main:main")!;
    expect(entry.startedAt).toBe(500);
    expect(entry.updatedAt).toBe(900);
  });

  it("is re-set by a revised PRD, which is the plan the reply will match", () => {
    let state = apply(new Map(), PRD, 500);
    state = apply(state, PRD, 900);
    expect(state.get("agent:main:main")!.startedAt).toBe(900);
  });
});

/**
 * Fixed-pipeline events.
 *
 * Both of these were already being broadcast by the plugin and dropped here, so the
 * feature was "data arrives, nothing renders". The tests therefore focus on the mapping
 * onto the layered model — step N is layer N — and on the finished condition, which is
 * derived from having heard an `end` for every step.
 */
const PIPELINE_PLAN = {
  plugin: "dragon-task-orchestrator",
  type: "dragon_task_progress",
  kind: "pipeline_plan",
  rootSessionKey: "agent:main:main",
  pipelineId: "pl_a",
  name: "文档生成",
  steps: [
    { index: 0, agentId: "research", instruction: "查资料" },
    { index: 1, agentId: "writing", instruction: "写文档" },
  ],
};

function stepEvent(
  index: number,
  phase: "start" | "end",
  extra: { agentId?: string; status?: string; error?: string | null } = {},
) {
  return {
    plugin: "dragon-task-orchestrator",
    type: "dragon_task_progress",
    kind: "step_status",
    rootSessionKey: "agent:main:main",
    index,
    agentId: extra.agentId ?? (index === 0 ? "research" : "writing"),
    phase,
    status: extra.status ?? null,
    error: extra.error ?? null,
  };
}

function entryOf(state: Map<string, TaskOrchestratorProgress>): TaskOrchestratorProgress {
  const entry = state.get("agent:main:main");
  expect(entry).toBeDefined();
  return entry!;
}

describe("pipeline_plan", () => {
  it("maps each step to a subtask, one per layer", () => {
    const entry = entryOf(apply(new Map(), PIPELINE_PLAN));
    expect(entry.mode).toBe("pipeline");
    expect(entry.pipelineName).toBe("文档生成");
    expect(entry.plannedTotalLayers).toBe(2);
    expect(entry.subtasks.map((s) => [s.id, s.agentId, s.title, s.layer])).toEqual([
      [0, "research", "查资料", 1],
      [1, "writing", "写文档", 2],
    ]);
  });

  // Rendering "depends on #0" on every row states the obvious and costs a line per step.
  it("leaves the implicit step-to-step dependency out", () => {
    const entry = entryOf(apply(new Map(), PIPELINE_PLAN));
    expect(entry.subtasks.every((s) => s.needsPriorResults.length === 0)).toBe(true);
  });

  // A fixed pipeline has none, and a row reading "no checks" under every step is noise.
  it("carries no acceptance criteria", () => {
    const entry = entryOf(apply(new Map(), PIPELINE_PLAN));
    expect(entry.subtasks.every((s) => s.acceptanceCriteria === null)).toBe(true);
  });

  // The operator chose the pipeline; there is nothing left to approve.
  it("never awaits confirmation", () => {
    const entry = entryOf(apply(new Map(), PIPELINE_PLAN));
    expect(entry.awaitingConfirmation).toBe(false);
    expect(entry.approvalId).toBeNull();
  });

  it("falls back to the agent id when a step has no instruction", () => {
    const entry = entryOf(
      apply(new Map(), {
        ...PIPELINE_PLAN,
        steps: [{ index: 0, agentId: "research", instruction: "" }],
      }),
    );
    // A blank row would be worse than a slightly redundant one.
    expect(entry.subtasks[0]!.title).toBe("research");
  });

  it("rejects a plan with no usable steps", () => {
    expect(applyTaskOrchestratorEvent(new Map(), { ...PIPELINE_PLAN, steps: [] }, 1)).toBeNull();
    expect(
      applyTaskOrchestratorEvent(new Map(), { ...PIPELINE_PLAN, steps: [{ index: 0 }] }, 1),
    ).toBeNull();
  });

  // Same reasoning as `prd`: ids from a previous run refer to a plan that is gone.
  it("clears state left by an earlier run on the same session", () => {
    let state = apply(new Map(), PRD);
    state = apply(state, layerEvent(1, [OK_RESULT]));
    state = apply(state, PIPELINE_PLAN);
    const entry = entryOf(state);
    expect(entry.layers).toEqual([]);
    expect(entry.toolCalls).toEqual([]);
    expect(entry.summarizing).toBeNull();
  });

  // And the reverse, which is what a spread-based reducer would get wrong: a dynamic run
  // after a pipeline run must not inherit `mode: "pipeline"`.
  it("a later decomposition on the same session is dynamic again", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, PRD);
    expect(entryOf(state).mode).toBe("dynamic");
    expect(entryOf(state).pipelineName).toBeNull();
  });
});

describe("step_status", () => {
  it("marks a step running on start and clears it on end", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(0, "start"));
    expect(entryOf(state).runningSubtaskIds).toEqual([0]);
    state = apply(state, stepEvent(0, "end", { status: "ok" }));
    expect(entryOf(state).runningSubtaskIds).toEqual([]);
  });

  it("synthesizes a one-result layer from the end event", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(0, "end", { status: "ok" }));
    expect(entryOf(state).layers).toEqual([
      {
        layer: 1,
        totalLayers: 2,
        results: [{ id: 0, agentId: "research", status: "ok", verifyAttempts: null, error: null }],
      },
    ]);
  });

  it("carries the failure reason inline", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(0, "end", { status: "error", error: "超时" }));
    expect(entryOf(state).layers[0]!.results[0]).toMatchObject({
      status: "error",
      error: "超时",
    });
  });

  it("accepts a skipped step", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(0, "end", { status: "error", error: "boom" }));
    state = apply(state, stepEvent(1, "end", { status: "skipped" }));
    expect(entryOf(state).layers.map((l) => l.results[0]!.status)).toEqual(["error", "skipped"]);
  });

  // This count is what the card compares against the plan to decide "finished", so the
  // skipped steps reporting is what lets an aborted run stop claiming to be running.
  it("an aborted run still accounts for every step", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(0, "end", { status: "error", error: "boom" }));
    state = apply(state, stepEvent(1, "end", { status: "skipped" }));
    const entry = entryOf(state);
    expect(entry.layers).toHaveLength(entry.plannedTotalLayers!);
  });

  it("keeps layers ordered even if two ends arrive out of order", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(1, "end", { status: "ok" }));
    state = apply(state, stepEvent(0, "end", { status: "ok" }));
    expect(entryOf(state).layers.map((l) => l.layer)).toEqual([1, 2]);
  });

  it("ignores a duplicate end for the same step", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, stepEvent(0, "end", { status: "ok" }));
    expect(applyTaskOrchestratorEvent(state, stepEvent(0, "end", { status: "ok" }), 2)).toBeNull();
  });

  it("drops an event with no plan on screen", () => {
    expect(applyTaskOrchestratorEvent(new Map(), stepEvent(0, "start"), 1)).toBeNull();
  });

  it("drops an event for a step outside the plan", () => {
    const state = apply(new Map(), PIPELINE_PLAN);
    expect(applyTaskOrchestratorEvent(state, stepEvent(9, "start"), 2)).toBeNull();
  });

  it("drops an end with no outcome", () => {
    const state = apply(new Map(), PIPELINE_PLAN);
    expect(applyTaskOrchestratorEvent(state, stepEvent(0, "end"), 2)).toBeNull();
  });

  // The plugin already emits these, keyed off the same subtaskId the pipeline writes into
  // its delegation metadata — they were only being dropped for want of a plan to attach
  // to. This is the test that the relay works end to end in pipeline mode.
  it("lets tool activity attach to a pipeline step", () => {
    let state = apply(new Map(), PIPELINE_PLAN);
    state = apply(state, {
      plugin: "dragon-task-orchestrator",
      type: "dragon_task_progress",
      kind: "subtask_tool",
      rootSessionKey: "agent:main:main",
      subtaskId: 1,
      toolName: "web_search",
      phase: "start",
      role: "work",
      summary: "query=arm64",
    });
    expect(entryOf(state).toolCalls).toEqual([
      {
        subtaskId: 1,
        toolName: "web_search",
        phase: "start",
        role: "work",
        summary: "query=arm64",
        error: null,
      },
    ]);
  });
});
