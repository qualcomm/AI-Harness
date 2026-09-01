/**
 * Parse `plugin_event` payloads from dragon-task-orchestrator into the
 * accumulating per-session progress state the card renders.
 *
 * Payloads arrive as an undifferentiated gateway broadcast from a plugin — this
 * module treats them as untrusted input: every field is checked, unknown shapes
 * are rejected as a whole rather than partially applied, and both the per-session
 * record and the map itself are size-capped so a misbehaving (or looping)
 * emitter cannot grow UI state without bound.
 *
 * Returns a NEW Map on every accepted event: Lit's `@state()` compares by
 * reference, so mutating the existing map in place would not re-render.
 */

import type {
  TaskOrchestratorLayer,
  TaskOrchestratorProgress,
  TaskOrchestratorResult,
  TaskOrchestratorSubtask,
  TaskOrchestratorToolCall,
} from "./task-orchestrator-card.ts";

export type { TaskOrchestratorProgress } from "./task-orchestrator-card.ts";

/** Plugin id and event type as broadcast by the gateway (`{plugin, type, ...}`). */
export const TASK_ORCHESTRATOR_PLUGIN_ID = "dragon-task-orchestrator";
export const TASK_ORCHESTRATOR_EVENT_TYPE = "dragon_task_progress";

/** Caps: generous next to real plans (maxSubtasks defaults to 4), tight enough to bound state. */
const MAX_SUBTASKS = 64;
const MAX_LAYERS = 64;
const MAX_RESULTS_PER_LAYER = 64;
const MAX_TRACKED_SESSIONS = 20;
const MAX_TEXT_CHARS = 400;
/**
 * Per-subtask tool-activity cap. Unlike subtasks and layers, this grows with how
 * much work an agent does, so it is the one list a long-running subtask can push
 * without bound. Oldest entries are dropped — the newest calls are what tells you
 * where a subtask is right now.
 */
const MAX_TOOL_CALLS_PER_SUBTASK = 30;

type Payload = Record<string, unknown>;

function asRecord(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT_CHARS) : "";
}

function asIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseSubtask(raw: unknown): TaskOrchestratorSubtask | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asIndex(record.id);
  // Absent/null while the plugin's routing pass is still running — the first of the
  // two `prd` broadcasts carries structure only, so a missing agentId is expected
  // here and must not discard the subtask.
  const agentId = asText(record.agentId) || null;
  const title = asText(record.title);
  const description = asText(record.description);
  // Usability is decided by having something to render, not by having an agent:
  // the row shows `title || description`, so an entry with neither is a blank line.
  // (agentId used to serve as this gate, which stopped working once it became
  // legitimately null before routing resolves.)
  if (id === null || (!title && !description)) return null;
  return {
    id,
    title,
    description,
    agentId,
    acceptanceCriteria: typeof record.acceptanceCriteria === "string" ? asText(record.acceptanceCriteria) : null,
    needsPriorResults: Array.isArray(record.needsPriorResults)
      ? record.needsPriorResults
          .map((d) => asIndex(d))
          .filter((d): d is number => d !== null)
          .slice(0, MAX_SUBTASKS)
      : [],
    layer: asIndex(record.layer),
  };
}

function parseResult(raw: unknown): TaskOrchestratorResult | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asIndex(record.id);
  const agentId = asText(record.agentId);
  const status = parseStatus(record.status);
  if (id === null || !agentId || status === null) return null;
  return {
    id,
    agentId,
    status,
    verifyAttempts: asIndex(record.verifyAttempts),
    error: typeof record.error === "string" ? asText(record.error) : null,
  };
}

/** `skipped` arrives only from a fixed pipeline, where a failed step aborts the rest. */
function parseStatus(value: unknown): TaskOrchestratorResult["status"] | null {
  return value === "ok" || value === "error" || value === "skipped" ? value : null;
}

/**
 * One step of a fixed pipeline, from a `kind:"pipeline_plan"` payload.
 *
 * Mapped onto the same subtask shape the dynamic path uses, because a fixed pipeline is
 * a strictly sequential dependency chain — step N is layer N, faithfully.
 *
 * `needsPriorResults` is left EMPTY rather than pointing at the previous step. It is
 * true that step 2 consumes step 1's output, but rendering "← depends on #0" on every
 * row states the obvious and costs a line per step; the ordering is already the point.
 */
function parsePipelineStep(raw: unknown): TaskOrchestratorSubtask | null {
  const record = asRecord(raw);
  if (!record) return null;
  const index = asIndex(record.index);
  const agentId = asText(record.agentId);
  if (index === null || !agentId) return null;
  const instruction = asText(record.instruction);
  return {
    id: index,
    // The instruction is what this step does, so it is the row's title. Falling back to
    // the agent id keeps a step with an empty instruction from rendering as a blank row.
    title: instruction || agentId,
    description: "",
    agentId,
    acceptanceCriteria: null,
    needsPriorResults: [],
    layer: index + 1,
  };
}

