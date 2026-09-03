// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Delegation adapter — see design.md D2.
 *
 * The planning docs assume a host function `runDelegatedTask(...) -> Promise<string>`.
 * No such function exists. `subagent.run` returns only `{ runId }`; getting the
 * text back requires run -> waitForRun -> getSessionMessages -> extract, the
 * same shape memory-core's dreaming-narrative already uses.
 *
 * One useful consequence: `waitForRun` takes `timeoutMs` natively, so the timeout
 * is enforced by the host's run lifecycle instead of a `Promise.race` that only
 * abandons the wait. That closes the docs' open question about whether the
 * timeout truly aborts the underlying call — though see design.md R1 for the
 * residual risk, which is why callers skip the rest of a group after a timeout.
 */

import type { DelegationOutcome, SubagentRuntime } from "./runtime-contract.js";

/** Thrown when the subagent runtime is unavailable (not in a gateway request scope). */
export class SubagentRuntimeUnavailableError extends Error {
  constructor() {
    super("subagent runtime is unavailable (requires a gateway request scope)");
    this.name = "SubagentRuntimeUnavailableError";
  }
}

/** Thrown when the delegated run did not finish successfully. */
export class DelegationFailedError extends Error {
  readonly status: "error" | "timeout";
  constructor(status: "error" | "timeout", detail?: string) {
    super(detail ? `delegated run ${status}: ${detail}` : `delegated run ${status}`);
    this.name = "DelegationFailedError";
    this.status = status;
  }
}

/** Thrown when the run succeeded but produced no readable assistant text. */
export class DelegationEmptyResultError extends Error {
  constructor() {
    super("delegated run produced no assistant text");
    this.name = "DelegationEmptyResultError";
  }
}

/**
 * How many trailing session messages to scan for the assistant reply. The run we
 * just awaited is the most recent activity on this session, so a small window is
 * enough; scanning the whole history would grow with the reused child session.
 */
const SESSION_MESSAGE_SCAN_LIMIT = 5;

/**
 * Extract the newest non-empty assistant text from session messages.
 * Handles both plain-string content and structured text parts.
 */
export function extractAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") continue;

    const content = record.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part: unknown) =>
            part &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            (part as Record<string, unknown>).type === "text" &&
            typeof (part as Record<string, unknown>).text === "string",
        )
        .map((part) => (part as { text: string }).text)
        .join("\n")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return null;
}

/**
 * Run one stateless model call (classify/decompose/summarize) through the
 * subagent runtime, with an optional provider/model override.
 *
 * Distinct from runDelegatedTask: this is the orchestrator's own internal
 * judgment call, not a hand-off to another agent, so it always runs on the
 * classifier's own session (see session-key.ts classifierSessionKeyFor) and
 * never carries delegation metadata. `deliver: false` for the same reason as
 * runDelegatedTask — the classifier session must never message the user
 * directly.
 */
export async function runOneShotModelCall(params: {
  subagent: SubagentRuntime | undefined;
  sessionKey: string;
  /**
   * Omit when the target agentId carries its own `systemPromptOverride` in the
   * host's `agents.list` (see session-key.ts `decomposerSessionKeyFor`) —
   * `extraSystemPrompt` is appended to the default prompt and would be inert
   * noise once an override already replaces it wholesale.
   */
  systemPrompt?: string;
  message: string;
  provider?: string;
  model?: string;
  timeoutMs: number;
}): Promise<DelegationOutcome> {
  const { subagent, sessionKey, systemPrompt, message, provider, model, timeoutMs } = params;
  if (!subagent) {
    throw new SubagentRuntimeUnavailableError();
  }

  const { runId } = await subagent.run({
    sessionKey,
    message,
    deliver: false,
    ...(systemPrompt && { extraSystemPrompt: systemPrompt }),
    ...(provider && { provider }),
    ...(model && { model }),
  });

  const waited = await subagent.waitForRun({ runId, timeoutMs });
  if (waited.status !== "ok") {
    throw new DelegationFailedError(waited.status, waited.error);
  }

  const { messages } = await subagent.getSessionMessages({
    sessionKey,
    limit: SESSION_MESSAGE_SCAN_LIMIT,
  });

  const text = extractAssistantText(messages);
  if (text === null) {
    throw new DelegationEmptyResultError();
  }
  return { text };
}

/**
 * Delegate one message to `targetAgentId` on `childSessionKey` and return its text.
 *
 * `deliver: false` because subtask results are summarized by this plugin into a
 * single reply — individual subagents must not message the user directly.
 *
 * Throws (never returns empty) so callers can apply the failure path uniformly:
 * - SubagentRuntimeUnavailableError — runtime missing
 * - DelegationFailedError — run ended error/timeout
 * - DelegationEmptyResultError — ok but no text
 */
export async function runDelegatedTask(params: {
  subagent: SubagentRuntime | undefined;
  childSessionKey: string;
  message: string;
  timeoutMs: number;
}): Promise<DelegationOutcome> {
  const { subagent, childSessionKey, message, timeoutMs } = params;
  if (!subagent) {
    throw new SubagentRuntimeUnavailableError();
  }

  const { runId } = await subagent.run({
    sessionKey: childSessionKey,
    message,
    deliver: false,
  });

  const waited = await subagent.waitForRun({ runId, timeoutMs });
  if (waited.status !== "ok") {
    throw new DelegationFailedError(waited.status, waited.error);
  }

  const { messages } = await subagent.getSessionMessages({
    sessionKey: childSessionKey,
    limit: SESSION_MESSAGE_SCAN_LIMIT,
  });

  const text = extractAssistantText(messages);
  if (text === null) {
    throw new DelegationEmptyResultError();
  }
  return { text };
}
