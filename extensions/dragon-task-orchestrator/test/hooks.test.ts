// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for hook wiring order and delegation handling (tasks 7.8/7.9),
 * plus end-to-end pipeline scenarios (7.10/7.11) and the disabled-plugin
 * regression (7.12).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { resetDelegationMetaStore, setDelegationMeta } from "../src/delegation-meta.js";
import { runBeforeAgentReply } from "../src/hooks.js";
import { resetMissionModeStore, setSessionMode } from "../src/mission-mode.js";
import { childSessionKeyFor } from "../src/session-key.js";
import type { SubagentRuntime } from "../src/runtime-contract.js";
import { testConfig } from "./test-helpers.js";

const classifyDomainOnly = vi.fn();
const decomposeTask = vi.fn();
// vi.mock replaces the WHOLE module, so resolveAgentForSubtask (used directly by
// pipeline.ts) must be reimplemented here too — otherwise it becomes undefined.
// It delegates to the classifyDomainOnly mock so tests can still control routing.
vi.mock("../src/resolve-agent.js", () => ({
  classifyDomainOnly: (...args: unknown[]) => classifyDomainOnly(...args),
  decomposeTask: (...args: unknown[]) => decomposeTask(...args),
  resolveAgentForSubtask: async (
    cfg: { defaultAgentId: string },
    subtask: { description: string },
    knownAgentIds: Set<string>,
    orchestratorAgentId: string,
    agentDescriptions: Map<string, string>,
  ) => {
    let domain: string;
    try {
      domain = await classifyDomainOnly(cfg, subtask.description, [...knownAgentIds], agentDescriptions);
    } catch {
      return cfg.defaultAgentId;
    }
    if (!knownAgentIds.has(domain) || domain === orchestratorAgentId) return cfg.defaultAgentId;
    return domain;
  },
}));

/**
 * Mission mode defaults OFF, so every test that expects the plugin to engage on a
 * root session has to opt that session in first — that opt-in IS the precondition
 * those tests assume. Delegation-marked sessions are unaffected: the mission gate
 * sits after the delegation branch on purpose, so in-flight subtask hops keep
 * working regardless of the switch (asserted separately below).
 */
beforeEach(() => {
  resetMissionModeStore();
  setSessionMode("agent:main:default", { kind: "dynamic" });
});

describe("delegation-marker precedence (task 7.8)", () => {
  const ROOT = "agent:main:default";

  beforeEach(() => {
    resetDelegationMetaStore();
    classifyDomainOnly.mockReset();
    decomposeTask.mockReset();
  });

  test("a request on a delegation-marked session never calls decomposeTask", async () => {
    const childKey = childSessionKeyFor(ROOT, "coding");
    setDelegationMeta(childKey, { hopCount: 0, rootSessionKey: ROOT, hintedAgentId: "coding" });
    const runLocally = vi.fn(async () => "answer");

    await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => undefined,
        getPipeline: () => undefined,
        runLocally,
      },
      { cleanedBody: "do the delegated thing" },
      { sessionKey: childKey, agentId: "coding" },
    );

    expect(decomposeTask).not.toHaveBeenCalled();
  });

  test("an ordinary (non-delegated) session goes straight to decomposition", async () => {
    // A single-subtask plan is the "did not need splitting" answer.
    decomposeTask.mockResolvedValue({ subtasks: [{ id: 0, description: "just one concern" }] });
    const result = await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => undefined,
        getPipeline: () => undefined,
        runLocally: vi.fn(),
      },
      { cleanedBody: "hello" },
      { sessionKey: "agent:main:default", agentId: "main" },
    );
    expect(decomposeTask).toHaveBeenCalled();
    expect(result).toBeNull(); // < 2 subtasks -> pass through
  });

  test("internal temp: sessions are skipped entirely", async () => {
    const result = await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => undefined,
        getPipeline: () => undefined,
        runLocally: vi.fn(),
      },
      { cleanedBody: "slug generation prompt" },
      { sessionKey: "temp:slug-generator", agentId: "main" },
    );
    expect(result).toBeNull();
    expect(decomposeTask).not.toHaveBeenCalled();
  });
});

