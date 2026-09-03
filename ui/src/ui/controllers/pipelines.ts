// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Fixed-pipeline editing state and RPC.
 *
 * The server is authoritative: every write echoes the full list back and we replace
 * local state with it. Optimistic updates were deliberately avoided here for the same
 * reason as the chat mode selector — showing a pipeline the plugin does not actually
 * hold means the next request behaves contrary to the UI.
 *
 * Editing is explicitly staged rather than saved on every keystroke or drag:
 * - a half-finished drag or a partially-typed instruction must not reach disk;
 * - every accepted write bumps `revision`, so auto-saving would turn the optimistic
 *   lock into a stream of spurious conflicts between a user's own edits.
 */

import { t } from "../../i18n/index.ts";

export type PipelineStep = { agentId: string; instruction: string };

export type Pipeline = {
  id: string;
  name: string;
  steps: PipelineStep[];
  createdAt: number;
  updatedAt: number;
};

/**
 * A step while being edited. `uid` exists only in the browser.
 *
 * Required because steps have no server-side id (their order IS their identity), but
 * Lit's `repeat()` needs a stable key that survives reordering — keyed by array index,
 * a drag would make Lit reuse the wrong DOM node and the instruction textareas would
 * appear to swap contents.
 */
export type DraftStep = PipelineStep & { uid: string };

export type PipelineDraft = {
  /** Absent for a pipeline that has not been created yet. */
  id?: string;
  name: string;
  steps: DraftStep[];
};

export type PipelinesState = {
  pipelines: Pipeline[];
  revision: number;
  /** null when the plugin is unavailable — the page then explains itself rather than showing an empty editor. */
  available: boolean | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /**
   * Last successful write, so the UI can confirm it happened.
   *
   * Cleared by the next edit or selection change rather than on a timer: a timer means a
   * pending callback per save, and a confirmation that vanishes on its own can be missed
   * entirely by someone who looked away.
   */
  notice: "saved" | "deleted" | null;
  selectedId: string | null;
  draft: PipelineDraft | null;
  /** True when `draft` differs from the stored pipeline it came from. */
  dirty: boolean;
};

type Client = { request: <T = unknown>(method: string, params?: unknown) => Promise<T> };

/**
 * The host holds this state in ONE nested field rather than flattened onto itself:
 * names like `revision` and `draft` are far too generic for the app's shared namespace
 * and would collide with unrelated features.
 */
export type PipelinesHost = {
  client?: Client | null;
  pipelinesState: PipelinesState;
};

/** Apply a partial update, replacing the object so Lit's reference check re-renders. */
function patch(host: PipelinesHost, next: Partial<PipelinesState>): void {
  host.pipelinesState = { ...host.pipelinesState, ...next };
}

const LIST = "dragonTaskOrchestrator.pipelines.list";
const SAVE = "dragonTaskOrchestrator.pipelines.save";
const DELETE = "dragonTaskOrchestrator.pipelines.delete";

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `s${uidCounter}`;
}

export function initialPipelinesState(): PipelinesState {
  return {
    pipelines: [],
    revision: 0,
    available: null,
    loading: false,
    saving: false,
    error: null,
    notice: null,
    selectedId: null,
    draft: null,
    dirty: false,
  };
}

export function toDraft(pipeline: Pipeline): PipelineDraft {
  return {
    id: pipeline.id,
    name: pipeline.name,
    steps: pipeline.steps.map((s) => ({ ...s, uid: nextUid() })),
  };
}

export function emptyDraft(): PipelineDraft {
  return { name: "", steps: [{ agentId: "", instruction: "", uid: nextUid() }] };
}

export function newStep(): DraftStep {
  return { agentId: "", instruction: "", uid: nextUid() };
}

/**
 * Move a step, returning a new array.
 *
 * Pure and exported so the reordering rules can be tested without a DOM: both drag and
 * the arrow buttons route through this, which is what keeps the two input methods from
 * drifting apart.
 */
export function moveStep<T>(steps: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...steps];
  if (from < 0 || from >= steps.length) return [...steps];
  // Clamped rather than rejected: dropping past the last row is a normal gesture.
  const target = Math.max(0, Math.min(steps.length - 1, to));
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...steps];
  next.splice(target, 0, moved);
  return next;
}

/** Compare a draft against its stored original, to drive the unsaved-changes marker. */
export function isDirty(draft: PipelineDraft | null, pipelines: readonly Pipeline[]): boolean {
  if (!draft) return false;
  if (!draft.id) return true; // A new pipeline is unsaved by definition.
  const stored = pipelines.find((p) => p.id === draft.id);
  if (!stored) return true;
  if (stored.name !== draft.name) return true;
  if (stored.steps.length !== draft.steps.length) return true;
  return stored.steps.some(
    (s, i) =>
      s.agentId !== draft.steps[i]!.agentId || s.instruction !== draft.steps[i]!.instruction,
  );
}

function applySnapshot(
  host: PipelinesHost,
  snapshot: { revision?: unknown; pipelines?: unknown },
): void {
  const revision =
    typeof snapshot.revision === "number" ? snapshot.revision : host.pipelinesState.revision;
  const pipelines = Array.isArray(snapshot.pipelines) ? (snapshot.pipelines as Pipeline[]) : [];
  patch(host, {
    revision,
    pipelines,
    available: true,
    // Re-derived rather than carried over: the snapshot may have just made a draft clean
    // (our own save) or dirty (someone else's edit).
    dirty: isDirty(host.pipelinesState.draft, pipelines),
  });
}

