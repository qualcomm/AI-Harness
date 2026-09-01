/**
 * Fixed-pipeline editor.
 *
 * Left: the list of pipelines. Right: the selected one's ordered steps. Same two-column
 * shape as the agents page, so it reads as part of the same app.
 *
 * DRAG AND DROP is native HTML5, with up/down buttons alongside. The buttons are not a
 * convenience — HTML5 DnD does not work on touch devices, so they are the only way to
 * reorder there, and the only keyboard-accessible way anywhere.
 *
 * Both routes call the same `moveStep`, but that alone does NOT keep them consistent:
 * they pass it different endpoints, and the drop handler once passed the destination as
 * both, making every drag a no-op. `pipelines.test.ts` compares the two routes through
 * the DOM for that reason.
 */

import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import {
  moveStep,
  newStep,
  type DraftStep,
  type Pipeline,
  type PipelineDraft,
  type PipelinesState,
} from "../controllers/pipelines.ts";

export type PipelinesProps = {
  pipelines: Pipeline[];
  available: boolean | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Confirmation of the last successful write. See `PipelinesState.notice`. */
  notice: PipelinesState["notice"];
  selectedId: string | null;
  draft: PipelineDraft | null;
  dirty: boolean;
  /** Selectable agent ids, already filtered of the orchestrator's internal identities. */
  agentIds: string[];
  /** Index of the row being dragged, or null. Owned by the host so re-renders keep it. */
  draggingIndex: number | null;
  dropTargetIndex: number | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  onSave: () => void;
  onDelete: (id: string) => void;
  onDraftChange: (mutate: (draft: PipelineDraft) => PipelineDraft) => void;
  onDragState: (dragging: number | null, dropTarget: number | null) => void;
};

const MAX_STEPS = 20;

function renderSidebar(props: PipelinesProps) {
  return html`
    <div class="pl-sidebar">
      <div class="pl-sidebar__head">${t("pipelines.title")}</div>
      ${props.pipelines.length === 0 && !props.loading
        ? html`<div class="pl-sidebar__empty">${t("pipelines.empty")}</div>`
        : nothing}
      <div class="pl-sidebar__list">
        ${repeat(
          props.pipelines,
          (p) => p.id,
          (p) => html`
            <button
              class="pl-sidebar__item ${props.selectedId === p.id ? "pl-sidebar__item--active" : ""}"
              type="button"
              @click=${() => props.onSelect(p.id)}
            >
              <span class="pl-sidebar__name">${p.name}</span>
              <span class="pl-sidebar__count"
                >${t("pipelines.stepCount", { count: String(p.steps.length) })}</span
              >
            </button>
          `,
        )}
      </div>
      <button class="pl-btn pl-btn--wide" type="button" @click=${() => props.onNew()}>
        ${t("pipelines.new")}
      </button>
    </div>
  `;
}

/**
 * One step row.
 *
 * `draggable` is on the handle only, not the row: making the whole row draggable breaks
 * text selection inside the instruction textarea, since a drag gesture starting in the
 * text would move the row instead of selecting.
 */
