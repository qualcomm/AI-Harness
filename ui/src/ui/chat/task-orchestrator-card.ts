/**
 * dragon-task-orchestrator progress card.
 *
 * Rendered at the TAIL of the message flow rather than as a top banner: the data
 * is a multi-entry task list plus a per-layer record that accumulates over time,
 * and a banner can only ever show "the newest single value" (see how
 * `renderPrivacyIndicator` works — one field, overwritten, auto-cleared). Card
 * chrome and the collapse affordance deliberately mirror `tool-cards.ts` so this
 * reads as one more card in the stream.
 *
 * The card is a live view of an in-flight turn, not transcript content: the
 * plugin broadcasts these updates over `plugin_event` while the pipeline runs,
 * and the final summarized reply arrives separately as a normal message.
 */

import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

/** One subtask as broadcast in the `kind:"prd"` payload. */
export type TaskOrchestratorSubtask = {
  id: number;
  title: string;
  description: string;
  /**
   * null until routing resolves. The plugin publishes a plan twice — structure
   * first, routing second — because classifying subtasks costs model calls, and
   * waiting for them delayed the whole card by tens of seconds.
   */
  agentId: string | null;
  acceptanceCriteria: string | null;
  needsPriorResults: number[];
  /** 1-based dependency layer computed by the orchestrator; null if unschedulable. */
  layer: number | null;
};

/** One subtask result as broadcast in a `kind:"layer_progress"` payload. */
export type TaskOrchestratorResult = {
  id: number;
  agentId: string;
  /** `skipped` only occurs in pipeline mode, where a failed step aborts the rest. */
  status: "ok" | "error" | "skipped";
  verifyAttempts: number | null;
  error: string | null;
};

export type TaskOrchestratorLayer = {
  layer: number;
  totalLayers: number;
  results: TaskOrchestratorResult[];
};

/**
 * One tool call made by a subtask's worker (or its verifier), relayed by the
 * plugin because the host's own tool events are scoped to the child session and
 * therefore invisible from the root session (see task-orchestrator-events.ts).
 *
 * `phase: "start"` means still running; a `"result"` replaces it in place.
 */
export type TaskOrchestratorToolCall = {
  subtaskId: number;
  toolName: string;
  phase: "start" | "result";
  role: "work" | "verify";
  /** Condensed params while running, condensed result once finished. */
  summary: string | null;
  error: string | null;
};

/**
 * Accumulated state for one root session. `layers` grows as progress events
 * arrive — replacing it on each event would erase every earlier layer, which is
 * the whole reason this is not modeled like `privacyStatus`.
 */
export type TaskOrchestratorProgress = {
  subtasks: TaskOrchestratorSubtask[];
  layers: TaskOrchestratorLayer[];
  updatedAt: number;
  /**
   * When this plan first appeared, i.e. when its PRD arrived.
   *
   * Distinct from `updatedAt` (which moves on every event) because it answers a
   * different question: which chat messages belong to the same turn as this plan.
   * The card uses it to sit above the reply it produced while staying below replies
   * from earlier turns — see `cardBeforeIndex` in views/chat.ts.
   */
  startedAt: number;
  /** Planned layer count from the PRD event, known before any layer finishes. */
  plannedTotalLayers: number | null;
  /** Id to send back when answering the confirmation gate; null when not awaiting. */
  approvalId: string | null;
  /** True while the orchestrator is blocked waiting for this operator's answer. */
  awaitingConfirmation: boolean;
  /**
   * Tool activity across all subtasks, in arrival order. Optional so an entry
   * produced before this field existed still renders.
   */
  toolCalls?: TaskOrchestratorToolCall[];
  /**
   * Subtasks currently executing. Layer results only arrive when a whole layer
   * finishes, so without this the card cannot tell "queued" from "running now".
   */
  runningSubtaskIds?: number[];
  /**
   * Set once every subtask is done and the summarizing call has started.
   *
   * Its own field rather than derived from "all layers finished", because that
   * condition is true for the whole summarizing window AND after the reply lands —
   * the card needs to stop showing the spinner at the second point, not the first.
   */
  summarizing?: { okCount: number; totalCount: number } | null;
  /**
   * Set while the orchestrator is re-decomposing after an "adjust" answer, carrying an
   * echo of what the operator asked for.
   *
   * Needed because re-decomposition takes ~62s and the RPC that submits the answer
   * returns in milliseconds — nothing else marks that window. Cleared by the next
   * `prd` event, which every outcome of re-decomposition reaches (success, failure, or
   * a collapsed plan), so this cannot get stuck.
   */
  redecomposing?: { adjustment: string } | null;
  /**
   * Which orchestration mode produced this entry. Optional, defaulting to `dynamic`,
   * so an entry created before this field existed still renders as before.
   *
   * A fixed pipeline is a strictly sequential dependency chain, so it maps onto the
   * layered model faithfully — step N IS layer N. What differs is only vocabulary and
   * which sections apply: there are no acceptance criteria, no verification, no
   * confirmation gate and no summarizing pass. See `labelsFor`.
   */
  mode?: "dynamic" | "pipeline";
  /** Pipeline name, for the card title. Only set in pipeline mode. */
  pipelineName?: string | null;
};