describe("delegation branch behavior (task 7.9)", () => {
  const ROOT = "agent:main:default";

  beforeEach(() => {
    resetDelegationMetaStore();
    classifyDomainOnly.mockReset();
  });

  test("hintedAgentId match skips reclassification entirely", async () => {
    const childKey = childSessionKeyFor(ROOT, "coding");
    setDelegationMeta(childKey, { hopCount: 0, rootSessionKey: ROOT, hintedAgentId: "coding" });
    const runLocally = vi.fn(async () => "handled locally");

    const result = await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding", "research"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => undefined,
        getPipeline: () => undefined,
        runLocally,
      },
      { cleanedBody: "instruction text" },
      { sessionKey: childKey, agentId: "coding" },
    );

    expect(classifyDomainOnly).not.toHaveBeenCalled();
    expect(runLocally).toHaveBeenCalled();
    expect(result?.text).toContain("handled locally");
  });

  test("hop limit reached stops forwarding and answers in place with a notice", async () => {
    const childKey = childSessionKeyFor(ROOT, "research");
    const cfg = testConfig({ maxDelegationHops: 3 });
    setDelegationMeta(childKey, {
      hopCount: 3,
      rootSessionKey: ROOT,
      hintedAgentId: "coding", // mismatched on purpose so the hop-limit path is what stops it
    });
    const runLocally = vi.fn(async () => "final answer");

    const result = await runBeforeAgentReply(
      {
        cfg,
        getKnownAgentIds: () => new Set(["coding", "research"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => undefined,
        getPipeline: () => undefined,
        runLocally,
      },
      { cleanedBody: "x" },
      { sessionKey: childKey, agentId: "research" },
    );

    expect(classifyDomainOnly).not.toHaveBeenCalled();
    expect(result?.text).toContain("final answer");
    expect(result?.text).toContain("多次转交");
  });

  test("forwarding derives the next session from the chain root, not the current hop", async () => {
    classifyDomainOnly.mockResolvedValue("writing");
    const childKey = childSessionKeyFor(ROOT, "research"); // current hop's key
    setDelegationMeta(childKey, { hopCount: 0, rootSessionKey: ROOT, hintedAgentId: "coding" });

    let capturedSessionKey = "";
    const subagent: SubagentRuntime = {
      run: vi.fn(async ({ sessionKey }) => {
        capturedSessionKey = sessionKey;
        return { runId: "run-1" };
      }),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "forwarded answer" }],
      })),
    };

    await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding", "research", "writing"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => subagent,
        getPipeline: () => undefined,
        runLocally: vi.fn(),
      },
      { cleanedBody: "x" },
      { sessionKey: childKey, agentId: "research" },
    );

    // Must equal childSessionKeyFor(ROOT, "writing"), NOT derived from childKey.
    expect(capturedSessionKey).toBe(childSessionKeyFor(ROOT, "writing"));
  });
});

describe("marker-only fail-safe degradation (task 2.5)", () => {
  test("recognizing the marker with no metadata executes in place without forwarding", async () => {
    resetDelegationMetaStore();
    const orphanKey = childSessionKeyFor("agent:main:default", "coding"); // never registered
    const runLocally = vi.fn(async () => "in-place answer");
    let forwardAttempted = false;
    const subagent: SubagentRuntime = {
      run: vi.fn(async () => {
        forwardAttempted = true;
        return { runId: "run-1" };
      }),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
    };

    const result = await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => subagent,
        getPipeline: () => undefined,
        runLocally,
      },
      { cleanedBody: "orphaned delegation" },
      { sessionKey: orphanKey, agentId: "coding" },
    );

    expect(runLocally).toHaveBeenCalled();
    expect(forwardAttempted).toBe(false);
    expect(result?.text).toContain("in-place answer");
  });
});