function renderStep(props: PipelinesProps, step: DraftStep, index: number, total: number) {
  const agentMissing = step.agentId !== "" && !props.agentIds.includes(step.agentId);
  const isDragging = props.draggingIndex === index;
  const isDropTarget = props.dropTargetIndex === index && props.draggingIndex !== index;

  const update = (patch: Partial<DraftStep>) =>
    props.onDraftChange((draft) => ({
      ...draft,
      steps: draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));

  /**
   * Reorder, with BOTH endpoints named.
   *
   * Neither is implicit on purpose. The arrow buttons move this row (`from === index`),
   * but the drop handler runs on the row being dropped ONTO, so there `index` is the
   * destination and the source is `draggingIndex`. An earlier version took only `to` and
   * assumed `from === index`, which made every drop a `moveStep(i, i)` no-op.
   */
  const reorder = (from: number, to: number) =>
    props.onDraftChange((draft) => ({ ...draft, steps: moveStep(draft.steps, from, to) }));

  return html`
    <div
      class="pl-step ${isDragging ? "pl-step--dragging" : ""} ${isDropTarget
        ? "pl-step--drop"
        : ""}"
      @dragover=${(e: DragEvent) => {
        // Without preventDefault the drop event never fires at all — the most common
        // way native DnD silently does nothing.
        e.preventDefault();
        if (props.draggingIndex !== null) props.onDragState(props.draggingIndex, index);
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        const from = props.draggingIndex;
        if (from !== null) reorder(from, index);
        props.onDragState(null, null);
      }}
    >
      <div
        class="pl-step__handle"
        draggable="true"
        title=${t("pipelines.dragHint")}
        aria-hidden="true"
        @dragstart=${(e: DragEvent) => {
          // Firefox refuses to start a drag without data set.
          e.dataTransfer?.setData("text/plain", String(index));
          props.onDragState(index, index);
        }}
        @dragend=${() => {
          // Releasing outside the window fires dragend but never drop; without this the
          // row would stay visually stuck in its dragging state.
          props.onDragState(null, null);
        }}
      >
        ⠿
      </div>
      <div class="pl-step__index">${index + 1}</div>
      <div class="pl-step__body">
        <div class="pl-step__row">
          <select
            class="pl-select ${agentMissing ? "pl-select--missing" : ""}"
            .value=${step.agentId}
            @change=${(e: Event) => update({ agentId: (e.target as HTMLSelectElement).value })}
          >
            <option value="" ?selected=${step.agentId === ""}>
              ${t("pipelines.selectAgent")}
            </option>
            ${
              // A deleted agent is kept as an explicit option rather than dropped, so the
              // user can see WHICH agent went missing instead of finding the field blank.
              agentMissing
                ? html`<option value=${step.agentId} selected>
                    ${t("pipelines.agentMissing", { id: step.agentId })}
                  </option>`
                : nothing
            }
            ${props.agentIds.map(
              (id) => html`<option value=${id} ?selected=${id === step.agentId}>${id}</option>`,
            )}
          </select>
          <div class="pl-step__actions">
            <button
              class="pl-icon-btn"
              type="button"
              title=${t("pipelines.moveUp")}
              ?disabled=${index === 0}
              @click=${() => reorder(index, index - 1)}
            >
              ↑
            </button>
            <button
              class="pl-icon-btn"
              type="button"
              title=${t("pipelines.moveDown")}
              ?disabled=${index === total - 1}
              @click=${() => reorder(index, index + 1)}
            >
              ↓
            </button>
            <button
              class="pl-icon-btn pl-icon-btn--danger"
              type="button"
              title=${t("pipelines.removeStep")}
              ?disabled=${total === 1}
              @click=${() =>
                props.onDraftChange((draft) => ({
                  ...draft,
                  steps: draft.steps.filter((_, i) => i !== index),
                }))}
            >
              ✕
            </button>
          </div>
        </div>
        <textarea
          class="pl-textarea"
          rows="2"
          placeholder=${t("pipelines.instructionPlaceholder")}
          .value=${step.instruction}
          @input=${(e: Event) => update({ instruction: (e.target as HTMLTextAreaElement).value })}
        ></textarea>
      </div>
    </div>
  `;
}

/**
 * The unsaved / saved marker.
 *
 * Both share one slot because they are mutually exclusive and describe the same thing —
 * whether what is on screen matches what is stored. `dirty` wins: an edit made after a
 * save must not still read "saved".
 */
function renderStatus(props: PipelinesProps) {
  if (props.dirty) return html`<span class="pl-dirty">${t("pipelines.unsaved")}</span>`;
  if (props.notice === "saved") {
    return html`<span class="pl-saved" role="status">✓ ${t("pipelines.saved")}</span>`;
  }
  return nothing;
}

function renderEditor(props: PipelinesProps) {
  const draft = props.draft;
  if (!draft) {
    return html`
      <div class="pl-editor pl-editor--empty">
        ${props.notice === "deleted"
          ? html`<span class="pl-saved" role="status">✓ ${t("pipelines.deleted")}</span>`
          : nothing}
        <div>
          ${props.pipelines.length === 0 ? t("pipelines.createFirst") : t("pipelines.pickPrompt")}
        </div>
      </div>
    `;
  }
  const total = draft.steps.length;
  return html`
    <div class="pl-editor">
      <div class="pl-editor__head">
        <input
          class="pl-input"
          placeholder=${t("pipelines.namePlaceholder")}
          .value=${draft.name}
          @input=${(e: Event) => {
            const name = (e.target as HTMLInputElement).value;
            props.onDraftChange((d) => ({ ...d, name }));
          }}
        />
        ${renderStatus(props)}
      </div>

      <div class="pl-steps">
        ${repeat(
          draft.steps,
          // Keyed by the browser-only uid, NOT the index: with an index key a reorder
          // makes Lit reuse the wrong nodes and the textareas appear to swap contents.
          (s) => s.uid,
          (s, i) => renderStep(props, s, i, total),
        )}
      </div>

      <div class="pl-editor__foot">
        <button
          class="pl-btn"
          type="button"
          ?disabled=${total >= MAX_STEPS}
          title=${total >= MAX_STEPS ? t("pipelines.maxSteps", { max: String(MAX_STEPS) }) : ""}
          @click=${() => props.onDraftChange((d) => ({ ...d, steps: [...d.steps, newStep()] }))}
        >
          ${t("pipelines.addStep")}
        </button>
        <span class="pl-hint">${t("pipelines.flowHint")}</span>
      </div>

      ${props.error ? html`<div class="pl-error" role="alert">${props.error}</div>` : nothing}

      <div class="pl-editor__buttons">
        <button
          class="pl-btn pl-btn--primary"
          type="button"
          ?disabled=${props.saving || !props.dirty}
          @click=${() => props.onSave()}
        >
          ${props.saving ? t("pipelines.saving") : t("pipelines.save")}
        </button>
        ${draft.id
          ? html`
              <button
                class="pl-btn pl-btn--danger"
                type="button"
                ?disabled=${props.saving}
                @click=${() => props.onDelete(draft.id!)}
              >
                ${t("pipelines.delete")}
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
}

export function renderPipelines(props: PipelinesProps) {
  // `available === false` means the orchestrator plugin is absent or disabled. Saying so
  // is more useful than an empty editor the user cannot make work.
  if (props.available === false) {
    return html`
      <div class="pl-page">
        <div class="pl-unavailable">
          <div class="pl-unavailable__icon">${icons.puzzle}</div>
          <div>
            <strong>${t("pipelines.unavailableTitle")}</strong>
            <p>${t("pipelines.unavailableBody")}</p>
          </div>
        </div>
      </div>
    `;
  }
  return html` <div class="pl-page">${renderSidebar(props)} ${renderEditor(props)}</div> `;
}
