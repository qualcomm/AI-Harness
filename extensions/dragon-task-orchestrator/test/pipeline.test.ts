/**
 * Tests for dependency layering and layered execution (tasks 4.10/4.11/4.12).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initArtifactRoot, resetArtifactRoot } from "../src/artifacts.js";
import { resetDelegationMetaStore } from "../src/delegation-meta.js";
import {
  idsWithDownstreamConsumers,
  layerByDependency,
  resolveAgentsFor,
  runPipeline,
} from "../src/pipeline.js";
import { resetVerifierQueues } from "../src/verify.js";
import type { SubagentRuntime } from "../src/runtime-contract.js";
import { childSessionKeyFor } from "../src/session-key.js";
import type { SubtaskPlan } from "../src/types.js";
import { testConfig } from "./test-helpers.js";

// resolveAgentForSubtask normally classifies via a real local-model HTTP call.
// Pipeline tests care about scheduling/grouping/timeout behavior, not
// classification accuracy, so it is replaced with a deterministic mapping
// keyed by subtask description. The rest of the module is kept intact —
// verify.ts imports `parseJsonObject` from here, and stubbing the whole module
// would leave that undefined at call time.
const agentByDescription = new Map<string, string>();
vi.mock("../src/resolve-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-agent.js")>()),
  resolveAgentForSubtask: vi.fn(async (_cfg: unknown, s: SubtaskPlan) =>
    agentByDescription.get(s.description) ?? "default",
  ),
}));

function sub(id: number, description: string, deps?: number[]): SubtaskPlan {
  return { id, title: description, description, ...(deps !== undefined && { needsPriorResults: deps }) };
}

describe("layerByDependency (task 4.10)", () => {
  test("independent subtasks land in one layer", () => {
    const { layers, unschedulable } = layerByDependency([sub(0, "a"), sub(1, "b"), sub(2, "c")]);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(3);
    expect(unschedulable).toHaveLength(0);
  });

  test("a linear chain degrades to N layers of one", () => {
    const { layers } = layerByDependency([
      sub(0, "a"),
      sub(1, "b", [0]),
      sub(2, "c", [1]),
      sub(3, "d", [2]),
    ]);
    expect(layers.map((l) => l.length)).toEqual([1, 1, 1, 1]);
    expect(layers.map((l) => l[0]!.id)).toEqual([0, 1, 2, 3]);
  });

  test("a diamond dependency layers correctly", () => {
    const { layers } = layerByDependency([
      sub(0, "a"),
      sub(1, "b", [0]),
      sub(2, "c", [0]),
      sub(3, "d", [1, 2]),
    ]);
    expect(layers).toHaveLength(3);
    expect(layers[0]!.map((s) => s.id)).toEqual([0]);
    expect(layers[1]!.map((s) => s.id).sort()).toEqual([1, 2]);
    expect(layers[2]!.map((s) => s.id)).toEqual([3]);
  });

  test("an unschedulable subtask is reported, not silently dropped", () => {
    // This should not occur after validation, but the layering step must not
    // silently swallow it if some future change lets it through.
    const { layers, unschedulable } = layerByDependency([
      sub(0, "a", [99]), // dependency never exists in this list
    ]);
    expect(layers).toHaveLength(0);
    expect(unschedulable.map((s) => s.id)).toEqual([0]);
  });

  test("partially unschedulable: schedulable subtasks still run", () => {
    const { layers, unschedulable } = layerByDependency([sub(0, "a"), sub(1, "b", [99])]);
    expect(layers[0]!.map((s) => s.id)).toEqual([0]);
    expect(unschedulable.map((s) => s.id)).toEqual([1]);
  });

  test("empty input yields no layers", () => {
    expect(layerByDependency([])).toEqual({ layers: [], unschedulable: [] });
  });
});

/** Fake subagent runtime whose `behavior` decides ok/timeout per call. */
function makeTrackedSubagent(
  behavior: (sessionKey: string, message: string) => "ok" | "timeout",
  textFor: (sessionKey: string, message: string) => string = (_s, m) => `echo:${m}`,
): { runtime: SubagentRuntime; runCount: () => number } {
  let counter = 0;
  const runMeta = new Map<string, { sessionKey: string; message: string }>();
  const lastTextBySession = new Map<string, string>();

  const runtime: SubagentRuntime = {
    run: vi.fn(async ({ sessionKey, message }) => {
      counter++;
      const runId = `run-${counter}`;
      runMeta.set(runId, { sessionKey, message });
      return { runId };
    }),
    waitForRun: vi.fn(async ({ runId }) => {
      const meta = runMeta.get(runId);
      if (!meta) return { status: "error" as const };
      const outcome = behavior(meta.sessionKey, meta.message);
      if (outcome === "ok") {
        lastTextBySession.set(meta.sessionKey, textFor(meta.sessionKey, meta.message));
      }
      return { status: outcome };
    }),
    getSessionMessages: vi.fn(async ({ sessionKey }) => ({
      messages: [{ role: "assistant", content: lastTextBySession.get(sessionKey) ?? "" }],
    })),
  };
  return { runtime, runCount: () => counter };
}

