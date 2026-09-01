/**
 * Tests for summarization and notice visibility (tasks 6.8/6.9/6.10).
 */

import { describe, expect, test, vi } from "vitest";
import { handleDecomposedRequest } from "../src/orchestrator.js";
import { buildMandatoryNotices, summarize } from "../src/summarize.js";
import type { SubagentRuntime } from "../src/runtime-contract.js";
import type { SubtaskPlan, SubtaskResult } from "../src/types.js";
import { testConfig } from "./test-helpers.js";

vi.mock("../src/delegate.js", async () => {
  const actual = await vi.importActual<typeof import("../src/delegate.js")>("../src/delegate.js");
  return {
    ...actual,
    runOneShotModelCall: vi.fn(async (params: { message: string }) => {
      if (params.message.includes("__FAIL_SUMMARY__")) throw new Error("summary model down");
      return { text: "整合后的正文" };
    }),
  };
});

function sub(id: number, description: string): SubtaskPlan {
  return { id, title: description, description };
}
const ok = (id: number, text: string): SubtaskResult => ({
  id,
  agentId: "coding",
  text,
  status: "ok",
  processingNotices: [],
});
const failed = (id: number, error: string): SubtaskResult => ({
  id,
  agentId: "coding",
  text: "",
  status: "error",
  error,
});

const emptyNotices = {
  droppedSubtasks: [],
  truncatedDescriptions: [],
  droppedEmptyDescriptions: [],
  truncatedDeps: [],
  promptTruncated: false,
};

describe("buildMandatoryNotices / summarize length guarantees (task 6.8)", () => {
  test("mandatory notices survive even when the model body is extremely long", async () => {
    vi.mocked((await import("../src/delegate.js")).runOneShotModelCall).mockResolvedValueOnce({
      text: "x".repeat(50000),
    });
    const cfg = testConfig({ maxFinalReplyChars: 500 });
    const dropped = [sub(9, "an idea that got dropped")];
    const result = await summarize(
      cfg,
      {
        ...emptyNotices,
        droppedSubtasks: dropped,
        originalPrompt: "do many things",
        results: [ok(0, "fine")],
        allSubtasks: [sub(0, "fine")],
      },
      undefined,
      "agent:main:default",
    );
    expect(result.length).toBeLessThanOrEqual(cfg.maxFinalReplyChars);
    expect(result).toContain("处理说明");
    expect(result).toContain("未处理");
  });

  test("when notices themselves exceed the cap, the failed section is kept first", () => {
    const cfg = testConfig({ maxFinalReplyChars: 60, maxNoticeItems: 50 });
    const manyDropped = Array.from({ length: 30 }, (_, i) => sub(i, `dropped subtask number ${i}`));
    const notices = buildMandatoryNotices(
      { ...emptyNotices, droppedSubtasks: manyDropped, extraSections: ["FAILED SECTION FIRST"] },
      cfg,
    );
    // Sections are joined with failed-derived extraSections first, so a hard
    // truncation of the whole notices block keeps the front (failures) intact.
    expect(notices.indexOf("FAILED SECTION FIRST")).toBeLessThan(
      notices.indexOf("未处理") === -1 ? Infinity : notices.indexOf("未处理"),
    );
  });

  test("every notice class appears when all trigger at once", () => {
    const cfg = testConfig();
    const notices = buildMandatoryNotices(
      {
        droppedSubtasks: [sub(5, "dropped")],
        truncatedDescriptions: [sub(1, "trunc desc")],
        droppedEmptyDescriptions: [sub(2, "")],
        truncatedDeps: [sub(3, "trunc deps")],
        promptTruncated: true,
      },
      cfg,
    );
    expect(notices).toContain("未处理");
    expect(notices).toContain("截短");
    expect(notices).toContain("空描述");
    expect(notices).toContain("依赖");
    expect(notices).toContain("原始请求过长");
  });

  test("no notices produces an empty string", () => {
    expect(buildMandatoryNotices(emptyNotices, testConfig())).toBe("");
  });
});