/**
 * Mode-dependent wording, resolved once per render.
 *
 * A table rather than a ternary at each of the six call sites: the two modes describe
 * the same structure with different nouns ("layer" vs "step"), and scattering that
 * choice is how one site ends up saying "layer" while the rest say "step".
 */
type CardLabels = {
  title: (pipelineName: string | null | undefined) => string;
  count: (n: number, state: string) => string;
  sectionLabel: string;
  timelineLabel: string;
  /**
   * Heading above each group of task rows, or null for no headings.
   *
   * Null for pipelines: every layer there holds exactly one step, so a heading per group
   * would double the list's height and repeat the number the row already shows.
   */
  groupTitle: ((layer: number) => string) | null;
  unitDone: (layer: number, total: number) => string;
  unitOf: (layer: number, total: number) => string;
  allUnitsDone: (total: number) => string;
  /** Fixed pipelines have no acceptance criteria, so the row would always read "none". */
  showCriteria: boolean;
  /** Row marker. Pipelines number steps from 1, matching the editor; PRD ids are 0-based. */
  rowMarker: (id: number) => string;
};

function labelsFor(progress: TaskOrchestratorProgress): CardLabels {
  if (progress.mode === "pipeline") {
    return {
      title: (name) =>
        name
          ? t("taskOrchestrator.pipelineCardTitle", { name })
          : t("taskOrchestrator.pipelineCardTitleUnnamed"),
      count: (n, state) =>
        t("taskOrchestrator.pipelineCount", { count: String(n), label: state }),
      sectionLabel: t("taskOrchestrator.pipelineStepsLabel"),
      timelineLabel: t("taskOrchestrator.pipelineTimelineLabel"),
      groupTitle: null,
      unitDone: (layer, total) =>
        t("taskOrchestrator.stepDone", { step: String(layer), total: String(total) }),
      unitOf: (layer, total) =>
        t("taskOrchestrator.stepOf", { step: String(layer), total: String(total) }),
      allUnitsDone: (total) => t("taskOrchestrator.allStepsDone", { total: String(total) }),
      showCriteria: false,
      rowMarker: (id) => String(id + 1),
    };
  }
  return {
    title: () => t("taskOrchestrator.cardTitle"),
    count: (n, state) => t("taskOrchestrator.cardCount", { count: String(n), label: state }),
    sectionLabel: t("taskOrchestrator.subtasksLabel"),
    timelineLabel: t("taskOrchestrator.timelineLabel"),
    groupTitle: (layer) => t("taskOrchestrator.layerN", { layer: String(layer) }),
    unitDone: (layer, total) =>
      t("taskOrchestrator.layerDone", { layer: String(layer), total: String(total) }),
    unitOf: (layer, total) =>
      t("taskOrchestrator.layerOf", { layer: String(layer), total: String(total) }),
    allUnitsDone: (total) => t("taskOrchestrator.headerAllLayersDone", { total: String(total) }),
    showCriteria: true,
    rowMarker: (id) => `#${id}`,
  };
}

/** What the operator can do with a proposed decomposition. */
export type TaskOrchestratorDecision = "confirm" | "cancel" | "adjust";

/**
 * Prefer the count reported alongside a finished layer — it reflects what the
 * pipeline actually ran, which can differ from the plan if a subtask became
 * unschedulable at runtime. Before any layer finishes, fall back to the
 * planned count so the layered structure can render immediately.
 */