/**
 * Resolve routing then execute, mirroring what orchestrator.ts does. Routing moved
 * out of `runPipeline` so the confirmation gate can show assignments before
 * execution, so these tests do the same two steps.
 */
async function runPipelineWithRouting(
  deps: Parameters<typeof runPipeline>[0],
  subtasks: SubtaskPlan[],
) {
  const agentIdOf = await resolveAgentsFor(deps, subtasks);
  return await runPipeline(deps, subtasks, agentIdOf);
}

describe("runPipeline (tasks 4.11/4.12)", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
    agentByDescription.clear();
  });

  test("different agents in a layer run without collision-based serialization", async () => {
    agentByDescription.set("task for coding", "coding");
    agentByDescription.set("task for research", "research");
    const { runtime } = makeTrackedSubagent(() => "ok");
    const cfg = testConfig();
    const subtasks = [sub(0, "task for coding"), sub(1, "task for research")];

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding", "research"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );

    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  // Regression: same-agent subtasks used to share one child session, so the host's
  // per-session queue serialized them. A layer with two `research` subtasks measured
  // 5m45s where ~3m of concurrent work was available.
  test("same-agent subtasks get distinct sessions so they are not serialized", async () => {
    const seen: string[] = [];
    const { runtime } = makeTrackedSubagent(
      () => "ok",
      (sessionKey) => {
        seen.push(sessionKey);
        return "done";
      },
    );
    agentByDescription.set("task-0", "coding");
    agentByDescription.set("task-1", "coding");
    const subtasks = [sub(0, "task-0"), sub(1, "task-1")];

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    // Both routed to "coding", yet on different sessions — which is what lets the
    // host run them in parallel.
    expect(results.map((r) => r.agentId)).toEqual(["coding", "coding"]);
    expect(new Set(seen).size).toBe(2);
  });

  test("same-agent subtasks actually overlap in time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime: SubagentRuntime = {
      run: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { runId: `run-${Math.random()}` };
      }),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "done" }],
      })),
    };
    agentByDescription.set("task-0", "coding");
    agentByDescription.set("task-1", "coding");

    await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [sub(0, "task-0"), sub(1, "task-1")],
    );

    expect(maxInFlight).toBe(2);
  });

  test("unschedulable subtasks are reported as errors, not dropped", async () => {
    const { runtime } = makeTrackedSubagent(() => "ok");
    const cfg = testConfig();
    const subtasks = [sub(0, "a", [99])]; // dangling — should never happen post-validation

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("error");
  });

  test("a throwing reportProgress hook does not abort the pipeline", async () => {
    const { runtime } = makeTrackedSubagent(() => "ok");
    agentByDescription.set("a", "coding");
    const cfg = testConfig();
    const subtasks = [sub(0, "a"), sub(1, "b", [0])];

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
        reportProgress: () => {
          throw new Error("feedback hook exploded");
        },
      },
      subtasks,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  // Replaces an older case asserting that a timeout skipped the rest of its agent
  // group without issuing a second delegation. That skip existed only because
  // same-agent subtasks shared one child session: reusing a key whose run might still
  // be in flight was the hazard. Sessions are per-subtask now, so a timeout on one
  // subtask has no bearing on its siblings — every subtask gets its own delegation
  // and its own result.
  test("a timeout affects only the subtask that timed out, not its siblings", async () => {
    const { runtime, runCount } = makeTrackedSubagent((_sessionKey, message) =>
      message.includes("times out") ? "timeout" : "ok",
    );
    agentByDescription.set("times out", "coding");
    agentByDescription.set("succeeds", "coding");
    const subtasks = [sub(0, "times out"), sub(1, "succeeds")];

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );

    expect(results).toHaveLength(2);
    // Both were actually delegated — no sibling was skipped on the other's behalf.
    expect(runCount()).toBe(2);
    expect(results.find((r) => r.id === 0)!.status).toBe("error");
    expect(results.find((r) => r.id === 1)!.status).toBe("ok");
  });

  test("every subtask in a layer times out independently", async () => {
    const { runtime, runCount } = makeTrackedSubagent(() => "timeout");
    agentByDescription.set("a", "coding");
    agentByDescription.set("b", "coding");
    const subtasks = [sub(0, "a"), sub(1, "b")];

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "error")).toBe(true);
    // Each reports its own timeout rather than one being marked "skipped".
    expect(runCount()).toBe(2);
    expect(results.some((r) => r.status === "error" && r.error.includes("已跳过"))).toBe(false);
  });
});

