// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for the gateway event payloads consumed by the Control UI.
 *
 * The UI's parser is strict (ui/src/ui/chat/task-orchestrator-events.ts drops
 * anything it cannot read), so the exact payload shape is a contract between the
 * two sides rather than an implementation detail.
 */

import { describe, expect, test, vi } from "vitest";
import {
  emitLayerProgressEvent,
  emitPrdEvent,
  emitRedecomposingEvent,
  emitSubtaskStatusEvent,
  emitSubtaskToolEvent,
  emitSummarizingEvent,
  PROGRESS_EVENT_TYPE,
  summarizeToolPayload,
} from "../src/progress-event.js";
import type { SubtaskPlan, SubtaskResult } from "../src/types.js";

const SUBTASKS: SubtaskPlan[] = [
  { id: 0, title: "查资料", description: "查资料" },
  { id: 1, title: "写代码", description: "写代码", needsPriorResults: [0], acceptanceCriteria: "覆盖单测" },
];

const AGENT_OF = new Map([
  [0, "research"],
  [1, "coding"],
]);

const LAYER_OF = new Map([
  [0, 1],
  [1, 2],
]);

describe("emitPrdEvent", () => {
  test("omitting the approval fields marks the plan as not awaiting confirmation", () => {
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "agent:main:main",
      subtasks: SUBTASKS,
      agentIdOf: AGENT_OF,
      defaultAgentId: "main",
      layerOf: LAYER_OF,
      totalLayers: 2,
    });

    const [, payload] = emitEvent.mock.calls[0]!;
    expect(payload).toMatchObject({ approvalId: null, awaitingConfirmation: false });
  });

  test("an approvalId puts the plan into its awaiting-confirmation state", () => {
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "agent:main:main",
      subtasks: SUBTASKS,
      agentIdOf: AGENT_OF,
      defaultAgentId: "main",
      layerOf: LAYER_OF,
      totalLayers: 2,
      approvalId: "abc-123",
      awaitingConfirmation: true,
    });

    const [, payload] = emitEvent.mock.calls[0]!;
    expect(payload).toMatchObject({ approvalId: "abc-123", awaitingConfirmation: true });
  });

  test("emits the routing, acceptance criteria and layer for every subtask", () => {
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "agent:main:main",
      subtasks: SUBTASKS,
      agentIdOf: AGENT_OF,
      defaultAgentId: "main",
      layerOf: LAYER_OF,
      totalLayers: 2,
    });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitEvent.mock.calls[0]!;
    expect(eventType).toBe(PROGRESS_EVENT_TYPE);
    expect(payload).toMatchObject({ kind: "prd", rootSessionKey: "agent:main:main", totalLayers: 2 });
    expect(payload.subtasks).toEqual([
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
        acceptanceCriteria: "覆盖单测",
        needsPriorResults: [0],
        layer: 2,
      },
    ]);
  });

  test("unresolved subtasks fall back to the default agent", () => {
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "s",
      subtasks: [SUBTASKS[0]!],
      agentIdOf: new Map(),
      defaultAgentId: "main",
      layerOf: LAYER_OF,
      totalLayers: 2,
    });
    expect(emitEvent.mock.calls[0]![1].subtasks[0]).toMatchObject({ agentId: "main" });
  });

  // Regression: the pre-routing broadcast must be distinguishable from a resolved
  // one. Falling back to defaultAgentId here would make the card claim every subtask
  // is assigned to the fallback agent for the tens of seconds routing takes.
  test("omitting agentIdOf reports agentId null rather than the default agent", () => {
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "s",
      subtasks: SUBTASKS,
      defaultAgentId: "main",
      layerOf: LAYER_OF,
      totalLayers: 2,
    });
    const payload = emitEvent.mock.calls[0]![1];
    expect(payload.subtasks.map((s: { agentId: string | null }) => s.agentId)).toEqual([null, null]);
  });

  test("the pre-routing broadcast still carries structure, criteria and layers", () => {
    // This is the whole point of publishing early: everything except routing is
    // already known when decomposition returns.
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "s",
      subtasks: SUBTASKS,
      defaultAgentId: "main",
      layerOf: LAYER_OF,
      totalLayers: 2,
    });
    const payload = emitEvent.mock.calls[0]![1];
    expect(payload.totalLayers).toBe(2);
    expect(payload.subtasks[0]).toMatchObject({
      id: SUBTASKS[0]!.id,
      title: SUBTASKS[0]!.title,
      layer: LAYER_OF.get(SUBTASKS[0]!.id) ?? null,
    });
  });

  test("a subtask absent from layerOf reports layer null", () => {
    const emitEvent = vi.fn();
    emitPrdEvent(emitEvent, {
      rootSessionKey: "s",
      subtasks: [SUBTASKS[0]!],
      agentIdOf: AGENT_OF,
      defaultAgentId: "main",
      layerOf: new Map(),
      totalLayers: 0,
    });
    expect(emitEvent.mock.calls[0]![1].subtasks[0]).toMatchObject({ layer: null });
  });

  test("no emitter configured means no call and no throw", () => {
    expect(() =>
      emitPrdEvent(undefined, {
        rootSessionKey: "s",
        subtasks: SUBTASKS,
        agentIdOf: AGENT_OF,
        defaultAgentId: "main",
        layerOf: LAYER_OF,
        totalLayers: 2,
      }),
    ).not.toThrow();
  });

  // Broadcasting is decoration on top of the final reply, so a throwing host
  // must not propagate into the pipeline.
  test("a throwing emitter is swallowed and logged", () => {
    const warn = vi.fn();
    expect(() =>
      emitPrdEvent(
        () => {
          throw new Error("gateway down");
        },
        {
          rootSessionKey: "s",
          subtasks: SUBTASKS,
          agentIdOf: AGENT_OF,
          defaultAgentId: "main",
          layerOf: LAYER_OF,
          totalLayers: 2,
        },
        { warn, info: vi.fn() },
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("emitRedecomposingEvent", () => {
  // Re-decomposition takes ~62s while the RPC that triggers it returns in ms, so this
  // event is the only thing marking that window. It also settles the gate.
  test("broadcasts the redecomposing kind with the operator's wording", () => {
    const emitEvent = vi.fn();
    emitRedecomposingEvent(emitEvent, { rootSessionKey: "s", adjustment: "把 2 和 3 合并" });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0]![0]).toBe(PROGRESS_EVENT_TYPE);
    expect(emitEvent.mock.calls[0]![1]).toEqual({
      kind: "redecomposing",
      rootSessionKey: "s",
      adjustment: "把 2 和 3 合并",
    });
  });

  test("truncates an over-long adjustment rather than broadcasting it whole", () => {
    const emitEvent = vi.fn();
    emitRedecomposingEvent(emitEvent, { rootSessionKey: "s", adjustment: "调".repeat(400) });
    const sent = emitEvent.mock.calls[0]![1].adjustment as string;
    expect(sent.length).toBeLessThan(400);
  });

  test("no emitter configured means no call and no throw", () => {
    expect(() =>
      emitRedecomposingEvent(undefined, { rootSessionKey: "s", adjustment: "x" }),
    ).not.toThrow();
  });

  test("an emitter that throws is swallowed, like every other broadcast here", () => {
    const emitEvent = vi.fn(() => {
      throw new Error("socket closed");
    });
    expect(() =>
      emitRedecomposingEvent(emitEvent, { rootSessionKey: "s", adjustment: "x" }),
    ).not.toThrow();
  });
});

describe("emitSummarizingEvent", () => {
  // Summarizing was measured at 136s — 17% of an 819s request — during which the card
  // already showed every subtask done. This event is what stops that from reading as
  // "finished but no answer".
  test("broadcasts the summarizing kind with the success counts", () => {
    const emitEvent = vi.fn();
    emitSummarizingEvent(emitEvent, { rootSessionKey: "s", okCount: 2, totalCount: 3 });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0]![0]).toBe(PROGRESS_EVENT_TYPE);
    expect(emitEvent.mock.calls[0]![1]).toEqual({
      kind: "summarizing",
      rootSessionKey: "s",
      okCount: 2,
      totalCount: 3,
    });
  });

  test("no emitter configured means no call and no throw", () => {
    expect(() =>
      emitSummarizingEvent(undefined, { rootSessionKey: "s", okCount: 1, totalCount: 1 }),
    ).not.toThrow();
  });

  test("an emitter that throws is swallowed, like every other broadcast here", () => {
    const emitEvent = vi.fn(() => {
      throw new Error("socket closed");
    });
    expect(() =>
      emitSummarizingEvent(emitEvent, { rootSessionKey: "s", okCount: 1, totalCount: 1 }),
    ).not.toThrow();
  });
});

