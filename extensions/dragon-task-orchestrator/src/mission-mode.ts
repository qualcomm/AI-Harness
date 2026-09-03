// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Per-session orchestration mode, set from the Control UI.
 *
 * Three states, and `off` is the default:
 * - `off`      — this plugin stays out of the way; the turn is answered normally.
 * - `dynamic`  — decompose the request at runtime and route subtasks (the original
 *                "mission mode").
 * - `pipeline` — run a user-defined fixed sequence of agents (see fixed-pipeline.ts).
 *
 * WHY OFF IS THE DEFAULT
 * Both active modes are expensive — dynamic pays a decomposer call plus a classifier
 * call per subtask, and either can run for minutes. An ordinary question should not pay
 * that, so orchestration is opt-in per session.
 *
 * WHY A RUNTIME STORE RATHER THAN CONFIG
 * `cfg.enabled` is read once in `register()`, so it can only express "is this feature
 * installed". This store is the runtime layer on top: config decides whether the switch
 * exists, this decides what it is set to for one session.
 *
 * SCOPE IS PER SESSION, not global. The selector lives in the chat toolbar, so it has to
 * mean "this conversation". It also keeps a Control UI click from silently changing how
 * Feishu or cron requests behave — those run under different session keys. (Background
 * triggers are additionally filtered in hooks.ts, so they never reach this check.)
 *
 * State is process-local and NOT persisted: a gateway restart returns every session to
 * `off`. That is the safe direction to fail. Note this is the OPPOSITE choice from
 * pipeline-store.ts, which does persist — a pipeline definition is a user asset, while
 * "which mode is this session in" is session context that is safer to lose than to
 * resurrect stale.
 */

export type SessionMode =
  | { kind: "off" }
  | { kind: "dynamic" }
  | { kind: "pipeline"; pipelineId: string };

const OFF: SessionMode = { kind: "off" };

/**
 * Only sessions in a non-default mode are stored. Since `off` is the default, absence
 * from the map means `off` — there is no "explicitly off" to represent.
 */
const modes = new Map<string, SessionMode>();

/**
 * Cap on remembered sessions, so a long-lived gateway cannot grow this without bound.
 * Eviction is oldest-first and drops a session back to `off`, which is the fail-safe
 * direction: the worst case is an operator re-selecting a mode on a very old
 * conversation, never an unexpected orchestration.
 */
const MAX_TRACKED_SESSIONS = 500;

/** The session's mode, or `off` when it has never been set. */
export function getSessionMode(sessionKey: string): SessionMode {
  return modes.get(sessionKey) ?? OFF;
}

/**
 * Set the mode for one session.
 *
 * Re-inserting on every set keeps Map iteration order meaningful as "least recently
 * set first", which is what makes the eviction below sensible.
 */
export function setSessionMode(sessionKey: string, mode: SessionMode): void {
  if (!sessionKey.trim()) return;
  modes.delete(sessionKey);
  if (mode.kind === "off") return;
  // A pipeline mode without an id would be indistinguishable from `off` downstream and
  // could not be executed, so it is rejected rather than stored as a broken state.
  if (mode.kind === "pipeline" && !mode.pipelineId.trim()) return;
  modes.set(sessionKey, mode);
  while (modes.size > MAX_TRACKED_SESSIONS) {
    const oldest = modes.keys().next();
    if (oldest.done) break;
    modes.delete(oldest.value);
  }
}

/**
 * Forget any session pointing at `pipelineId`.
 *
 * Called when a pipeline is deleted. Without this, a session would keep a dangling
 * reference; hooks.ts handles that case by passing the turn through, but leaving the
 * stale selection would make the UI show a pipeline that no longer exists.
 */
export function clearSessionsUsingPipeline(pipelineId: string): number {
  let cleared = 0;
  for (const [sessionKey, mode] of [...modes]) {
    if (mode.kind === "pipeline" && mode.pipelineId === pipelineId) {
      modes.delete(sessionKey);
      cleared++;
    }
  }
  return cleared;
}

/** Test hook: the store is module-level. */
export function resetMissionModeStore(): void {
  modes.clear();
}

/** Diagnostics/tests only. */
export function missionModeSessionCount(): number {
  return modes.size;
}