/**
 * The verifier runs on its own derived child session, so tests distinguish
 * worker calls from verify calls by the message shape rather than by session key
 * (which is hashed and not predictable from the test).
 */
function isVerifyCall(message: string): boolean {
  return message.includes("Worker 结果");
}

describe("runPipeline verify loop", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
    resetVerifierQueues();
    agentByDescription.clear();
  });

  test("failing once then passing yields ok, with the attempt count reported", async () => {
    let verifyCalls = 0;
    const { runtime, runCount } = makeTrackedSubagent(
      () => "ok",
      (_s, message) => {
        if (!isVerifyCall(message)) return "worker output";
        verifyCalls++;
        return verifyCalls === 1
          ? '{"passed": false, "feedback": "缺少测试"}'
          : '{"passed": true, "feedback": "ok"}';
      },
    );
    agentByDescription.set("a", "coding");
    const cfg = testConfig();

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [{ ...sub(0, "a"), acceptanceCriteria: "有测试覆盖" }],
    );

    const only = results[0]!;
    expect(only.status).toBe("ok");
    if (only.status === "ok") {
      expect(only.verifyAttempts).toBe(2);
      expect(only.processingNotices.some((n) => n.includes("2 次校验通过"))).toBe(true);
    }
    // 2 worker calls + 2 verify calls: the retry reuses the same worker session.
    expect(runCount()).toBe(4);
    expect(verifyCalls).toBe(2);
  });

  test("exhausting maxVerifyRetries yields an error carrying the last feedback", async () => {
    let verifyCalls = 0;
    const { runtime } = makeTrackedSubagent(
      () => "ok",
      (_s, message) => {
        if (!isVerifyCall(message)) return "worker output";
        verifyCalls++;
        return '{"passed": false, "feedback": "仍然缺少测试"}';
      },
    );
    agentByDescription.set("a", "coding");
    const cfg = testConfig({ maxVerifyRetries: 2 });

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [{ ...sub(0, "a"), acceptanceCriteria: "有测试覆盖" }],
    );

    const only = results[0]!;
    expect(only.status).toBe("error");
    if (only.status === "error") {
      expect(only.error).toContain("仍然缺少测试");
      expect(only.error).toContain("3");
    }
    // maxVerifyRetries=2 means 3 attempts total, no more.
    expect(verifyCalls).toBe(3);
  });

  test("an unparsable verifier response counts as a failure, never a pass", async () => {
    const { runtime } = makeTrackedSubagent(
      () => "ok",
      (_s, message) => (isVerifyCall(message) ? "看起来还行吧" : "worker output"),
    );
    agentByDescription.set("a", "coding");
    const cfg = testConfig({ maxVerifyRetries: 0 });

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [{ ...sub(0, "a"), acceptanceCriteria: "有测试覆盖" }],
    );

    expect(results[0]!.status).toBe("error");
  });

  test("a worker with no acceptance criteria skips verification entirely", async () => {
    let verifyCalls = 0;
    const { runtime, runCount } = makeTrackedSubagent(
      () => "ok",
      (_s, message) => {
        if (isVerifyCall(message)) verifyCalls++;
        return "worker output";
      },
    );
    agentByDescription.set("a", "coding");
    // No acceptanceCriteria declared for this subtask.
    const cfg = testConfig();

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [sub(0, "a")],
    );

    expect(results[0]!.status).toBe("ok");
    expect(verifyCalls).toBe(0);
    expect(runCount()).toBe(1);
  });

  test("a failed worker execution is never sent to the verifier", async () => {
    let verifyCalls = 0;
    const { runtime } = makeTrackedSubagent(
      () => "timeout",
      (_s, message) => {
        if (isVerifyCall(message)) verifyCalls++;
        return "worker output";
      },
    );
    agentByDescription.set("a", "coding");
    const cfg = testConfig();

    const { results } = await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [{ ...sub(0, "a"), acceptanceCriteria: "有测试覆盖" }],
    );

    expect(results[0]!.status).toBe("error");
    expect(verifyCalls).toBe(0);
  });

  test("resolveAgentsFor returns the routing for every subtask", async () => {
    agentByDescription.set("a", "coding");
    agentByDescription.set("b", "research");

    const agentIdOf = await resolveAgentsFor(
      {
        subagent: makeTrackedSubagent(() => "ok").runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding", "research"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [sub(0, "a"), sub(1, "b")],
    );

    expect(agentIdOf.get(0)).toBe("coding");
    expect(agentIdOf.get(1)).toBe("research");
    expect(agentIdOf.size).toBe(2);
  });

  test("runPipeline executes against the routing it is given, not one it derives", async () => {
    // The caller (orchestrator.ts) owns routing so the confirmation gate can show
    // assignments before execution; the pipeline must honour that map verbatim
    // rather than reclassifying and possibly disagreeing.
    const seenSessionKeys: string[] = [];
    const runtime: SubagentRuntime = {
      run: vi.fn(async ({ sessionKey }) => {
        seenSessionKeys.push(sessionKey);
        return { runId: "run-1" };
      }),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "done" }],
      })),
    };
    // Deliberately contradicts agentByDescription, which would say "coding".
    agentByDescription.set("a", "coding");

    const { results } = await runPipeline(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding", "research"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      [sub(0, "a")],
      new Map([[0, "research"]]),
    );

    expect(results[0]!.agentId).toBe("research");
    expect(seenSessionKeys[0]).toContain("research");
  });

  test("reportProgress receives only the results of the layer that just finished", async () => {
    const { runtime } = makeTrackedSubagent(() => "ok");
    agentByDescription.set("a", "coding");
    agentByDescription.set("b", "research");
    const layerSizes: Array<{ done: number; total: number; indexes: number[] }> = [];

    await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["coding", "research"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
        reportProgress: (done, total, layerResults) =>
          layerSizes.push({ done, total, indexes: layerResults.map((r) => r.id) }),
      },
      [sub(0, "a"), sub(1, "b", [0])],
    );

    expect(layerSizes).toEqual([
      { done: 1, total: 2, indexes: [0] },
      { done: 2, total: 2, indexes: [1] },
    ]);
  });
});

