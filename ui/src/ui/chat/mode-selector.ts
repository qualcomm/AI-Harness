/**
 * Orchestration mode selector for the chat toolbar.
 *
 * Replaced a boolean button when a third option (fixed pipelines) arrived: with N+2
 * possible states, colour alone cannot say which one is active, so the current mode is
 * spelled out on the trigger.
 *
 * Extracted from views/chat.ts because a dropdown with per-pipeline entries is more
 * markup than belongs inline in a toolbar.
 */

import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

export type ChatSessionMode =
  | { kind: "off" }
  | { kind: "dynamic" }
  | { kind: "pipeline"; pipelineId: string };

export type ModeSelectorProps = {
  /**
   * Current mode, or null when the orchestrator plugin is unavailable — in which case
   * nothing renders at all. A dead control is worse than no control.
   */
  mode: ChatSessionMode | null;
  pipelines: Array<{ id: string; name: string }>;
  busy: boolean;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onSelect: (mode: ChatSessionMode) => void;
  /** Navigate to the pipelines page, so the edit and use surfaces are connected. */
  onManagePipelines: () => void;
};

function labelFor(props: ModeSelectorProps): string {
  const mode = props.mode;
  if (!mode || mode.kind === "off") return t("chatMode.off");
  if (mode.kind === "dynamic") return t("chatMode.dynamic");
  const found = props.pipelines.find((p) => p.id === mode.pipelineId);
  // A selected-but-missing pipeline is stated rather than hidden: the session still
  // points at it, and the plugin will pass the turn through until it is changed.
  return found ? found.name : t("chatMode.pipelineMissing");
}

function renderOption(params: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return html`
    <button
      class="chat-mode__option ${params.active ? "chat-mode__option--active" : ""}"
      type="button"
      role="menuitemradio"
      aria-checked=${params.active ? "true" : "false"}
      ?disabled=${params.disabled === true}
      @click=${() => params.onSelect()}
    >
      <span class="chat-mode__radio">${params.active ? "●" : "○"}</span>
      <span class="chat-mode__label">${params.label}</span>
    </button>
  `;
}

export function renderModeSelector(props: ModeSelectorProps) {
  if (props.mode === null) {
    return nothing;
  }
  const mode = props.mode;
  const active = mode.kind !== "off";

  return html`
    <div class="chat-mode">
      <button
        class="btn btn--ghost chat-mode__trigger${active ? " chat-mode__trigger--active" : ""}"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${props.open ? "true" : "false"}
        ?disabled=${props.busy}
        title=${t("chatMode.trigger", { mode: labelFor(props) })}
        @click=${() => props.onToggleOpen(!props.open)}
      >
        ${icons.spark}
        <span class="chat-mode__current">${labelFor(props)}</span>
      </button>
      ${props.open
        ? html`
            <div class="chat-mode__menu" role="menu">
              ${renderOption({
                label: t("chatMode.off"),
                active: mode.kind === "off",
                onSelect: () => props.onSelect({ kind: "off" }),
              })}
              ${renderOption({
                label: t("chatMode.dynamic"),
                active: mode.kind === "dynamic",
                onSelect: () => props.onSelect({ kind: "dynamic" }),
              })}
              <div class="chat-mode__sep"></div>
              ${props.pipelines.length === 0
                ? html`<div class="chat-mode__empty">${t("chatMode.noPipelines")}</div>`
                : props.pipelines.map((p) =>
                    renderOption({
                      label: t("chatMode.pipelineOption", { name: p.name }),
                      active: mode.kind === "pipeline" && mode.pipelineId === p.id,
                      onSelect: () => props.onSelect({ kind: "pipeline", pipelineId: p.id }),
                    }),
                  )}
              <div class="chat-mode__sep"></div>
              <button
                class="chat-mode__option chat-mode__option--manage"
                type="button"
                role="menuitem"
                @click=${() => props.onManagePipelines()}
              >
                <span class="chat-mode__radio">⚙</span>
                <span class="chat-mode__label">${t("chatMode.manage")}</span>
              </button>
            </div>
          `
        : nothing}
    </div>
  `;
}
