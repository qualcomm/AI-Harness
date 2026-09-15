/**
 * S3 isolation: run highly-sensitive turns in a dedicated, isolated child
 * session that never touches the cloud, so the raw text can never end up in
 * the main session's transcript (and therefore can never be replayed into a
 * later cloud request from that session).
 *
 * The child session runs under its OWN agentId (`s3-isolated`, declared in
 * openclaw.json's agents.list) rather than reusing the parent's — a distinct
 * agentId gives it its own workspace directory and its own model allowlist, so
 * the parent agent's config never needs to trust the local S3 model directly.
 *
 * NOTE: a distinct agentId alone does NOT stop the parent session's own LLM
 * from reading the child's transcript via the built-in sessions_history /
 * sessions_list tools — those tools grant access on sessionKey ownership
 * (spawnedBy/parentSessionKey) BEFORE checking agentId, under the default
 * `tools.sessions.visibility: "tree"`. Closing that gap requires setting
 * `tools.sessions.visibility: "self"` in openclaw.json (see README).
 *
 * The child session always uses the fixed local S3 model — there is no
 * `/cloud` escape hatch, by design: an isolated session that could still be
 * routed to the cloud would just relocate the historical-pollution problem
 * instead of solving it.
 */

import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildAgentMainSessionKey, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import type { DragonRouterConfig } from "./types.js";

/** Dedicated agentId for isolated S3 runs — must be declared in openclaw.json's agents.list. */
const S3_AGENT_ID = "s3-isolated";

/** Give the local model generous time — it can be slow (see MiniCPM ~68s observed). */
const S3_RUN_TIMEOUT_MS = 180_000;

/**
 * Derive the isolated child's sessionKey from the FULL parent sessionKey (not
 * just its agent-relative "rest" segment) so two different parent agents/
 * sessions can never collide on the same child key, while the same parent
 * session deterministically reuses the same child across turns.
 */
export function childSessionKeyFor(sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
  return buildAgentMainSessionKey({ agentId: S3_AGENT_ID, mainKey: digest });
}

/**
 * True for a dragon-router-spawned S3 child session (runs under the dedicated
 * `s3-isolated` agentId). Recursion guard: the child session's own turn must
 * never be re-classified/re-isolated by this plugin's own hooks, or every S3
 * turn would spawn an unbounded chain of grandchild sessions.
 */
export function isS3ChildSession(sessionKey: string): boolean {
  return resolveAgentIdFromSessionKey(sessionKey) === S3_AGENT_ID;
}

type ContentBlock = { type?: string; text?: string };
type Message = { role?: string; content?: unknown };

/** Join all text blocks of a message's content, whether it's a string or block array. */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

/** Find the most recent assistant message's text in a session's message list. */
function extractLastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m?.role !== "assistant") continue;
    const text = extractMessageText(m.content).trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * Run `prompt` to completion in the isolated S3 child session for `sessionKey`,
 * always via the fixed local S3 model, and return the assistant's reply text.
 * Throws if the run fails, times out, or produces no text — callers must not
 * fall back to routing the prompt through the main session on failure.
 *
 * Requires the OpenClaw host to trust this plugin for subagent model override
 * (`plugins.entries.dragon-router.subagent.allowModelOverride`), since this
 * always passes an explicit provider/model to force the local S3 model. Without
 * that trust grant, every call fails with an authorization error from the
 * gateway `agent` method (surfaced here as a generic run failure).
 */
export async function runIsolatedS3(
  api: OpenClawPluginApi,
  config: DragonRouterConfig,
  sessionKey: string,
  prompt: string,
): Promise<string> {
  const childSessionKey = childSessionKeyFor(sessionKey);
  const { runId } = await api.runtime.subagent.run({
    sessionKey: childSessionKey,
    message: prompt,
    provider: config.s3Model.provider,
    model: config.s3Model.model,
    lightContext: true,
  });

  const wait = await api.runtime.subagent.waitForRun({ runId, timeoutMs: S3_RUN_TIMEOUT_MS });
  if (wait.status !== "ok") {
    throw new Error(`S3 isolated run ${wait.status}${wait.error ? `: ${wait.error}` : ""}`);
  }

  const { messages } = await api.runtime.subagent.getSessionMessages({
    sessionKey: childSessionKey,
    limit: 20,
  });
  const text = extractLastAssistantText(messages);
  if (!text) throw new Error("S3 isolated run produced no assistant text");
  return text;
}
