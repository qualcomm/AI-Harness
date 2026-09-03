// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Gateway event broadcast for PRD / progress, consumed by the Control UI.
 *
 * This is a SECOND, independent delivery path — not a variant of notify.ts.
 * `webchat` is the host's internal message channel and is explicitly excluded
 * from the pluggable chat-channel system, so `api.runtime.channel.outbound`
 * cannot reach the Control UI at all. `api.emitEvent` can: the gateway wraps it
 * as `{event:"plugin_event", payload:{plugin, type, ...payload}}` and broadcasts
 * to every connected WebSocket client, which the UI already listens for.
 *
 * Consequences of that shape, which the payloads below are designed around:
 * - It is an undifferentiated broadcast, so no delivery target has to be
 *   resolved (unlike notify.ts). But every client sees it, so `rootSessionKey`
 *   travels in the payload and the UI filters on it.
 * - `...evt.payload` is spread at the top level next to `plugin`/`type`, so
 *   payload keys must not collide with those two names.
 *
 * Same best-effort rule as notify.ts: emitting is optional decoration on top of
 * the final summarized reply, so every failure here is swallowed.
 */

import { truncate } from "./sanitize.js";
import type { Logger } from "./runtime-contract.js";
import type { SubtaskPlan, SubtaskResult } from "./types.js";

/** Event type broadcast for both kinds of update; `kind` discriminates them. */
export const PROGRESS_EVENT_TYPE = "dragon_task_progress";

/** Per-subtask description budget inside the event payload. */
const EVENT_DESCRIPTION_CHARS = 200;

export type EmitEvent = (eventType: string, payload: Record<string, unknown>) => void;

/**
 * Broadcast the decomposition result and its agent routing.
 *
 * `agentIdOf` is omitted for the first of the two broadcasts a plan gets: routing
 * needs classifier model calls (tens of seconds), while everything else here is
 * already known the moment decomposition returns. Omitting it emits
 * `agentId: null` per subtask, which the card renders as pending, and the second
 * broadcast replaces that state wholesale once routing lands.
 */
export function emitPrdEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    subtasks: SubtaskPlan[];
    /** Omit while routing is still in flight; see the note above. */
    agentIdOf?: Map<number, string>;
    defaultAgentId: string;
    /** Subtask id -> 1-based dependency layer, from `layerByDependency` (see orchestrator.ts). */
    layerOf: Map<number, number>;
    /** Total planned layer count, so the UI can render the full layer structure before any layer finishes. */
    totalLayers: number;
    /**
     * Id the UI sends back when the operator answers the confirmation gate, or
     * null when the gate is off. Paired with `awaitingConfirmation` rather than
     * inferred from it, so the card never renders controls it has no id to answer
     * with.
     */
    approvalId?: string | null;
    /** True while execution is blocked on the operator's answer. */
    awaitingConfirmation?: boolean;
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  const { rootSessionKey, subtasks, agentIdOf, defaultAgentId, layerOf, totalLayers } = params;
  safeEmit(
    emitEvent,
    {
      kind: "prd",
      rootSessionKey,
      totalLayers,
      approvalId: params.approvalId ?? null,
      awaitingConfirmation: params.awaitingConfirmation === true,
      subtasks: subtasks.map((s) => {
        // null (not defaultAgentId) while routing is pending: the card must be able
        // to tell "unassigned" from "assigned to the fallback agent".
        const agentId = agentIdOf ? (agentIdOf.get(s.id) ?? defaultAgentId) : null;
        return {
          id: s.id,
          title: s.title,
          description: truncate(s.description, EVENT_DESCRIPTION_CHARS),
          agentId,
          acceptanceCriteria: s.acceptanceCriteria
            ? truncate(s.acceptanceCriteria, EVENT_DESCRIPTION_CHARS)
            : null,
          needsPriorResults: s.needsPriorResults ?? [],
          layer: layerOf.get(s.id) ?? null,
        };
      }),
    },
    logger,
  );
}

/**
 * Broadcast one layer's completion. The UI accumulates these per
 * `rootSessionKey` rather than replacing, so a later layer never erases an
 * earlier one.
 */
export function emitLayerProgressEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    layer: number;
    totalLayers: number;
    layerResults: SubtaskResult[];
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  const { rootSessionKey, layer, totalLayers, layerResults } = params;
  safeEmit(
    emitEvent,
    {
      kind: "layer_progress",
      rootSessionKey,
      layer,
      totalLayers,
      results: layerResults.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        status: r.status,
        verifyAttempts: r.status === "ok" ? (r.verifyAttempts ?? null) : null,
        error: r.status === "error" ? r.error : null,
      })),
    },
    logger,
  );
}