function totalLayersOf(progress: TaskOrchestratorProgress): number | null {
  const last = progress.layers.at(-1);
  return last ? last.totalLayers : progress.plannedTotalLayers;
}

/** True once the last layer has reported — nothing further will arrive. */
function isFinished(progress: TaskOrchestratorProgress): boolean {
  const total = totalLayersOf(progress);
  return total !== null && progress.layers.length >= total;
}

/** Final state of a subtask, or undefined while it is still pending. */
function resultFor(
  progress: TaskOrchestratorProgress,
  id: number,
): TaskOrchestratorResult | undefined {
  for (const layer of progress.layers) {
    const hit = layer.results.find((r) => r.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Whether the plan is still awaiting the operator's answer.
 *
 * Requires the id as well as the flag: without one there is nothing to answer
 * with, so the card must not present itself as actionable.
 */
function isAwaitingConfirmation(progress: TaskOrchestratorProgress): boolean {
  return progress.awaitingConfirmation && progress.approvalId !== null;
}

/**
 * `awaiting` is distinguished from the ordinary pre-execution state on purpose:
 * "Queued" reads as "accepted, waiting its turn", which would misdescribe a plan that
 * has not been approved yet and may never run at all.
 *
 * `redecomposing` needs the same treatment for the same reason, and cannot reuse
 * `awaiting`: by then the gate has been answered, so these rows belong to a plan that
 * is being REPLACED — it will never run in this form.
 */
function renderSubtaskState(
  result: TaskOrchestratorResult | undefined,
  finished: boolean,
  awaiting: boolean,
  running = false,
  redecomposing = false,
) {
  if (!result) {
    // Running wins over the other pending labels: it is the only one that reports
    // live activity rather than a queue position.
    if (running && !awaiting && !redecomposing) {
      return html`<span class="dto-state dto-state--run"
        ><span class="dto-spinner" aria-hidden="true"></span>${t("taskOrchestrator.running")}</span
      >`;
    }
    return html`<span class="dto-state dto-state--run"
      >${redecomposing
        ? t("taskOrchestrator.toBeReplaced")
        : awaiting
          ? t("taskOrchestrator.awaiting")
          : finished
            ? t("taskOrchestrator.notRun")
            : t("taskOrchestrator.queued")}</span
    >`;
  }
  if (result.status === "skipped") {
    // Neither passed nor failed: an earlier step aborted the run before this one was
    // reached. Rendering it as an error would blame the wrong step.
    return html`<span class="dto-state dto-state--skip">⏭ ${t("taskOrchestrator.notRun")}</span>`;
  }
  if (result.status === "ok") {
    const attempts = result.verifyAttempts;
    return html`<span class="dto-state dto-state--ok"
      >✓${attempts && attempts > 1
        ? ` ${t("taskOrchestrator.verifyPassed", { attempts: String(attempts) })}`
        : ""}</span
    >`;
  }
  return html`<span class="dto-state dto-state--err" title=${result.error ?? ""}>✕</span>`;
}

/**
 * Group subtasks by their dependency layer, preserving each layer's original
 * order. Layer `null` (unschedulable — see layerByDependency in pipeline.ts)
 * sorts last, since it means the subtask never got a place in the plan.
 */
function groupByLayer(
  subtasks: TaskOrchestratorSubtask[],
): { layer: number | null; items: TaskOrchestratorSubtask[] }[] {
  const groups = new Map<number | null, TaskOrchestratorSubtask[]>();
  for (const s of subtasks) {
    const bucket = groups.get(s.layer);
    if (bucket) bucket.push(s);
    else groups.set(s.layer, [s]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
    .map(([layer, items]) => ({ layer, items }));
}

/**
 * Live tool activity for one subtask, oldest first so it reads as a trace.
 *
 * Rendered as a sibling block rather than inside `.dto-subtask`, because that row
 * is a fixed-column grid and this list is variable-height.
 */
function renderSubtaskActivity(progress: TaskOrchestratorProgress, subtaskId: number) {
  const calls = (progress.toolCalls ?? []).filter((c) => c.subtaskId === subtaskId);
  if (calls.length === 0) return nothing;
  return html`
    <div class="dto-activity">
      ${calls.map(
        (c) => html`
          <div class="dto-activity__row">
            <span
              class="dto-activity__dot ${c.error
                ? "dto-activity__dot--err"
                : c.phase === "start"
                  ? "dto-activity__dot--run"
                  : "dto-activity__dot--ok"}"
            ></span>
            <span class="dto-activity__tool">${c.toolName}</span>
            ${c.role === "verify"
              ? html`<span class="dto-activity__role">${t("taskOrchestrator.roleVerify")}</span>`
              : nothing}
            <span class="dto-activity__detail" title=${c.error ?? c.summary ?? ""}
              >${c.error ?? c.summary ?? ""}</span
            >
            ${c.phase === "start" && !c.error
              ? html`<span class="dto-activity__pending">…</span>`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * Acceptance criteria as a wrapping line beneath the subtask row.
 *
 * Deliberately NOT a `.dto-agent` badge: that style is `white-space: nowrap` and was
 * built for short agent ids, so a sentence-long criterion (capped at 200 chars by
 * the emitter) overflowed the card horizontally instead of truncating. Criteria are
 * what a subtask is judged against, so they are shown in full and allowed to wrap.
 */
function renderSubtaskCriteria(s: TaskOrchestratorSubtask) {
  const criteria = s.acceptanceCriteria?.trim();
  if (!criteria) {
    return html`<div class="dto-criteria dto-criteria--none">
      ${t("taskOrchestrator.noCriteria")}
    </div>`;
  }
  return html`
    <div class="dto-criteria">
      <span class="dto-criteria__label">${t("taskOrchestrator.criteriaLabel")}</span>
      <span class="dto-criteria__text">${criteria}</span>
    </div>
  `;
}

function renderSubtaskRow(
  s: TaskOrchestratorSubtask,
  progress: TaskOrchestratorProgress,
  finished: boolean,
  labels: CardLabels,
) {
  const result = resultFor(progress, s.id);
  return html`
    <div class="dto-subtask">
      <span class="dto-subtask__idx">${labels.rowMarker(s.id)}</span>
      <span class="dto-subtask__desc"
        >${s.title || s.description}${s.needsPriorResults.length > 0
          ? html`<span class="dto-subtask__idx">
              ${t("taskOrchestrator.dependsOn", {
                ids: s.needsPriorResults.map((d) => `#${d}`).join(" "),
              })}</span
            >`
          : nothing}</span
      >
      ${s.agentId === null
        ? html`<span class="dto-agent dto-agent--pending"
            >${t("taskOrchestrator.assigning")}</span
          >`
        : html`<span class="dto-agent">${s.agentId}</span>`}
      ${renderSubtaskState(
        result,
        finished,
        isAwaitingConfirmation(progress),
        (progress.runningSubtaskIds ?? []).includes(s.id),
        progress.redecomposing != null,
      )}
    </div>
    ${labels.showCriteria ? renderSubtaskCriteria(s) : nothing}
    ${renderSubtaskActivity(progress, s.id)}
  `;
}

function renderSubtasks(
  progress: TaskOrchestratorProgress,
  finished: boolean,
  labels: CardLabels,
) {
  const groups = groupByLayer(progress.subtasks);
  return html`
    <div>
      <div class="dto-section-label">${labels.sectionLabel}</div>
      ${groups.map(
        ({ layer, items }) => html`
          <div class="dto-layer-group">
            ${
              // The unscheduled marker always shows: it says the subtask has no place in
              // the plan at all, which no other part of the row conveys.
              layer === null
                ? html`<div class="dto-layer-group__title">
                    ${t("taskOrchestrator.unscheduled")}
                  </div>`
                : labels.groupTitle
                  ? html`<div class="dto-layer-group__title">
                      ${labels.groupTitle(layer)}
                    </div>`
                  : nothing
            }
            ${items.map((s) => renderSubtaskRow(s, progress, finished, labels))}
          </div>
        `,
      )}
    </div>
  `;
}

/** Timeline of finished layers, plus a live marker for the one still running. */
function renderTimeline(
  progress: TaskOrchestratorProgress,
  finished: boolean,
  labels: CardLabels,
) {
  const total = totalLayersOf(progress);
  // Kept as one object so the pair narrows together: the live marker needs BOTH numbers,
  // and two independently-nullable locals cannot express "either both or neither".
  // Previously the total was interpolated with `String(total)`, which accepted null and
  // would have rendered "Layer 3/null".
  const pending =
    finished || total === null ? null : { layer: progress.layers.length + 1, total };
  // Nothing reported and nothing pending: a run that died mid-flight, settled only by the
  // reply landing. Rendering the heading alone would be a section with no content.
  if (progress.layers.length === 0 && pending === null) return nothing;

  return html`
    <div>
      <div class="dto-section-label">${labels.timelineLabel}</div>
      <div class="dto-timeline">
        ${progress.layers.map((layer) => {
          const failed = layer.results.filter((r) => r.status === "error").length;
          // A layer whose every result was skipped is neither passed nor failed. In
          // pipeline mode each layer holds exactly one step, so this is the whole
          // "never reached" case; in dynamic mode `skipped` never occurs at all.
          const allSkipped =
            layer.results.length > 0 && layer.results.every((r) => r.status === "skipped");
          const isLast = layer.layer >= layer.totalLayers && pending === null;
          return html`
            <div class="dto-tl">
              <div class="dto-tl__rail">
                <div
                  class="dto-tl__dot ${failed > 0
                    ? "dto-tl__dot--err"
                    : allSkipped
                      ? "dto-tl__dot--skip"
                      : "dto-tl__dot--ok"}"
                ></div>
                ${isLast ? nothing : html`<div class="dto-tl__line"></div>`}
              </div>
              <div class="dto-tl__content">
                <div class="dto-tl__head">
                  <span class="dto-tl__title"
                    >${labels.unitDone(layer.layer, layer.totalLayers)}</span
                  >
                  ${failed > 0
                    ? html`<span class="dto-state dto-state--err"
                        >${t("taskOrchestrator.failedCount", { count: String(failed) })}</span
                      >`
                    : allSkipped
                      ? html`<span class="dto-state dto-state--skip"
                          >${t("taskOrchestrator.notRun")}</span
                        >`
                      : html`<span class="dto-state dto-state--ok"
                          >${t("taskOrchestrator.allPassed")}</span
                        >`}
                </div>
                <div class="dto-tl__items">
                  ${layer.results.map(
                    (r) => html`
                      <span
                        class="dto-chip ${r.status === "ok"
                          ? "dto-chip--ok"
                          : r.status === "skipped"
                            ? "dto-chip--skip"
                            : "dto-chip--err"}"
                        title=${r.error ?? ""}
                      >
                        <span class="dto-chip__agent">${r.agentId}#${r.id}</span>
                        ${r.status === "ok"
                          ? html`✓${r.verifyAttempts && r.verifyAttempts > 1
                              ? ` ${t("taskOrchestrator.verifyPassed", {
                                  attempts: String(r.verifyAttempts),
                                })}`
                              : ""}`
                          : r.status === "skipped"
                            ? html`⏭ ${t("taskOrchestrator.notRun")}`
                            : html`✕ ${r.error ?? t("taskOrchestrator.execFailed")}`}
                      </span>
                    `,
                  )}
                </div>
              </div>
            </div>
          `;
        })}
        ${pending !== null
          ? html`
              <div class="dto-tl">
                <div class="dto-tl__rail">
                  <div class="dto-tl__dot dto-tl__dot--run"></div>
                </div>
                <div class="dto-tl__content">
                  <div class="dto-tl__head">
                    <span class="dto-tl__title"
                      >${labels.unitOf(pending.layer, pending.total)}</span
                    >
                    <span class="dto-state dto-state--run"
                      >${t("taskOrchestrator.inProgressEllipsis")}</span
                    >
                  </div>
                </div>
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

/**
 * Confirmation controls, shown only while the orchestrator is actually blocked on
 * an answer. Execution has not started at this point — nothing in the plan below
 * has run yet.
 *
 * The adjustment text is read from the DOM at submit time rather than being held
 * as caller state: this module is a pure render function (see `expanded`, the only
 * state it takes), and a controlled input would mean a prop round-trip and a
 * re-render per keystroke for a field that is read exactly once.
 */
/**
 * "Summarizing…" row, shown between the last finished subtask and the reply.
 *
 * This window is long — 136s measured, 17% of an 819s request — and until it ends the
 * card otherwise reads as fully done with no answer in sight.
 *
 * `replyLanded` is the stop condition: the summary IS the reply, so the plugin sends
 * no "finished" event and the arrival of the assistant message is the only signal.
 * Without that check the spinner would stay on the card forever.
 */
function renderSummarizing(progress: TaskOrchestratorProgress, replyLanded: boolean) {
  const state = progress.summarizing;
  if (!state || replyLanded) {
    return nothing;
  }
  const failedNote =
    state.totalCount > state.okCount
      ? t("taskOrchestrator.summarizingNote", {
          ok: String(state.okCount),
          total: String(state.totalCount),
        })
      : "";
  return html`
    <div class="dto-summarizing">
      <span class="dto-spinner" aria-hidden="true"></span>
      <span class="dto-summarizing__text"
        >${t("taskOrchestrator.summarizingText", { note: failedNote })}</span
      >
    </div>
  `;
}

/**
 * "Re-decomposing…" block, shown in place of the confirm bar after an "adjust" answer.
 *
 * Echoes the operator's own wording back: the useful confirmation is not that something
 * is spinning, it is that the sentence they typed was received. The duration hint is a
 * fixed range rather than a live counter — the card only re-renders on events, so a
 * counter would freeze at 0s unless a timer were added, which is not worth it for a
 * one-minute wait.
 */
function renderRedecomposing(progress: TaskOrchestratorProgress) {
  const state = progress.redecomposing;
  if (!state) {
    return nothing;
  }
  return html`
    <div class="dto-redecomposing">
      <div class="dto-redecomposing__head">
        <span class="dto-spinner" aria-hidden="true"></span>
        <span>${t("taskOrchestrator.redecomposingHead")}</span>
      </div>
      ${state.adjustment
        ? html`<div class="dto-redecomposing__quote">${state.adjustment}</div>`
        : nothing}
      <div class="dto-redecomposing__hint">${t("taskOrchestrator.redecomposingHint")}</div>
    </div>
  `;
}

function renderConfirmBar(
  progress: TaskOrchestratorProgress,
  opts: {
    onDecision: (decision: TaskOrchestratorDecision, adjustment?: string) => void;
    busy?: boolean;
    error?: string | null;
  },
) {
  if (!isAwaitingConfirmation(progress)) return nothing;
  const busy = opts.busy === true;
  const submitAdjustment = (e: Event) => {
    const root = (e.currentTarget as HTMLElement).closest(".dto-confirm");
    const field = root?.querySelector<HTMLTextAreaElement>(".dto-confirm__input");
    const text = field?.value.trim() ?? "";
    // An empty adjustment would re-run the decomposer with no new information and
    // produce the same plan, so it is not sent.
    if (!text) {
      field?.focus();
      return;
    }
    opts.onDecision("adjust", text);
  };

  return html`
    <div class="dto-confirm">
      <div class="dto-section-label">${t("taskOrchestrator.confirmQuestion")}</div>
      <div class="dto-confirm__hint">${t("taskOrchestrator.confirmHint")}</div>
      <div class="dto-confirm__actions">
        <button
          class="dto-confirm__btn dto-confirm__btn--primary"
          type="button"
          ?disabled=${busy}
          @click=${() => opts.onDecision("confirm")}
        >
          ${t("taskOrchestrator.confirmRun")}
        </button>
        <button
          class="dto-confirm__btn"
          type="button"
          ?disabled=${busy}
          @click=${() => opts.onDecision("cancel")}
        >
          ${t("taskOrchestrator.confirmCancel")}
        </button>
      </div>
      <textarea
        class="dto-confirm__input"
        rows="2"
        placeholder=${t("taskOrchestrator.adjustPlaceholder")}
        ?disabled=${busy}
      ></textarea>
      <div class="dto-confirm__actions">
        <button
          class="dto-confirm__btn"
          type="button"
          ?disabled=${busy}
          @click=${submitAdjustment}
        >
          ${t("taskOrchestrator.adjustSubmit")}
        </button>
      </div>
      ${opts.error ? html`<div class="dto-confirm__error">${opts.error}</div>` : nothing}
    </div>
  `;
}

/**
 * Render the card for `progress`, or nothing when this session has no updates.
 *
 * `expanded`/`onToggleExpanded` are owned by the caller (chat.ts keeps them in
 * the same per-session map the tool cards use), so the collapse state survives a
 * re-render and is scoped to the session like every other card.
 */
export function renderTaskOrchestratorCard(
  progress: TaskOrchestratorProgress | undefined,
  opts: {
    expanded: boolean;
    onToggleExpanded: () => void;
    onDecision: (decision: TaskOrchestratorDecision, adjustment?: string) => void;
    busy?: boolean;
    error?: string | null;
    /**
     * True once this plan's reply is in the flow. The only signal that summarizing
     * ended, since the summary is itself the reply.
     */
    replyLanded?: boolean;
  },
) {
  if (!progress || progress.subtasks.length === 0) {
    return nothing;
  }
  const labels = labelsFor(progress);
  const replyLanded = opts.replyLanded === true;
  // `replyLanded` settles the card as well as the summarizing spinner. Without it, a run
  // that dies between two steps — so the remaining `end` events never arrive — would
  // claim "in progress" indefinitely, next to the reply that already answered it.
  const finished = isFinished(progress) || replyLanded;
  const awaiting = isAwaitingConfirmation(progress);
  const summarizing = progress.summarizing != null && !replyLanded;
  const redecomposing = progress.redecomposing != null;
  const total = totalLayersOf(progress);
  // Re-decomposing outranks the layer labels: no layer has run yet, so any of them
  // would describe the superseded plan. Says "previous plan" rather than repeating the
  // state — the spinner chip on the right already says it is re-decomposing, and
  // printing that twice in one header adds no information.
  const layerLabel = redecomposing
    ? t("taskOrchestrator.headerPrevPlan")
    : awaiting
      ? t("taskOrchestrator.awaiting")
      : total === null
        ? t("taskOrchestrator.headerDecomposed")
        : summarizing
          ? t("taskOrchestrator.headerSummarizing")
          : finished
            ? labels.allUnitsDone(total)
            : labels.unitOf(Math.min(progress.layers.length + 1, total), total);

  return html`
    <div class="dto-card ${opts.expanded ? "dto-card--open" : ""}">
      <button
        class="dto-card__summary"
        type="button"
        aria-expanded=${String(opts.expanded)}
        @click=${() => opts.onToggleExpanded()}
      >
        <span class="dto-card__chevron">▸</span>
        <span class="dto-card__title">${labels.title(progress.pipelineName)}</span>
        <span class="dto-card__count"
          >${labels.count(progress.subtasks.length, layerLabel)}</span
        >
        <span class="dto-card__spacer"></span>
        ${redecomposing
          ? html`<span class="dto-state dto-state--run"
              ><span class="dto-spinner" aria-hidden="true"></span
              >${t("taskOrchestrator.chipRedecomposing")}</span
            >`
          : awaiting
          ? html`<span class="dto-state dto-state--run"
              >${t("taskOrchestrator.awaiting")}</span
            >`
          : // Summarizing is checked before `finished`: every layer has reported by
            // then, so `finished` is true and the header would claim completion while
            // the answer is still minutes away. Also shown collapsed, which is the
            // state a long-running card is most likely to be left in.
            summarizing
            ? html`<span class="dto-state dto-state--run"
                ><span class="dto-spinner" aria-hidden="true"></span
                >${t("taskOrchestrator.headerSummarizing")}</span
              >`
            : finished
              ? nothing
              : html`<span class="dto-state dto-state--run"
                  >${t("taskOrchestrator.inProgress")}</span
                >`}
      </button>
      ${opts.expanded
        ? html`
            <div class="dto-card__body">
              ${
                // While awaiting there are no layers yet, so the timeline would render
                // an empty section above the plan the operator is being asked about.
                // Re-decomposing is the same situation: the gate cleared `awaiting`, but
                // still nothing has executed, so it needs the same guard.
                awaiting || redecomposing ? nothing : renderTimeline(progress, finished, labels)
              }
              ${renderSubtasks(progress, finished, labels)}
              ${renderSummarizing(progress, replyLanded)}
              ${renderRedecomposing(progress)} ${renderConfirmBar(progress, opts)}
            </div>
          `
        : nothing}
    </div>
  `;
}