describe("emitLayerProgressEvent", () => {
  const layerResults: SubtaskResult[] = [
    { id: 0, agentId: "research", text: "t", status: "ok", processingNotices: [], verifyAttempts: 2 },
    { id: 1, agentId: "coding", text: "", status: "error", error: "校验未通过" },
  ];

  test("emits per-result status, attempts and error text", () => {
    const emitEvent = vi.fn();
    emitLayerProgressEvent(emitEvent, {
      rootSessionKey: "agent:main:main",
      layer: 1,
      totalLayers: 2,
      layerResults,
    });

    const [eventType, payload] = emitEvent.mock.calls[0]!;
    expect(eventType).toBe(PROGRESS_EVENT_TYPE);
    expect(payload).toMatchObject({ kind: "layer_progress", layer: 1, totalLayers: 2 });
    expect(payload.results).toEqual([
      { id: 0, agentId: "research", status: "ok", verifyAttempts: 2, error: null },
      { id: 1, agentId: "coding", status: "error", verifyAttempts: null, error: "校验未通过" },
    ]);
  });

  test("an empty layer still reports its position", () => {
    const emitEvent = vi.fn();
    emitLayerProgressEvent(emitEvent, {
      rootSessionKey: "s",
      layer: 2,
      totalLayers: 2,
      layerResults: [],
    });
    expect(emitEvent.mock.calls[0]![1]).toMatchObject({ layer: 2, results: [] });
  });

  test("a throwing emitter is swallowed", () => {
    expect(() =>
      emitLayerProgressEvent(
        () => {
          throw new Error("gateway down");
        },
        { rootSessionKey: "s", layer: 1, totalLayers: 1, layerResults },
      ),
    ).not.toThrow();
  });
});