/**
 * Broadcast the fixed pipeline about to run.
 *
 * Separate `kind` from `prd` rather than reusing it: a fixed pipeline has no dependency
 * layers, no routing to display and no confirmation gate, so reusing the PRD payload
 * would mean sending fields the card must then be taught to ignore.
 */
export function emitPipelinePlanEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    pipelineId: string;
    name: string;
    steps: ReadonlyArray<{ agentId: string; instruction: string }>;
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  safeEmit(
    emitEvent,
    {
      kind: "pipeline_plan",
      rootSessionKey: params.rootSessionKey,
      pipelineId: params.pipelineId,
      name: truncate(params.name, EVENT_DESCRIPTION_CHARS),
      steps: params.steps.map((s, index) => ({
        index,
        agentId: s.agentId,
        instruction: truncate(s.instruction, EVENT_DESCRIPTION_CHARS),
      })),
    },
    logger,
  );
}

/**
 * Per-step lifecycle for a fixed pipeline.
 *
 * The `end` phase carries the outcome, unlike the dynamic path's `subtask_status` where
 * results arrive separately in a layer event. A fixed pipeline has no layers, so
 * without an outcome here the card would have no way to mark a step failed — and
 * showing the error is what the operator asked for.
 *
 * EVERY step must report `end`, including the ones skipped after an abort. The card
 * derives "the run is over" from having heard about all of them, so a skipped step that
 * stays silent leaves the rest of the list showing "queued" forever. That is also why
 * there is no separate "pipeline finished" event: the skipped reports are the signal.
 */
export function emitStepStatusEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    index: number;
    agentId: string;
    phase: "start" | "end";
    status?: "ok" | "error" | "skipped";
    error?: string;
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  safeEmit(
    emitEvent,
    {
      kind: "step_status",
      rootSessionKey: params.rootSessionKey,
      index: params.index,
      agentId: params.agentId,
      phase: params.phase,
      status: params.status ?? null,
      error: params.error ? truncate(params.error, EVENT_DESCRIPTION_CHARS) : null,
    },
    logger,
  );
}

/**
 * Broadcast that an "adjust" answer was accepted and re-decomposition has started.
 *
 * Emitted BEFORE `decomposeTask` runs, because that call is slow — measured at 62s
 * (28.2s startup + 33.9s model) — and until this event existed the adjust path sent
 * nothing at all in between. The RPC that carries the answer returns in a few
 * milliseconds, so the button un-disabled itself immediately and the card sat
 * unchanged for a minute.
 *
 * It also settles the gate: the reducer clears `approvalId`/`awaitingConfirmation` on
 * receipt. Without that the stale confirm controls stayed live for the whole window,
 * and a second click failed with "unknown or already-answered confirmation" — the same
 * defect already fixed on the confirm/cancel paths.
 *
 * `adjustment` is echoed back so the card can show WHAT is being re-decomposed. That
 * is the part users actually want confirmed — not that something is spinning, but that
 * the sentence they typed was received.
 */
export function emitRedecomposingEvent(
  emitEvent: EmitEvent | undefined,
  params: { rootSessionKey: string; adjustment: string },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  safeEmit(
    emitEvent,
    {
      kind: "redecomposing",
      rootSessionKey: params.rootSessionKey,
      adjustment: truncate(params.adjustment, EVENT_DESCRIPTION_CHARS),
    },
    logger,
  );
}

/**
 * Broadcast that every subtask is done and summarizing has begun.
 *
 * This is the pipeline's last stage and a slow one — 136s measured, 17% of an 819s
 * request — and by then the card already shows all subtasks finished. Without this
 * the operator sees a completed-looking card with no answer for over two minutes.
 *
 * There is deliberately no matching "summarize finished" event: the summary IS the
 * reply, so its arrival as a normal message is the completion signal. The card clears
 * this state when it sees the reply land (see task-orchestrator-events.ts).
 */
export function emitSummarizingEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    /** Subtasks that produced usable output; the card words itself around this. */
    okCount: number;
    totalCount: number;
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  safeEmit(
    emitEvent,
    {
      kind: "summarizing",
      rootSessionKey: params.rootSessionKey,
      okCount: params.okCount,
      totalCount: params.totalCount,
    },
    logger,
  );
}

/**
 * Per-tool-call budget for the argument/result summaries.
 *
 * Much tighter than EVENT_DESCRIPTION_CHARS because these fire many times per
 * subtask and, unlike the PRD, are pure diagnostics. `plugin_event` is an
 * undifferentiated broadcast reaching every connected client, so this is also the
 * cap on how much of a fetched page or written file body leaves this process.
 */
const TOOL_SUMMARY_CHARS = 120;