describe("end-to-end: full decomposition pipeline (task 7.10)", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
    classifyDomainOnly.mockReset();
    decomposeTask.mockReset();
  });

  test("2 independent + 1 dependent subtask: layering, prior-context, and summary all work", async () => {
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, description: "research the topic" },
        { id: 1, description: "draft an outline" },
        { id: 2, description: "write the final summary", needsPriorResults: [0, 1] },
      ],
    });
    // Every subtask routes to "coding" via the default-agent fallback in
    // resolveAgentForSubtask's mock below.
    classifyDomainOnly.mockResolvedValue("coding");

    const executionOrder: string[] = [];
    let capturedFinalMessage = "";
    const subagent: SubagentRuntime = {
      run: vi.fn(async ({ message }) => {
        if (message.includes("research the topic")) executionOrder.push("research");
        else if (message.includes("draft an outline")) executionOrder.push("outline");
        else if (message.includes("write the final summary")) {
          executionOrder.push("final");
          capturedFinalMessage = message;
        }
        return { runId: `run-${executionOrder.length}` };
      }),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "subtask output text" }],
      })),
    };

    const result = await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => subagent,
        getPipeline: () => undefined,
        runLocally: vi.fn(),
      },
      { cleanedBody: "research X, outline it, then write a final summary" },
      { sessionKey: "agent:main:default", agentId: "main" },
    );

    // The dependent subtask must run after both of its dependencies.
    expect(executionOrder.indexOf("final")).toBeGreaterThan(executionOrder.indexOf("research"));
    expect(executionOrder.indexOf("final")).toBeGreaterThan(executionOrder.indexOf("outline"));
    // Prior context from both dependencies must reach the dependent subtask.
    expect(capturedFinalMessage).toContain("subtask output text");
    expect(capturedFinalMessage).toContain("write the final summary");
    expect(typeof result?.text).toBe("string");
  });
});

describe("end-to-end: partial failure does not abort the whole request (task 7.11)", () => {
  beforeEach(() => {
    resetDelegationMetaStore();
    classifyDomainOnly.mockReset();
    decomposeTask.mockReset();
  });

  test("one failing subtask still lets independent and dependent subtasks complete, and is reported", async () => {
    decomposeTask.mockResolvedValue({
      subtasks: [
        { id: 0, description: "will fail" },
        { id: 1, description: "independent success" },
        { id: 2, description: "depends on the failure", needsPriorResults: [0] },
      ],
    });
    classifyDomainOnly.mockResolvedValue("coding");

    const subagent: SubagentRuntime = {
      run: vi.fn(async ({ message }) => ({ runId: message })),
      // Substring, not equality: a subtask with dependents also receives the hand-off
      // notice appended to its description (see pipeline.ts `buildHandoffNotice`), and
      // subtask 0 has one. Matching the whole message exactly made this fixture depend on
      // the prompt's precise wording, so the failing subtask silently started succeeding.
      waitForRun: vi.fn(async ({ runId }) =>
        runId.includes("will fail")
          ? { status: "error" as const, error: "boom" }
          : { status: "ok" as const },
      ),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "ok output" }],
      })),
    };

    const result = await runBeforeAgentReply(
      {
        cfg: testConfig(),
        getKnownAgentIds: () => new Set(["coding"]),
        getAgentDescriptions: () => new Map(),
        getSubagent: () => subagent,
        getPipeline: () => undefined,
        runLocally: vi.fn(),
      },
      { cleanedBody: "do three things, one of which fails" },
      { sessionKey: "agent:main:default", agentId: "main" },
    );

    expect(result?.text).toContain("未完成");
    expect(result?.text).toContain("will fail");
  });
});

describe("enabled:false regression (task 7.12)", () => {
  test("runBeforeAgentReply is simply not wired when the plugin config is disabled", async () => {
    // registerHooks is only ever called by index.ts when cfg.enabled is true;
    // this asserts the config default itself is false so an unconfigured
    // installation registers nothing.
    const { DEFAULTS } = await import("../src/config-schema.js");
    expect(DEFAULTS.enabled).toBe(false);
  });
});