/**
 * Hand-off guidance (方案 E).
 *
 * Only the worker's final assistant message reaches a dependent subtask — tool results
 * and intermediate turns do not. Workers cannot know that, and in the 2026-08-27 run one
 * ended with a mid-progress note, so its 26 tool calls reached its consumer as nothing.
 * These tests pin that the guidance is delivered, and delivered only where it applies.
 */
describe("downstream hand-off guidance", () => {
  // The artifact channel is normally initialized from the plugin's service `start`, which
  // no test runs. Without a root the file route is omitted entirely by design (a handle
  // that cannot be dereferenced is worse than none), so these tests supply a real
  // temporary one rather than asserting against the degraded path.
  beforeEach(() => {
    resetDelegationMetaStore();
    agentByDescription.clear();
    initArtifactRoot(fs.mkdtempSync(path.join(os.tmpdir(), "dt-artifacts-")));
  });

  afterEach(() => {
    resetArtifactRoot();
  });

  /**
   * Every message the fake runtime was asked to run, in order.
   *
   * The result text deliberately does NOT echo the request: the default `echo:${m}`
   * would put a producer's description inside its consumer's prior-context block, and
   * then `find(m => m.includes("gather"))` could match either call.
   */
  function captureMessages() {
    const seen: Array<{ sessionKey: string; message: string }> = [];
    const { runtime } = makeTrackedSubagent(
      (sessionKey, message) => {
        seen.push({ sessionKey, message });
        return "ok";
      },
      () => "OPAQUE_RESULT",
    );
    return { runtime, seen };
  }

  async function run(runtime: SubagentRuntime, subtasks: SubtaskPlan[], cfg = testConfig()) {
    return await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg,
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["default"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );
  }

  test("tells a subtask that something depends on it", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const producer = seen.find((c) => c.message.includes("gather"))!;
    expect(producer.message).toContain("后续子任务只能看到你这次回复的最终正文");
    expect(producer.message).toContain("看不到你的工具调用结果");
  });

  // A leaf's output goes to the summarizer, which has its own budget. The advice would
  // be noise there, and noise in a prompt is not free.
  test("says nothing to a subtask nothing depends on", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const leaf = seen.find((c) => c.message.includes("write"))!;
    expect(leaf.message).not.toContain("后续子任务只能看到");
  });

  test("states the actual configured budget, not a hardcoded number", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])], testConfig({ maxContextChars: 9999 }));

    const producer = seen.find((c) => c.message.includes("gather"))!;
    expect(producer.message).toContain("9999");
  });

  /**
   * The overflow route names a REAL directory, addressed absolutely.
   *
   * This assertion is the reverse of what it used to be, deliberately. Two earlier
   * versions both failed, in opposite directions: "给出文件路径" implied a path the
   * consumer could reuse (it could not — relative paths resolve per-agent), and the
   * "工作区文件 + 文件名" wording that replaced it was unusable for the same underlying
   * reason. The 2026-08-31 00:48 run measured the cost: ENOENT on
   * `...\workspace\writing\writing\hexicorridor_tourism.md`, 13 exec calls spent hunting,
   * then a silent rewrite from the truncated summary, and the subtask still reported ok.
   *
   * A path is now correct to promise because the plugin creates the directory itself and
   * hands over an absolute path, which does not depend on the agent's cwd (see
   * artifacts.ts). The old wording must not come back.
   */
  test("offers an overflow route pointing at the shared artifact directory", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const producer = seen.find((c) => c.message.includes("gather"))!;
    expect(producer.message).toContain("共享产物目录");
    expect(producer.message).toContain("绝对路径");
    // The per-agent workspace is exactly what cannot be used for a hand-off.
    expect(producer.message).not.toContain("写入工作区文件");
  });

  /**
   * Position matters twice over: the notice constrains the output rather than being part
   * of the task, and the tail is the position `truncateKeepTail` protects.
   */
  test("places the guidance after the task description", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const producer = seen.find((c) => c.message.includes("gather"))!;
    expect(producer.message.indexOf("gather")).toBeLessThan(
      producer.message.indexOf("【关于你的输出如何被使用】"),
    );
  });

  // "Is anything consuming me" is not a layer-local question: a layer-1 subtask can be
  // depended on by layer 3.
  test("covers a dependency that skips a layer", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "middle"), sub(2, "final", [0, 1])]);

    for (const marker of ["gather", "middle"]) {
      const producer = seen.find((c) => c.message.includes(marker))!;
      expect(producer.message, marker).toContain("后续子任务只能看到");
    }
  });
});