/**
 * Unwrap the MCP tool-result envelope, `{content: [{type: "text", text}]}`.
 *
 * Without this, every RESULT summary is spent on the envelope itself — observed in
 * practice as `{"content":[{"type":"text","text":"{\n  \"query\"…` with the entire
 * 120-char budget consumed by braces and escaping, and the actual payload cut off.
 * Arguments never have this shape, which is why only results looked useless.
 *
 * Text parts are joined so a multi-part result is not silently reduced to its first
 * fragment.
 */
function unwrapToolEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return value;
  const text = content
    .filter(
      (part): part is { type: string; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  // No text parts (image-only, or an unfamiliar shape) — leave it to the generic
  // path rather than reporting an empty summary.
  return text ? text : value;
}

/**
 * Flatten a tool's params or result into one short line.
 *
 * Prefers the few keys that actually identify what a call did (url/path/command/…)
 * over dumping the whole object: those are what make "web_fetch" readable as
 * "web_fetch example.com", and a blind JSON dump would spend the whole budget on
 * braces and quoting.
 */
export function summarizeToolPayload(value: unknown): string {
  const unwrapped = unwrapToolEnvelope(value);
  if (unwrapped === null || unwrapped === undefined) return "";
  if (typeof unwrapped === "string") return truncate(unwrapped.trim(), TOOL_SUMMARY_CHARS);
  if (typeof unwrapped === "number" || typeof unwrapped === "boolean") return String(unwrapped);
  if (Array.isArray(unwrapped)) return truncate(`${unwrapped.length} 项`, TOOL_SUMMARY_CHARS);
  if (typeof unwrapped !== "object") return "";

  const record = unwrapped as Record<string, unknown>;
  const SALIENT = ["url", "path", "file_path", "filePath", "command", "pattern", "query", "text"];
  for (const key of SALIENT) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) {
      return truncate(`${key}=${found.trim()}`, TOOL_SUMMARY_CHARS);
    }
  }
  try {
    return truncate(JSON.stringify(record), TOOL_SUMMARY_CHARS);
  } catch {
    // Circular or otherwise unserializable — the key list still says something.
    return truncate(Object.keys(record).join(","), TOOL_SUMMARY_CHARS);
  }
}

/**
 * Broadcast one tool call made by a subtask's worker (or its verifier).
 *
 * Exists because the host DOES broadcast these already, as `agent`/`stream:"tool"`
 * events on the CHILD session — but the Control UI drops any tool event whose
 * sessionKey is not the one being viewed (see app-tool-stream.ts), so a subtask's
 * activity is invisible from the root session where the user actually is.
 * Re-emitting under the orchestrator's own event type, tagged with the subtask id,
 * puts it back on screen inside the card that already describes the plan.
 */
export function emitSubtaskToolEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    subtaskId: number;
    agentId: string;
    role: "work" | "verify";
    toolName: string;
    phase: "start" | "result";
    /** Condensed params (on start) or result (on finish). */
    summary?: string;
    error?: string;
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  safeEmit(
    emitEvent,
    {
      kind: "subtask_tool",
      rootSessionKey: params.rootSessionKey,
      subtaskId: params.subtaskId,
      agentId: params.agentId,
      role: params.role,
      toolName: params.toolName,
      phase: params.phase,
      summary: params.summary ? truncate(params.summary, TOOL_SUMMARY_CHARS) : null,
      error: params.error ? truncate(params.error, TOOL_SUMMARY_CHARS) : null,
    },
    logger,
  );
}

/**
 * Broadcast that a subtask has started or finished executing.
 *
 * Needed because results are only reported per LAYER: without this the card cannot
 * tell "queued, not started" from "running right now", and every pending subtask in
 * a layer looks identical until the whole layer completes. The span covers the
 * verify loop too, since verification happens inside the same `runSubtask` call.
 */
export function emitSubtaskStatusEvent(
  emitEvent: EmitEvent | undefined,
  params: {
    rootSessionKey: string;
    subtaskId: number;
    agentId: string;
    phase: "start" | "end";
  },
  logger?: Logger,
): void {
  if (!emitEvent) return;
  safeEmit(
    emitEvent,
    {
      kind: "subtask_status",
      rootSessionKey: params.rootSessionKey,
      subtaskId: params.subtaskId,
      agentId: params.agentId,
      phase: params.phase,
    },
    logger,
  );
}

function safeEmit(emitEvent: EmitEvent, payload: Record<string, unknown>, logger?: Logger): void {
  try {
    emitEvent(PROGRESS_EVENT_TYPE, payload);
  } catch (e) {
    logger?.warn(
      `[dragon-task-orchestrator] progress event emit failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