describe("mode dispatch", () => {
  const ROOT = "agent:main:default";
  const PIPELINE = {
    id: "pl_x",
    name: "文档生成",
    steps: [{ agentId: "coding", instruction: "做事" }],
    createdAt: 1,
    updatedAt: 1,
  };

  function subagentReplying(text: string): SubagentRuntime {
    return {
      run: vi.fn(async () => ({ runId: "run-1" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: text }],
      })),
    };
  }

  function depsFor(overrides: Record<string, unknown> = {}) {
    return {
      cfg: testConfig(),
      getKnownAgentIds: () => new Set(["coding"]),
      getAgentDescriptions: () => new Map<string, string>(),
      getSubagent: () => undefined,
      getPipeline: () => undefined,
      runLocally: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    resetDelegationMetaStore();
    resetMissionModeStore();
    decomposeTask.mockReset();
    classifyDomainOnly.mockReset();
  });

  test("off passes the turn through and calls nothing", async () => {
    const result = await runBeforeAgentReply(
      depsFor(),
      { cleanedBody: "做两件事" },
      { sessionKey: ROOT, agentId: "main" },
    );
    expect(result).toBeNull();
    expect(decomposeTask).not.toHaveBeenCalled();
  });

  test("dynamic reaches the decomposer", async () => {
    decomposeTask.mockResolvedValue({ subtasks: [{ id: 0, description: "one" }] });
    setSessionMode(ROOT, { kind: "dynamic" });
    await runBeforeAgentReply(
      depsFor(),
      { cleanedBody: "做两件事" },
      { sessionKey: ROOT, agentId: "main" },
    );
    expect(decomposeTask).toHaveBeenCalled();
  });

  // The whole point of a fixed pipeline: no decomposer, no classifier, just the
  // operator's declared sequence.
  test("pipeline runs the steps and never calls the decomposer or classifier", async () => {
    setSessionMode(ROOT, { kind: "pipeline", pipelineId: "pl_x" });
    const subagent = subagentReplying("步骤产出");
    const result = await runBeforeAgentReply(
      depsFor({ getPipeline: () => PIPELINE, getSubagent: () => subagent }),
      { cleanedBody: "做一件事" },
      { sessionKey: ROOT, agentId: "main" },
    );
    expect(result?.text).toBe("步骤产出");
    expect(decomposeTask).not.toHaveBeenCalled();
    expect(classifyDomainOnly).not.toHaveBeenCalled();
  });

  test("pipeline mode surfaces the last step's images as mediaUrls", async () => {
    setSessionMode(ROOT, { kind: "pipeline", pipelineId: "pl_x" });
    const subagent: SubagentRuntime = {
      run: vi.fn(async () => ({ runId: "run-1" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [
          {
            role: "toolResult",
            content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" }],
          },
          { role: "assistant", content: "步骤产出" },
        ],
      })),
    };
    const result = await runBeforeAgentReply(
      depsFor({ getPipeline: () => PIPELINE, getSubagent: () => subagent }),
      { cleanedBody: "做一件事" },
      { sessionKey: ROOT, agentId: "main" },
    );
    expect(result?.mediaUrls).toHaveLength(1);
  });

  // Substituting a different orchestration strategy is not something the operator
  // agreed to, so a missing pipeline passes through instead.
  test("a deleted pipeline passes through rather than falling back to dynamic", async () => {
    setSessionMode(ROOT, { kind: "pipeline", pipelineId: "pl_gone" });
    const result = await runBeforeAgentReply(
      depsFor({ getPipeline: () => undefined }),
      { cleanedBody: "做一件事" },
      { sessionKey: ROOT, agentId: "main" },
    );
    expect(result).toBeNull();
    expect(decomposeTask).not.toHaveBeenCalled();
  });

  test("the mode is per session, not global", async () => {
    decomposeTask.mockResolvedValue({ subtasks: [{ id: 0, description: "one" }] });
    setSessionMode("agent:main:other", { kind: "dynamic" });
    await runBeforeAgentReply(
      depsFor(),
      { cleanedBody: "做两件事" },
      { sessionKey: ROOT, agentId: "main" },
    );
    expect(decomposeTask).not.toHaveBeenCalled();
  });

  // ORDERING: the gate sits AFTER the delegation branch, so switching mode mid-run
  // cannot strand hops already in flight. This is also what lets fixed-pipeline steps
  // keep working — see the host-behaviour note in fixed-pipeline.ts.
  test("a delegated subtask still runs when the mode is off", async () => {
    const childKey = childSessionKeyFor(ROOT, "coding");
    setDelegationMeta(childKey, { hopCount: 0, rootSessionKey: ROOT, hintedAgentId: "coding" });
    const runLocally = vi.fn(async () => "delegated answer");
    const result = await runBeforeAgentReply(
      depsFor({ runLocally }),
      { cleanedBody: "子任务" },
      { sessionKey: childKey, agentId: "coding" },
    );
    expect(result?.text).toBe("delegated answer");
    expect(runLocally).toHaveBeenCalled();
  });

  test("background triggers are skipped in pipeline mode too", async () => {
    setSessionMode(ROOT, { kind: "pipeline", pipelineId: "pl_x" });
    const subagent = subagentReplying("不该被调用");
    const result = await runBeforeAgentReply(
      depsFor({ getPipeline: () => PIPELINE, getSubagent: () => subagent }),
      { cleanedBody: "Read HEARTBEAT.md" },
      { sessionKey: ROOT, agentId: "main", trigger: "heartbeat" },
    );
    expect(result).toBeNull();
    expect(subagent.run).not.toHaveBeenCalled();
  });
});

