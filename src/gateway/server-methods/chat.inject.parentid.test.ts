// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import { createTranscriptFixtureSync } from "./chat.test-helpers.js";

// Guardrail: Ensure gateway "injected" assistant transcript messages are appended via SessionManager,
// so they are attached to the current leaf with a `parentId` and do not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a Pi session entry that includes parentId", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-",
      sessionId: "sess-1",
    });

    try {
      const appended = appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "hello",
      });
      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTruthy();

      const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
      expect(last.type).toBe("message");

      // The regression we saw: raw jsonl appends omitted this field entirely.
      expect(Object.prototype.hasOwnProperty.call(last, "parentId")).toBe(true);
      expect(last).toHaveProperty("id");
      expect(last).toHaveProperty("message");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the paired user turn with a parentId, on a session that starts empty", () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-user-",
      sessionId: "sess-user-1",
    });

    try {
      const appended = appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "here it is",
        userMessage: "find the dunk",
      });
      expect(appended.ok).toBe(true);

      const entries = fs
        .readFileSync(transcriptPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === "message");

      expect(entries).toHaveLength(2);
      const [userEntry, assistantEntry] = entries;
      expect((userEntry.message as Record<string, unknown>).role).toBe("user");
      expect((assistantEntry.message as Record<string, unknown>).role).toBe("assistant");
      // Same guardrail as the assistant case: raw jsonl appends omitted parentId entirely.
      expect(Object.prototype.hasOwnProperty.call(userEntry, "parentId")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(assistantEntry, "parentId")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The fixed-pipeline regression this pairing exists for: only the assistant reply used to be
   * persisted, so a reloaded transcript held consecutive assistant messages with no user turn
   * between them — which the chat UI merges into one group, freezing the group timestamp at the
   * oldest reply and stranding the orchestrator progress card below the response.
   *
   * Turn 1 is the case that regressed when the user message was appended via its own
   * SessionManager: on a still-empty session pi buffers appends until an assistant message
   * flushes them, so the separately-appended user turn was silently dropped.
   */
  it("keeps user/assistant alternation across consecutive hook-handled turns", () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-turn-",
      sessionId: "sess-turn-1",
    });

    try {
      appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "turn 1 reply",
        userMessage: "turn 1 question",
      });
      appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "turn 2 reply",
        userMessage: "turn 2 question",
      });

      const roles = fs
        .readFileSync(transcriptPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === "message")
        .map((entry) => (entry.message as Record<string, unknown>).role);

      expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