/** Keep only the most recently updated sessions, so long-lived tabs stay bounded. */
function capSessions(next: Map<string, TaskOrchestratorProgress>): Map<string, TaskOrchestratorProgress> {
  if (next.size <= MAX_TRACKED_SESSIONS) return next;
  const newestFirst = [...next.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return new Map(newestFirst.slice(0, MAX_TRACKED_SESSIONS));
}

/**
 * Apply one `plugin_event` payload. Returns the next map, or `null` when the
 * payload is not ours / unusable, in which case the caller leaves state alone.
 */
export function applyTaskOrchestratorEvent(
  current: Map<string, TaskOrchestratorProgress>,
  rawPayload: unknown,
  now: number,
): Map<string, TaskOrchestratorProgress> | null {
  const payload = asRecord(rawPayload);
  if (!payload) return null;
  if (payload.plugin !== TASK_ORCHESTRATOR_PLUGIN_ID) return null;
  if (payload.type !== TASK_ORCHESTRATOR_EVENT_TYPE) return null;

  const rootSessionKey = asText(payload.rootSessionKey);
  if (!rootSessionKey) return null;

  const existing = current.get(rootSessionKey);

  if (payload.kind === "prd") {
    if (!Array.isArray(payload.subtasks)) return null;
    const subtasks = payload.subtasks
      .map((s) => parseSubtask(s))
      .filter((s): s is TaskOrchestratorSubtask => s !== null)
      .slice(0, MAX_SUBTASKS);
    if (subtasks.length === 0) return null;
    // Both required together: without an id the card has nothing to answer with, so
    // rendering the controls would produce a dead button.
    const approvalId = asText(payload.approvalId);
    const awaitingConfirmation = payload.awaitingConfirmation === true && approvalId.length > 0;
    // A PRD starts a new turn: layers from a previous run on the same session must
    // not survive into it. It also arrives again after an adjustment, replacing the
    // superseded plan.
    const next = new Map(current);
    next.set(rootSessionKey, {
      subtasks,
      layers: [],
      updatedAt: now,
      // A PRD marks the start of this plan's turn. Re-set on an adjusted plan too:
      // the revised plan is what the eventual reply will correspond to.
      startedAt: now,
      plannedTotalLayers: asIndex(payload.totalLayers),
      approvalId: awaitingConfirmation ? approvalId : null,
      awaitingConfirmation,
      // Activity from a previous run (or a superseded plan) must not carry over —
      // its subtask ids refer to a plan that no longer exists.
      toolCalls: [],
      runningSubtaskIds: [],
      // Same reasoning: a previous turn's summarizing state would otherwise show a
      // spinner over a plan that has not even started executing. Spelled out rather
      // than relying on the object being rebuilt, since that is easy to break by
      // switching this branch to a spread.
      summarizing: null,
      // A PRD is also how re-decomposition ENDS — this is the revised plan (or, on
      // failure, the superseded one being re-published). Every outcome lands here, so
      // clearing it in this one place is what guarantees no stuck spinner.
      redecomposing: null,
      // Spelled out for the same reason as the fields above: the same session can have
      // run a fixed pipeline earlier, and inheriting `mode: "pipeline"` would label this
      // decomposition's rows "steps" and hide their acceptance criteria.
      mode: "dynamic",
      pipelineName: null,
    });
    return capSessions(next);
  }

  if (payload.kind === "pipeline_plan") {
    if (!Array.isArray(payload.steps)) return null;
    const subtasks = payload.steps
      .map((s) => parsePipelineStep(s))
      .filter((s): s is TaskOrchestratorSubtask => s !== null)
      .slice(0, MAX_SUBTASKS);
    if (subtasks.length === 0) return null;
    // Starts a new turn, exactly like `prd`: everything accumulated for this session
    // belongs to a previous run and its ids refer to a plan that no longer exists.
    const next = new Map(current);
    next.set(rootSessionKey, {
      subtasks,
      layers: [],
      updatedAt: now,
      startedAt: now,
      // One layer per step, so the card can show the full shape before anything runs.
      // Derived rather than read from the payload: one less field to validate, and the
      // step cap (20) is far below MAX_SUBTASKS so nothing can be truncated into a
      // wrong total.
      plannedTotalLayers: subtasks.length,
      // A fixed pipeline has no confirmation gate — the operator chose the pipeline.
      approvalId: null,
      awaitingConfirmation: false,
      toolCalls: [],
      runningSubtaskIds: [],
      summarizing: null,
      redecomposing: null,
      mode: "pipeline",
      pipelineName: asText(payload.name) || null,
    });
    return capSessions(next);
  }

  if (payload.kind === "step_status") {
    // Needs a plan to attach to, same as every other incremental event.
    if (!existing) return null;
    const index = asIndex(payload.index);
    const phase = payload.phase === "start" || payload.phase === "end" ? payload.phase : null;
    if (index === null || phase === null) return null;
    if (!existing.subtasks.some((s) => s.id === index)) return null;

    const running = new Set(existing.runningSubtaskIds ?? []);
    if (phase === "start") {
      running.add(index);
      const next = new Map(current);
      next.set(rootSessionKey, { ...existing, runningSubtaskIds: [...running], updatedAt: now });
      return capSessions(next);
    }

    // `end` carries the outcome inline — a fixed pipeline has no layer event to deliver
    // it separately. Synthesized into a one-result layer so the existing `resultFor` /
    // `isFinished` / timeline rendering all apply unchanged.
    const status = parseStatus(payload.status);
    const agentId = asText(payload.agentId);
    if (status === null || !agentId) return null;
    const layer = index + 1;
    if (existing.layers.some((l) => l.layer === layer)) return null; // duplicate broadcast
    if (existing.layers.length >= MAX_LAYERS) return null;

    running.delete(index);
    const entry: TaskOrchestratorLayer = {
      layer,
      // From the plan, not the payload: every step must agree on the total, or the
      // "is it finished" comparison would move around as steps report.
      totalLayers: existing.plannedTotalLayers ?? existing.subtasks.length,
      results: [
        {
          id: index,
          agentId,
          status,
          // Fixed pipelines have no verification pass.
          verifyAttempts: null,
          error: typeof payload.error === "string" ? asText(payload.error) : null,
        },
      ],
    };
    const next = new Map(current);
    next.set(rootSessionKey, {
      ...existing,
      layers: [...existing.layers, entry].sort((a, b) => a.layer - b.layer),
      runningSubtaskIds: [...running],
      updatedAt: now,
    });
    return capSessions(next);
  }

  if (payload.kind === "subtask_status") {
    // Needs a plan to attach to, same as tool activity.
    if (!existing) return null;
    const subtaskId = asIndex(payload.subtaskId);
    const phase = payload.phase === "start" || payload.phase === "end" ? payload.phase : null;
    if (subtaskId === null || phase === null) return null;
    if (!existing.subtasks.some((s) => s.id === subtaskId)) return null;

    const running = new Set(existing.runningSubtaskIds ?? []);
    if (phase === "start") running.add(subtaskId);
    else running.delete(subtaskId);

    const next = new Map(current);
    next.set(rootSessionKey, { ...existing, runningSubtaskIds: [...running], updatedAt: now });
    return capSessions(next);
  }

  if (payload.kind === "subtask_tool") {
    // Activity without a PRD has no row to attach to, so it is dropped rather than
    // rendered as an orphan list.
    if (!existing) return null;
    const subtaskId = asIndex(payload.subtaskId);
    const toolName = asText(payload.toolName);
    const phase = payload.phase === "start" || payload.phase === "result" ? payload.phase : null;
    if (subtaskId === null || !toolName || phase === null) return null;
    if (!existing.subtasks.some((s) => s.id === subtaskId)) return null;

    const call: TaskOrchestratorToolCall = {
      subtaskId,
      toolName,
      phase,
      role: payload.role === "verify" ? "verify" : "work",
      summary: typeof payload.summary === "string" ? asText(payload.summary) : null,
      error: typeof payload.error === "string" ? asText(payload.error) : null,
    };

    // A "result" collapses into the matching pending "start" instead of appending,
    // so one tool call stays one row rather than becoming two.
    const previous = existing.toolCalls ?? [];
    let toolCalls: TaskOrchestratorToolCall[];
    const pendingIdx =
      phase === "result"
        ? previous.findLastIndex(
            (c) => c.subtaskId === subtaskId && c.toolName === toolName && c.phase === "start",
          )
        : -1;
    if (pendingIdx >= 0) {
      toolCalls = [...previous];
      toolCalls[pendingIdx] = call;
    } else {
      toolCalls = [...previous, call];
    }
    // Cap per subtask, not globally, so a chatty subtask cannot starve the others.
    const perSubtask = toolCalls.filter((c) => c.subtaskId === subtaskId);
    if (perSubtask.length > MAX_TOOL_CALLS_PER_SUBTASK) {
      const excess = perSubtask.length - MAX_TOOL_CALLS_PER_SUBTASK;
      let dropped = 0;
      toolCalls = toolCalls.filter((c) => {
        if (c.subtaskId !== subtaskId || dropped >= excess) return true;
        dropped++;
        return false;
      });
    }

    const next = new Map(current);
    next.set(rootSessionKey, { ...existing, toolCalls, updatedAt: now });
    return capSessions(next);
  }

  if (payload.kind === "redecomposing") {
    // Without a plan on screen there is nothing being re-decomposed.
    if (!existing) return null;
    const adjustment = asText(payload.adjustment);
    const next = new Map(current);
    next.set(rootSessionKey, {
      ...existing,
      updatedAt: now,
      redecomposing: { adjustment },
      // Settles the gate. The superseded plan's approvalId has already been consumed
      // by the plugin, so leaving the controls live means a second click fails with
      // "unknown or already-answered confirmation" — which is exactly what happened
      // before this event existed.
      approvalId: null,
      awaitingConfirmation: false,
    });
    return capSessions(next);
  }

  if (payload.kind === "summarizing") {
    // Without a PRD there is no card to annotate.
    if (!existing) return null;
    const okCount = asIndex(payload.okCount);
    const totalCount = asIndex(payload.totalCount);
    if (okCount === null || totalCount === null) return null;
    const next = new Map(current);
    next.set(rootSessionKey, {
      ...existing,
      updatedAt: now,
      // Summarizing begins only after every subtask has settled, so nothing can still
      // be running. Clearing here too means a dropped `subtask_status` end event cannot
      // leave a spinner on a subtask row while the summary spinner is also showing.
      runningSubtaskIds: [],
      summarizing: { okCount, totalCount },
    });
    return capSessions(next);
  }

  if (payload.kind === "layer_progress") {
    // Progress without a PRD would render a card with no task list, so it is
    // dropped rather than shown half-populated.
    if (!existing) return null;
    const layer = asIndex(payload.layer);
    const totalLayers = asIndex(payload.totalLayers);
    if (layer === null || totalLayers === null) return null;
    if (!Array.isArray(payload.results)) return null;
    if (existing.layers.some((l) => l.layer === layer)) return null; // duplicate broadcast
    if (existing.layers.length >= MAX_LAYERS) return null;

    const entry: TaskOrchestratorLayer = {
      layer,
      totalLayers,
      results: payload.results
        .map((r) => parseResult(r))
        .filter((r): r is TaskOrchestratorResult => r !== null)
        .slice(0, MAX_RESULTS_PER_LAYER),
    };
    const next = new Map(current);
    // Spread rather than an explicit field list: this branch used to enumerate every
    // field, which silently dropped any field added later (`mode` and `pipelineName`
    // were the ones that exposed it). The overrides below are the only intended changes.
    next.set(rootSessionKey, {
      ...existing,
      layers: [...existing.layers, entry].sort((a, b) => a.layer - b.layer),
      updatedAt: now,
      // Execution has started, so the confirmation is settled — clear the controls
      // even if the resolved broadcast for it never arrived.
      approvalId: null,
      awaitingConfirmation: false,
      // Anything this layer reported is finished by definition. Clearing here as well
      // as on the paired "end" event means a dropped event cannot leave a stuck spinner.
      runningSubtaskIds: (existing.runningSubtaskIds ?? []).filter(
        (id) => !entry.results.some((r) => r.id === id),
      ),
    });
    return capSessions(next);
  }

  return null;
}

/**
 * Look up the entry for the session a chat view is showing.
 *
 * Not a plain `map.get`: the view's own `sessionKey` can still be the bare alias
 * `"main"` (see `normalizeSessionKeyForDefaults` in app-gateway.ts — it only
 * rewrites the alias once session defaults arrive), while the plugin always
 * reports the host-resolved key it was handed, e.g. `"agent:main:main"`. An exact
 * match alone would silently render nothing in exactly the default case.
 *
 * The alias fallback is deliberately narrow: it only applies when the view key
 * has no `:` (so it cannot be a fully-qualified key), and when several sessions
 * share that tail the most recently updated one wins.
 */
export function findProgressForSession(
  map: Map<string, TaskOrchestratorProgress> | null | undefined,
  sessionKey: string,
): TaskOrchestratorProgress | undefined {
  if (!map || !sessionKey) return undefined;
  const exact = map.get(sessionKey);
  if (exact) return exact;
  if (sessionKey.includes(":")) return undefined;

  const suffix = `:${sessionKey}`;
  let best: TaskOrchestratorProgress | undefined;
  for (const [key, value] of map) {
    if (!key.endsWith(suffix)) continue;
    if (!best || value.updatedAt > best.updatedAt) best = value;
  }
  return best;
}