describe("idsWithDownstreamConsumers", () => {
  test("collects every id that appears in some needsPriorResults", () => {
    expect(
      idsWithDownstreamConsumers([sub(0, "a"), sub(1, "b", [0]), sub(2, "c", [0, 1])]),
    ).toEqual(new Set([0, 1]));
  });

  test("returns empty when nothing declares a dependency", () => {
    expect(idsWithDownstreamConsumers([sub(0, "a"), sub(1, "b")])).toEqual(new Set());
  });

  test("ignores a self-reference rather than throwing", () => {
    // layerByDependency already treats this as unschedulable; this function only has to
    // not misbehave on it.
    expect(idsWithDownstreamConsumers([sub(0, "a", [0])])).toEqual(new Set([0]));
  });
});

/**
 * Hand-off contract (方案 D).
 *
 * A named checklist of facts the consumer needs, rather than a JSON schema — workers
 * legitimately produce prose and documents, so dictating a wire format would fight the
 * task. What downstream actually loses is specific figures and sources, and those are
 * what a checklist pins.
 *
 * The contract reaches TWO prompts, and both halves matter: the worker's, so it knows
 * what to include, and the verifier's, so omitting an item fails rather than passing
 * quietly.
 */
describe("hand-off contract", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
    agentByDescription.clear();
  });

  function subWithContract(
    id: number,
    description: string,
    contract: string[],
    deps?: number[],
  ): SubtaskPlan {
    return { ...sub(id, description, deps), handoffContract: contract };
  }

  function captureAll() {
    const seen: string[] = [];
    const { runtime } = makeTrackedSubagent(
      (_sessionKey, message) => {
        seen.push(message);
        return "ok";
      },
      // Verifier replies must parse as its JSON verdict, or every subtask fails.
      () => JSON.stringify({ passed: true, feedback: "" }),
    );
    return { runtime, seen };
  }

  async function run(runtime: SubagentRuntime, subtasks: SubtaskPlan[]) {
    return await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: "agent:main:default",
        knownAgentIds: new Set(["default"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );
  }

  test("lists each contract item in the producer's message", async () => {
    const { runtime, seen } = captureAll();
    await run(runtime, [
      subWithContract(0, "gather", ["每段公里数", "门票价格", "来源 URL"]),
      sub(1, "write", [0]),
    ]);

    const producer = seen.find((m) => m.includes("gather"))!;
    for (const item of ["每段公里数", "门票价格", "来源 URL"]) {
      expect(producer, item).toContain(item);
    }
    expect(producer).toContain("缺项会导致校验不通过");
  });

  // The half that makes it binding. Guidance in a worker prompt is advisory; a verifier
  // that can fail the subtask is not.
  test("gives the contract to the verifier too", async () => {
    const { runtime, seen } = captureAll();
    await run(runtime, [subWithContract(0, "gather", ["每段公里数"]), sub(1, "write", [0])]);

    const verifierMsg = seen.find((m) => m.includes("下游交接项"))!;
    expect(verifierMsg).toBeDefined();
    expect(verifierMsg).toContain("每段公里数");
    expect(verifierMsg).toContain("缺任意一项即判不通过");
  });

  /**
   * Verification used to be gated on acceptanceCriteria alone. A subtask declaring a
   * contract but no criteria would then have had an unenforced contract — precisely the
   * case where a worker is most free to drop items.
   */
  test("a contract alone triggers verification, with no acceptance criteria", async () => {
    const { runtime, seen } = captureAll();
    await run(runtime, [subWithContract(0, "gather", ["每段公里数"]), sub(1, "write", [0])]);

    expect(seen.some((m) => m.includes("下游交接项"))).toBe(true);
  });

  test("no contract means no contract block in either prompt", async () => {
    const { runtime, seen } = captureAll();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    expect(seen.some((m) => m.includes("下游交接项"))).toBe(false);
    expect(seen.some((m) => m.includes("缺项会导致校验不通过"))).toBe(false);
  });

  /**
   * A leaf's contract is meaningless — it has no consumer — and it is never shown to the
   * worker. Enforcing it anyway would fail a subtask for omitting items it was never
   * asked for. The decomposer is told not to emit one there, but this must not rely on
   * the model obeying that, so both the notice and the check are gated on the same flag.
   */
  test("a contract on a subtask nothing depends on is neither announced nor enforced", async () => {
    const { runtime, seen } = captureAll();
    await run(runtime, [sub(0, "gather"), subWithContract(1, "write", ["某项"], [0])]);

    expect(seen.some((m) => m.includes("缺项会导致校验不通过"))).toBe(false);
    expect(seen.some((m) => m.includes("下游交接项"))).toBe(false);
  });

  // The gate is "does anything depend on me", not "do I have a contract" — so a producer
  // with a contract is still enforced when it also has criteria.
  test("enforces the contract alongside acceptance criteria", async () => {
    const { runtime, seen } = captureAll();
    await run(runtime, [
      { ...subWithContract(0, "gather", ["每段公里数"]), acceptanceCriteria: "必须列出路线" },
      sub(1, "write", [0]),
    ]);

    const verifierMsg = seen.find((m) => m.includes("下游交接项"))!;
    expect(verifierMsg).toContain("验证点");
    expect(verifierMsg).toContain("每段公里数");
  });
});