describe("background runs are not decomposed", () => {
  // Regression: a heartbeat poll reached the decomposer, which rewrote a prompt that
  // demands an exact HEARTBEAT_OK reply. With the confirmation gate on, a
  // multi-subtask split would also have blocked an unattended run until timeout.
  const HEARTBEAT_PROMPT =
    "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. " +
    "If nothing needs attention, reply HEARTBEAT_OK.";

  beforeEach(() => {
    resetDelegationMetaStore();
    decomposeTask.mockReset();
  });

  function deps() {
    return {
      cfg: testConfig(),
      getKnownAgentIds: () => new Set(["coding"]),
      getAgentDescriptions: () => new Map<string, string>(),
      getSubagent: () => undefined,
      getPipeline: () => undefined,
      runLocally: vi.fn(),
    };
  }

  for (const trigger of ["heartbeat", "cron", "memory", "overflow"]) {
    test(`trigger=${trigger} passes through without decomposing`, async () => {
      const result = await runBeforeAgentReply(
        deps(),
        { cleanedBody: HEARTBEAT_PROMPT },
        { sessionKey: "agent:main:default", agentId: "main", trigger },
      );
      expect(result).toBeNull();
      expect(decomposeTask).not.toHaveBeenCalled();
    });
  }

  for (const trigger of ["user", "manual", undefined]) {
    test(`trigger=${String(trigger)} is still decomposed`, async () => {
      decomposeTask.mockResolvedValue({ subtasks: [{ id: 0, description: "one" }] });
      await runBeforeAgentReply(
        deps(),
        { cleanedBody: "do two unrelated things" },
        { sessionKey: "agent:main:default", agentId: "main", ...(trigger && { trigger }) },
      );
      expect(decomposeTask).toHaveBeenCalled();
    });
  }

  test("an unrecognized trigger is treated as a request rather than silently skipped", async () => {
    decomposeTask.mockResolvedValue({ subtasks: [{ id: 0, description: "one" }] });
    await runBeforeAgentReply(
      deps(),
      { cleanedBody: "do things" },
      { sessionKey: "agent:main:default", agentId: "main", trigger: "some-future-trigger" },
    );
    expect(decomposeTask).toHaveBeenCalled();
  });
});