describe("summarize (task 6.10)", () => {
  test("falls back to concatenation with a failure banner when the model call fails", async () => {
    const cfg = testConfig();
    const result = await summarize(
      cfg,
      {
        ...emptyNotices,
        originalPrompt: "__FAIL_SUMMARY__ trigger",
        results: [ok(0, "result text")],
        allSubtasks: [sub(0, "task")],
      },
      undefined,
      "agent:main:default",
    );
    expect(result).toContain("整合失败");
    expect(result).toContain("result text");
  });

  test("all subtasks failing still returns a coherent reply, not a crash", async () => {
    const cfg = testConfig();
    const result = await summarize(
      cfg,
      {
        ...emptyNotices,
        originalPrompt: "everything failed",
        results: [failed(0, "boom"), failed(1, "also boom")],
        allSubtasks: [sub(0, "a"), sub(1, "b")],
      },
      undefined,
      "agent:main:default",
    );
    expect(result).toContain("未完成");
    expect(result.length).toBeGreaterThan(0);
  });

  test("failed subtasks are listed with their original description", async () => {
    const cfg = testConfig();
    const result = await summarize(
      cfg,
      {
        ...emptyNotices,
        originalPrompt: "x",
        results: [failed(3, "network error")],
        allSubtasks: [sub(3, "fetch the weather report")],
      },
      undefined,
      "agent:main:default",
    );
    expect(result).toContain("fetch the weather report");
    expect(result).toContain("network error");
  });
});

describe("handleDecomposedRequest pass-through for fewer than 2 survivors", () => {
  function makeSubagent(text: string): SubagentRuntime {
    let counter = 0;
    return {
      run: vi.fn(async () => ({ runId: `run-${counter++}` })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: text }],
      })),
    };
  }

  function deps(cfg: ReturnType<typeof testConfig>, subagent: SubagentRuntime) {
    return {
      subagent,
      cfg,
      rootSessionKey: "agent:main:default",
      knownAgentIds: new Set(["coding"]),
      agentDescriptions: new Map<string, string>(),
      orchestratorAgentId: "main",
    };
  }

  test("a 1-subtask plan passes through instead of being orchestrated", async () => {
    const subagent = makeSubagent("unused");
    const rawPlan = { subtasks: [{ id: 0, description: "just one concern" }] };
    const result = await handleDecomposedRequest(deps(testConfig(), subagent), {
      originalPrompt: "do one thing",
      rawPlan,
      promptTruncated: false,
    });
    expect(result).toBeNull();
    // Nothing was delegated: the ordinary reply path handles it.
    expect(subagent.run).not.toHaveBeenCalled();
  });

  test("a 0-survivor plan passes through", async () => {
    const subagent = makeSubagent("unused");
    // The single subtask is dropped as empty, leaving 0 survivors.
    const rawPlan = { subtasks: [{ id: 0, description: "" }] };
    const result = await handleDecomposedRequest(deps(testConfig(), subagent), {
      originalPrompt: "do something",
      rawPlan,
      promptTruncated: false,
    });
    expect(result).toBeNull();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  test("an unparseable plan passes through", async () => {
    const subagent = makeSubagent("unused");
    const result = await handleDecomposedRequest(deps(testConfig(), subagent), {
      originalPrompt: "x",
      rawPlan: null,
      promptTruncated: true,
    });
    expect(result).toBeNull();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  test("2 survivors still orchestrate rather than passing through", async () => {
    const subagent = makeSubagent("subtask answer");
    const rawPlan = {
      subtasks: [
        { id: 0, description: "first concern" },
        { id: 1, description: "second concern" },
      ],
    };
    const result = await handleDecomposedRequest(deps(testConfig(), subagent), {
      originalPrompt: "do two things",
      rawPlan,
      promptTruncated: false,
    });
    expect(typeof result).toBe("string");
  });
});