/**
 * Transcript hand-off via `sessions_history` (A2A).
 *
 * The full detail of a dependency — its tool results included — lives in its child
 * session, and the host already ships `sessions_history` to read another session. The one
 * thing missing was discovery: child session keys are a SHA-256 of
 * `root:agentId:subtask:N`, so a consumer can never guess one. The orchestrator can derive
 * it, so it passes it along.
 *
 * Whether the read is PERMITTED is a host decision (`tools.sessions.visibility: "all"` plus
 * `tools.agentToAgent.enabled`). These tests only cover that the pointer is correct and
 * offered in the right places — the gate itself belongs to the host.
 */
describe("dependency transcript pointer", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
    agentByDescription.clear();
  });

  function captureMessages() {
    const seen: Array<{ sessionKey: string; message: string }> = [];
    const { runtime } = makeTrackedSubagent(
      (sessionKey, message) => {
        seen.push({ sessionKey, message });
        return "ok";
      },
      () => "OPAQUE_RESULT",
    );
    return { runtime, seen };
  }

  const ROOT = "agent:main:default";

  async function run(runtime: SubagentRuntime, subtasks: SubtaskPlan[]) {
    return await runPipelineWithRouting(
      {
        subagent: runtime,
        cfg: testConfig(),
        rootSessionKey: ROOT,
        knownAgentIds: new Set(["default"]),
        agentDescriptions: new Map(),
        orchestratorAgentId: "main",
      },
      subtasks,
    );
  }

  test("gives the consumer its dependency's real session key", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const consumer = seen.find((c) => c.message.includes("write"))!;
    // The exact key the dependency actually ran on — derived, not invented.
    expect(consumer.message).toContain(childSessionKeyFor(ROOT, "default", 0));
    expect(consumer.message).toContain("sessions_history");
  });

  test("names one key per dependency", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "a"), sub(1, "b"), sub(2, "final", [0, 1])]);

    const consumer = seen.find((c) => c.message.includes("final"))!;
    expect(consumer.message).toContain(childSessionKeyFor(ROOT, "default", 0));
    expect(consumer.message).toContain(childSessionKeyFor(ROOT, "default", 1));
  });

  // A subtask with no dependencies has no transcript to read and no prior-context block at
  // all, so the pointer must not appear.
  test("says nothing to a subtask with no dependencies", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const producer = seen.find((c) => c.message.includes("gather"))!;
    expect(producer.message).not.toContain("sessions_history");
  });

  /**
   * A failed dependency's transcript holds the failure, not content worth fetching.
   * Pointing at it would invite a read that costs a tool round-trip and returns nothing
   * useful — and the failure is already stated in the prior-context block.
   */
  test("does not point at a failed dependency's transcript", async () => {
    const seen: string[] = [];
    const { runtime } = makeTrackedSubagent(
      (_sessionKey, message) => {
        seen.push(message);
        return message.includes("will fail") ? "timeout" : "ok";
      },
      () => "OPAQUE_RESULT",
    );
    await run(runtime, [sub(0, "will fail"), sub(1, "consumer", [0])]);

    const consumer = seen.find((m) => m.includes("consumer"))!;
    expect(consumer).toContain("未完成"); // the failure IS reported
    expect(consumer).not.toContain("sessions_history");
  });

  // The pointer is advertised unconditionally, so it must tell the worker what to do when
  // the host refuses — otherwise a denied tool call looks like a dead end.
  test("tells the worker what to do if the tool is refused", async () => {
    const { runtime, seen } = captureMessages();
    await run(runtime, [sub(0, "gather"), sub(1, "write", [0])]);

    const consumer = seen.find((c) => c.message.includes("write"))!;
    expect(consumer.message).toContain("以上面的正文为准");
  });
});
