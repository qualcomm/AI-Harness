/**
 * Tests for the delegation adapter (tasks 1.3/1.4/1.6).
 *
 * Covers the five paths a delegated run can take: success, error, timeout,
 * ok-but-no-text, and runtime unavailable. The adapter must always throw rather
 * than silently return empty text, so callers can apply one failure path.
 */

import { describe, expect, test, vi } from "vitest";
import {
  DelegationEmptyResultError,
  DelegationFailedError,
  extractAssistantText,
  runDelegatedTask,
  SubagentRuntimeUnavailableError,
} from "../src/delegate.js";
import type { SubagentRuntime } from "../src/runtime-contract.js";

function makeRuntime(overrides: Partial<SubagentRuntime> = {}): SubagentRuntime {
  return {
    run: vi.fn(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => ({ status: "ok" as const })),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: "delegated answer" }],
    })),
    ...overrides,
  };
}

const baseParams = {
  childSessionKey: "agent:coding:dtsub-abc",
  message: "do the thing",
  timeoutMs: 1000,
};

describe("runDelegatedTask", () => {
  test("returns assistant text on success", async () => {
    const subagent = makeRuntime();
    const result = await runDelegatedTask({ subagent, ...baseParams });
    expect(result.text).toBe("delegated answer");
  });

  test("passes deliver:false so subagents do not message the user directly", async () => {
    const subagent = makeRuntime();
    await runDelegatedTask({ subagent, ...baseParams });
    expect(subagent.run).toHaveBeenCalledWith({
      sessionKey: baseParams.childSessionKey,
      message: baseParams.message,
      deliver: false,
    });
  });

  test("forwards timeoutMs to waitForRun rather than racing a timer", async () => {
    const subagent = makeRuntime();
    await runDelegatedTask({ subagent, ...baseParams });
    expect(subagent.waitForRun).toHaveBeenCalledWith({ runId: "run-1", timeoutMs: 1000 });
  });

  test("throws DelegationFailedError when the run ends in error", async () => {
    const subagent = makeRuntime({
      waitForRun: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
    });
    await expect(runDelegatedTask({ subagent, ...baseParams })).rejects.toBeInstanceOf(
      DelegationFailedError,
    );
  });

  test("throws DelegationFailedError with status timeout when the run times out", async () => {
    const subagent = makeRuntime({
      waitForRun: vi.fn(async () => ({ status: "timeout" as const })),
    });
    await expect(
      runDelegatedTask({ subagent, ...baseParams }),
    ).rejects.toMatchObject({ status: "timeout" });
  });

  test("does not read session messages when the run failed", async () => {
    const subagent = makeRuntime({
      waitForRun: vi.fn(async () => ({ status: "error" as const })),
    });
    await expect(runDelegatedTask({ subagent, ...baseParams })).rejects.toThrow();
    expect(subagent.getSessionMessages).not.toHaveBeenCalled();
  });

  test("throws DelegationEmptyResultError when ok but no assistant text", async () => {
    const subagent = makeRuntime({
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "user", content: "only the prompt" }],
      })),
    });
    await expect(runDelegatedTask({ subagent, ...baseParams })).rejects.toBeInstanceOf(
      DelegationEmptyResultError,
    );
  });

  test("throws SubagentRuntimeUnavailableError when the runtime is missing", async () => {
    await expect(
      runDelegatedTask({ subagent: undefined, ...baseParams }),
    ).rejects.toBeInstanceOf(SubagentRuntimeUnavailableError);
  });
});

describe("extractAssistantText", () => {
  test("reads plain string content", () => {
    expect(extractAssistantText([{ role: "assistant", content: "hello" }])).toBe("hello");
  });

  test("reads structured text parts and joins them", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "line one" },
          { type: "tool_use", id: "t1" },
          { type: "text", text: "line two" },
        ],
      },
    ];
    expect(extractAssistantText(messages)).toBe("line one\nline two");
  });

  test("prefers the newest assistant message", () => {
    const messages = [
      { role: "assistant", content: "older" },
      { role: "user", content: "question" },
      { role: "assistant", content: "newer" },
    ];
    expect(extractAssistantText(messages)).toBe("newer");
  });

  test("skips blank assistant content and keeps looking", () => {
    const messages = [
      { role: "assistant", content: "real answer" },
      { role: "assistant", content: "   " },
    ];
    expect(extractAssistantText(messages)).toBe("real answer");
  });

  test("returns null when nothing usable is present", () => {
    expect(extractAssistantText([])).toBeNull();
    expect(extractAssistantText([null, 42, { role: "user", content: "x" }])).toBeNull();
  });
});