/**
 * Load the list.
 *
 * A failure sets `available: false` rather than surfacing an error, because the most
 * likely cause is that the orchestrator plugin is not installed or is disabled in
 * config — not something the user can fix from this page.
 */
export async function loadPipelines(host: PipelinesHost): Promise<void> {
  if (!host.client) {
    patch(host, { available: null });
    return;
  }
  patch(host, { loading: true, error: null });
  try {
    const result = await host.client.request<{ revision?: number; pipelines?: Pipeline[] }>(LIST);
    applySnapshot(host, result ?? {});
    // Keep the selection if it still exists, otherwise fall back to the first entry so
    // the editor is never pointing at nothing while pipelines exist.
    const { selectedId, pipelines } = host.pipelinesState;
    if (selectedId && !pipelines.some((p) => p.id === selectedId)) {
      selectPipeline(host, pipelines[0]?.id ?? null);
    }
  } catch {
    patch(host, { available: false });
  } finally {
    patch(host, { loading: false });
  }
}

export function selectPipeline(host: PipelinesHost, id: string | null): void {
  const found = id ? host.pipelinesState.pipelines.find((p) => p.id === id) : undefined;
  patch(host, {
    selectedId: id,
    error: null,
    notice: null,
    draft: found ? toDraft(found) : null,
    dirty: false,
  });
}

export function startNewPipeline(host: PipelinesHost): void {
  patch(host, {
    selectedId: null,
    error: null,
    notice: null,
    draft: emptyDraft(),
    dirty: true,
  });
}

/** Mutate the draft through this so `dirty` stays in sync with every edit. */
export function updateDraft(
  host: PipelinesHost,
  mutate: (draft: PipelineDraft) => PipelineDraft,
): void {
  const current = host.pipelinesState.draft;
  if (!current) return;
  const draft = mutate(current);
  patch(host, {
    draft,
    dirty: isDirty(draft, host.pipelinesState.pipelines),
    // A "saved" confirmation next to freshly edited fields would be a lie.
    notice: null,
  });
}

/**
 * A write rejection, localized.
 *
 * The plugin is not localized, so it reports `code` and — for validation — a structured
 * `reason` with its parameters. Its English `message` is the last resort, used when this
 * build has no string for a reason code the plugin has since added.
 */
function describeFailure(result: WriteResponse | undefined, fallbackKey: string): string {
  if (result?.code === "conflict") return t("pipelines.errConflict");
  if (result?.code === "not_found") return t("pipelines.errNotFound");
  const reason = result?.reason;
  if (reason?.code) {
    const key = `pipelines.invalid.${reason.code}`;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(reason)) {
      if (k !== "code") params[k] = String(v);
    }
    const translated = t(key, params);
    // `t` echoes the key back when it is unknown.
    if (translated !== key) return translated;
  }
  return result?.message ?? t(fallbackKey);
}

type WriteResponse = {
  ok?: boolean;
  code?: string;
  message?: string;
  reason?: { code?: string } & Record<string, unknown>;
  revision?: number;
  pipelines?: Pipeline[];
};

export async function savePipeline(host: PipelinesHost): Promise<boolean> {
  const draft = host.pipelinesState.draft;
  if (!host.client || !draft || host.pipelinesState.saving) return false;
  patch(host, { saving: true, error: null, notice: null });
  try {
    const result = await host.client.request<WriteResponse>(SAVE, {
      baseRevision: host.pipelinesState.revision,
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      // `uid` is browser-only and must not be sent.
      steps: draft.steps.map((s) => ({ agentId: s.agentId, instruction: s.instruction })),
    });
    applySnapshot(host, result ?? {});
    if (result?.ok !== true) {
      // Validation and conflict both arrive here. The snapshot above already refreshed
      // the list, so the user sees current state alongside the reason.
      patch(host, { error: describeFailure(result, "pipelines.saveFailed") });
      return false;
    }
    // Re-select so a newly created pipeline becomes the selection and the draft is
    // rebuilt from the server's copy (trimmed values, assigned id).
    const list = host.pipelinesState.pipelines;
    const saved = draft.id
      ? list.find((p) => p.id === draft.id)
      : // A create has no id yet; the newest entry is ours.
        [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    selectPipeline(host, saved?.id ?? null);
    // After `selectPipeline`, which clears `notice` along with the rest of the edit state.
    patch(host, { notice: "saved" });
    return true;
  } catch (err) {
    patch(host, { error: `${t("pipelines.saveFailed")}: ${String(err)}` });
    return false;
  } finally {
    patch(host, { saving: false });
  }
}

export async function removePipeline(host: PipelinesHost, id: string): Promise<boolean> {
  if (!host.client || host.pipelinesState.saving) return false;
  patch(host, { saving: true, error: null, notice: null });
  try {
    const result = await host.client.request<WriteResponse>(DELETE, {
      baseRevision: host.pipelinesState.revision,
      id,
    });
    applySnapshot(host, result ?? {});
    if (result?.ok !== true) {
      patch(host, { error: describeFailure(result, "pipelines.deleteFailed") });
      return false;
    }
    selectPipeline(host, host.pipelinesState.pipelines[0]?.id ?? null);
    patch(host, { notice: "deleted" });
    return true;
  } catch (err) {
    patch(host, { error: `${t("pipelines.deleteFailed")}: ${String(err)}` });
    return false;
  } finally {
    patch(host, { saving: false });
  }
}