describe("summarizeToolPayload", () => {
  test("prefers an identifying key over dumping the whole object", () => {
    expect(summarizeToolPayload({ url: "https://example.com/a", maxChars: 8000 })).toBe(
      "url=https://example.com/a",
    );
    expect(summarizeToolPayload({ file_path: "/tmp/x.ts", content: "…" })).toBe(
      "file_path=/tmp/x.ts",
    );
  });

  test("falls back to JSON when no identifying key is present", () => {
    expect(summarizeToolPayload({ a: 1 })).toBe('{"a":1}');
  });

  test("reports array length rather than contents", () => {
    expect(summarizeToolPayload([1, 2, 3])).toBe("3 项");
  });

  test("handles scalars and empties", () => {
    expect(summarizeToolPayload("  hi  ")).toBe("hi");
    expect(summarizeToolPayload(42)).toBe("42");
    expect(summarizeToolPayload(null)).toBe("");
    expect(summarizeToolPayload(undefined)).toBe("");
  });

  test("survives an unserializable object instead of throwing", () => {
    const circular: Record<string, unknown> = { name: 1 };
    circular.self = circular;
    expect(summarizeToolPayload(circular)).toBe("name,self");
  });

  test("caps long values, since this is broadcast to every connected client", () => {
    const out = summarizeToolPayload({ url: `https://example.com/${"x".repeat(500)}` });
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe("emitSubtaskToolEvent", () => {
  const base = {
    rootSessionKey: "agent:main:main",
    subtaskId: 1,
    agentId: "coding",
    role: "work" as const,
    toolName: "web_fetch",
  };

  test("emits a start phase with the condensed params", () => {
    const emitEvent = vi.fn();
    emitSubtaskToolEvent(emitEvent, { ...base, phase: "start", summary: "url=https://x.dev" });

    const [eventType, payload] = emitEvent.mock.calls[0]!;
    expect(eventType).toBe(PROGRESS_EVENT_TYPE);
    expect(payload).toMatchObject({
      kind: "subtask_tool",
      subtaskId: 1,
      agentId: "coding",
      role: "work",
      toolName: "web_fetch",
      phase: "start",
      summary: "url=https://x.dev",
      error: null,
    });
  });

  test("emits an error on the result phase", () => {
    const emitEvent = vi.fn();
    emitSubtaskToolEvent(emitEvent, { ...base, phase: "result", error: "404" });

    const [, payload] = emitEvent.mock.calls[0]!;
    expect(payload).toMatchObject({ phase: "result", error: "404", summary: null });
  });

  test("a missing emitEvent is a no-op rather than a throw", () => {
    expect(() =>
      emitSubtaskToolEvent(undefined, { ...base, phase: "start" }),
    ).not.toThrow();
  });

  test("a throwing emitEvent is swallowed, since this is decoration", () => {
    const emitEvent = vi.fn(() => {
      throw new Error("socket closed");
    });
    expect(() =>
      emitSubtaskToolEvent(emitEvent, { ...base, phase: "start" }),
    ).not.toThrow();
  });
});

describe("summarizeToolPayload unwraps the MCP result envelope", () => {
  // Regression: every RESULT summary used to be spent on the envelope itself —
  // observed as {"content":[{"type":"text","text":"{\n  \"query\"… with the real
  // payload cut off. Arguments never have this shape, so only results looked broken.
  test("a write result reads as its message instead of JSON scaffolding", () => {
    const out = summarizeToolPayload({
      content: [{ type: "text", text: "Successfully wrote 3308 bytes to cpp_template_notes.md" }],
    });
    expect(out).toBe("Successfully wrote 3308 bytes to cpp_template_notes.md");
    expect(out).not.toContain('"content"');
  });

  test("salient keys are still extracted from JSON text inside the envelope", () => {
    const out = summarizeToolPayload({
      content: [{ type: "text", text: '{"url": "https://example.com/a", "body": "…"}' }],
    });
    // Unwrapped to a string, so it is reported as the text — not as envelope keys.
    expect(out).toContain("https://example.com/a");
    expect(out).not.toContain('"content"');
  });

  test("multiple text parts are joined rather than silently dropping the rest", () => {
    const out = summarizeToolPayload({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(out).toBe("first\nsecond");
  });

  test("non-text parts fall back to the generic path instead of an empty summary", () => {
    const out = summarizeToolPayload({ content: [{ type: "image", data: "…" }] });
    expect(out.length).toBeGreaterThan(0);
  });

  test("a long unwrapped result is still capped", () => {
    const out = summarizeToolPayload({
      content: [{ type: "text", text: "x".repeat(50_000) }],
    });
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("arguments are unaffected — no envelope, salient key still wins", () => {
    expect(summarizeToolPayload({ url: "https://example.com/a", maxChars: 8000 })).toBe(
      "url=https://example.com/a",
    );
    expect(summarizeToolPayload({ command: "g++ -std=c++17 main.cpp" })).toBe(
      "command=g++ -std=c++17 main.cpp",
    );
  });
});

describe("emitSubtaskStatusEvent", () => {
  const base = { rootSessionKey: "agent:main:main", subtaskId: 1, agentId: "coding" };

  test("emits a start phase so the card can show a running indicator", () => {
    const emitEvent = vi.fn();
    emitSubtaskStatusEvent(emitEvent, { ...base, phase: "start" });

    const [eventType, payload] = emitEvent.mock.calls[0]!;
    expect(eventType).toBe(PROGRESS_EVENT_TYPE);
    expect(payload).toMatchObject({
      kind: "subtask_status",
      subtaskId: 1,
      agentId: "coding",
      phase: "start",
    });
  });

  test("emits an end phase", () => {
    const emitEvent = vi.fn();
    emitSubtaskStatusEvent(emitEvent, { ...base, phase: "end" });
    expect(emitEvent.mock.calls[0]![1]).toMatchObject({ phase: "end" });
  });

  test("a missing or throwing emitter never propagates", () => {
    expect(() => emitSubtaskStatusEvent(undefined, { ...base, phase: "start" })).not.toThrow();
    expect(() =>
      emitSubtaskStatusEvent(
        () => {
          throw new Error("gateway down");
        },
        { ...base, phase: "start" },
      ),
    ).not.toThrow();
  });
});
