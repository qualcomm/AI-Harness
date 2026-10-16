// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Local Models tab — download and configure on-device models via GenieX.
 *
 * The page has four distinct shapes, and which one renders is decided entirely by
 * `geniex.status` (or the client-synthesized `plugin-inactive` state, set when
 * that method itself does not exist yet — see the controller's module comment
 * for why this cannot be decided from config):
 *
 * - `plugin-inactive` → a short explainer (the plugin ships off and auto-enables
 *   only on Snapdragon hosts with the CLI installed)
 * - `unsupported-platform` → say so plainly; GenieX only runs on Snapdragon
 * - `cli-missing` → install guidance
 * - `ready` → the real management UI, which itself has an empty state because a
 *   fresh install legitimately has zero models
 */
import { html, nothing } from "lit";
import type {
  GenieXAvailableModel,
  GenieXCachedModel,
  GenieXChipset,
  GenieXPullJob,
  GenieXStatus,
} from "../controllers/local-models.ts";
import { findJobForModel, formatModelSize } from "../controllers/local-models.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { icons } from "../icons.ts";
import "../components/download-status.ts";

export type LocalModelsProps = {
  status: GenieXStatus | null;
  statusLoading: boolean;
  statusError: string | null;

  cached: GenieXCachedModel[];
  cachedLoading: boolean;
  cachedError: string | null;

  available: GenieXAvailableModel[];
  availableLoading: boolean;
  availableError: string | null;
  chipset: string | null;
  chipsets: GenieXChipset[];

  jobs: GenieXPullJob[];
  actionPending: boolean;
  actionMessage: { kind: "success" | "error"; text: string } | null;

  selectedAvailable: string;
  manualInput: string;
  /** Compute unit configured per model name, "" when unset. */
  computeByModel: (modelName: string) => string;

  onRefresh: () => void;
  onSelectedAvailableChange: (value: string) => void;
  onManualInputChange: (value: string) => void;
  onPull: (model: string) => void;
  onPausePull: (jobId: string) => void;
  onResumePull: (jobId: string) => void;
  /** Deletes a finished pull job on the gateway; the record is gone for good. */
  onForgetJob: (jobId: string) => void;
  /** Closes the action banner; error messages have no auto-clear timer. */
  onDismissMessage: () => void;
  onRemove: (name: string) => void;
  onComputeChange: (model: string, compute: string) => void;
  onChipsetChange: (chipset: string) => void;
  onServeStart: () => void;
  onServeStop: () => void;
  onServeRestart: () => void;
};

/**
 * Close affordance shared by the banner and failed download rows.
 *
 * `disabled` is opt-in: closing the banner is a local state change and must
 * never be blocked, but removing a job record is an RPC and has to respect
 * `actionPending` like every other write.
 */
function renderDismissButton(label: string, onClick: () => void, disabled = false) {
  return html`
    <button
      class="btn btn--xs local-models__dismiss"
      title=${label}
      aria-label=${label}
      ?disabled=${disabled}
      @click=${onClick}
    >
      ✕
    </button>
  `;
}

function renderActionMessage(props: LocalModelsProps) {
  if (!props.actionMessage) {
    return nothing;
  }
  return html`
    <div
      class="local-models__callout ${props.actionMessage.kind === "error"
        ? "local-models__callout--error"
        : ""}"
    >
      <span class="local-models__callout-icon"
        >${props.actionMessage.kind === "error" ? "⚠" : "ⓘ"}</span
      >
      <span>${props.actionMessage.text}</span>
      <span class="local-models__spacer"></span>
      ${renderDismissButton("Dismiss message", props.onDismissMessage)}
    </div>
  `;
}

function renderDisabled() {
  return html`
    <section class="local-models">
      <div class="card">
        <div class="local-models__empty">
          <div class="local-models__empty-title">Local model inference is not active</div>
          <p class="local-models__empty-text">
            On-device inference runs through GenieX, Qualcomm's on-device runtime, managed by the
            <code>geniex-manager</code> plugin. It ships disabled and enables itself automatically
            on Snapdragon devices with the GenieX CLI installed — check
            <code>openclaw plugins list</code> for its current state.
          </p>
          <p class="local-models__empty-text">
            To enable it manually, run <code>openclaw plugins enable geniex-manager</code> and
            restart the gateway.
          </p>
        </div>
      </div>
    </section>
  `;
}

function renderUnsupported(status: Extract<GenieXStatus, { state: "unsupported-platform" }>) {
  return html`
    <section class="local-models">
      <div class="card">
        <div class="local-models__empty">
          <div class="local-models__empty-title">Not available on this device</div>
          <p class="local-models__empty-text">${status.reason}</p>
          <div class="local-models__meta">Detected: ${status.platform}</div>
        </div>
      </div>
    </section>
  `;
}

function renderCliMissing(
  status: Extract<GenieXStatus, { state: "cli-missing" }>,
  props: LocalModelsProps,
) {
  return html`
    <section class="local-models">
      <div class="card">
        <div class="local-models__empty">
          <div class="local-models__empty-title">Local model inference needs GenieX</div>
          <p class="local-models__empty-text">
            GenieX is Qualcomm's on-device inference runtime. It runs models on the Hexagon NPU,
            Adreno GPU, or CPU — your data never leaves this machine.
          </p>

          <div class="row" style="justify-content: center; margin-bottom: 14px">
            <span class="pill local-models__status-pill--running">
              <span class="local-models__status-dot"></span>
              ${status.platform} · supported
            </span>
          </div>

          <div class="local-models__url">${status.install.url}</div>

          ${status.install.command
            ? html`<div class="local-models__url">${status.install.command}</div>`
            : nothing}

          <div class="row" style="justify-content: center">
            <a
              class="btn primary"
              href=${status.install.url}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              title="GenieX downloads (opens in new tab)"
            >
              ${icons.externalLink} Open download page
            </a>
            <button class="btn" ?disabled=${props.statusLoading} @click=${props.onRefresh}>
              ${icons.refresh} Check again
            </button>
          </div>

          ${status.install.note
            ? html`
                <div class="local-models__callout" style="max-width: 560px; margin-inline: auto">
                  <span class="local-models__callout-icon">ⓘ</span>
                  <span>${status.install.note}</span>
                </div>
              `
            : nothing}
        </div>
      </div>
    </section>
  `;
}

function renderServeStatus(
  status: Extract<GenieXStatus, { state: "ready" }>,
  props: LocalModelsProps,
) {
  const serve = status.serve;
  const running = serve.status === "running" || serve.status === "external";
  const label =
    serve.status === "running"
      ? "Inference server running"
      : serve.status === "external"
        ? "Using an externally managed server"
        : serve.status === "starting"
          ? "Starting inference server…"
          : serve.status === "failed"
            ? `Inference server stopped: ${serve.reason}`
            : `Inference server not running: ${serve.reason}`;

  return html`
    <div class="card">
      <div class="local-models__status">
        <span
          class="pill ${running
            ? "local-models__status-pill--running"
            : "local-models__status-pill--stopped"}"
        >
          <span class="local-models__status-dot"></span>${label}
        </span>
        <span class="local-models__meta">
          GenieX${status.version ? ` v${status.version}` : ""} · ${status.baseUrl}
        </span>
        ${props.chipset
          ? html`<span class="local-models__meta">·</span>
              <span class="local-models__meta">${props.chipset}</span>`
          : nothing}
        <span class="local-models__spacer"></span>
        ${running
          ? html`
              <button
                class="btn btn--sm"
                ?disabled=${props.actionPending}
                @click=${props.onServeRestart}
              >
                Restart
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${props.actionPending}
                @click=${props.onServeStop}
              >
                Stop
              </button>
            `
          : html`
              <button
                class="btn btn--sm primary"
                ?disabled=${props.actionPending}
                @click=${props.onServeStart}
              >
                Start
              </button>
            `}
      </div>
    </div>
  `;
}

function renderRuntimeBadge(runtime: string) {
  const variant =
    runtime === "qairt"
      ? "local-models__runtime--qairt"
      : runtime === "llama_cpp"
        ? "local-models__runtime--llama"
        : "data-table-badge--unknown";
  return html`<span class="data-table-badge local-models__runtime ${variant}">${runtime}</span>`;
}

function renderDownloadStatus(job: GenieXPullJob) {
  return html`
    <download-status
      status=${job.status}
      startedAt=${job.startedAt}
      error=${job.error ?? job.message ?? ""}
    ></download-status>
  `;
}

/** Units offered for llama_cpp models. "" is Default: nothing is sent, GenieX decides. */
const COMPUTE_OPTIONS = [
  { value: "", label: "Default" },
  { value: "npu", label: "NPU" },
  { value: "gpu", label: "GPU" },
  { value: "cpu", label: "CPU" },
] as const;

function renderComputeCell(model: GenieXCachedModel, props: LocalModelsProps) {
  // Static text rather than a disabled dropdown: most models on a Snapdragon
  // host are qairt, and a column of dead controls reads as broken.
  if (!model.computeSelectable) {
    return html`<span class="local-models__meta">NPU (fixed)</span>`;
  }
  const current = props.computeByModel(model.name);
  return html`
    <select
      class="local-models__compute-select"
      .value=${current}
      ?disabled=${props.actionPending}
      title="Applies from this model's next request; the model is reloaded once."
      @change=${(event: Event) =>
        props.onComputeChange(model.name, (event.target as HTMLSelectElement).value)}
    >
      ${COMPUTE_OPTIONS.map(
        (option) =>
          html`<option value=${option.value} ?selected=${option.value === current}>
            ${option.label}
          </option>`,
      )}
    </select>
    ${model.computeOverridden
      ? html`<div class="local-models__meta">
          A name:precision entry in the config overrides this.
        </div>`
      : nothing}
  `;
}

function renderCachedModels(props: LocalModelsProps) {
  if (props.cachedError) {
    return html`<div class="local-models__callout local-models__callout--error">
      <span class="local-models__callout-icon">⚠</span>
      <span>${props.cachedError}</span>
    </div>`;
  }
  if (props.cached.length === 0) {
    return html`
      <div class="local-models__empty">
        <div class="local-models__empty-title">No local models yet</div>
        <p class="local-models__empty-text">
          The inference server is ready. Download any model below to start using it — no restart
          needed.
        </p>
      </div>
    `;
  }

  return html`
    <div class="data-table-wrapper">
      <div class="data-table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Precision</th>
              <th>Type</th>
              <th>Runtime</th>
              <th>Compute unit</th>
              <th style="text-align: right">Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${props.cached.map((model) => {
              const job = findJobForModel(props.jobs, model.name);
              return html`
                <tr>
                  <td class="local-models__name">${model.name}</td>
                  <td>
                    ${model.precisions.length > 0
                      ? model.precisions.map(
                          (precision) =>
                            html`<span class="data-table-badge data-table-badge--unknown"
                              >${precision}</span
                            >`,
                        )
                      : html`<span class="local-models__meta">—</span>`}
                  </td>
                  <td>
                    <span
                      class="data-table-badge ${model.modelType === "vlm"
                        ? "data-table-badge--group"
                        : "data-table-badge--unknown"}"
                      >${model.modelType.toUpperCase()}</span
                    >
                  </td>
                  <td>${renderRuntimeBadge(model.runtime)}</td>
                  <td>${renderComputeCell(model, props)}</td>
                  <td class="local-models__size">${formatModelSize(model.size)}</td>
                  <td>
                    ${job
                      ? renderDownloadStatus(job)
                      : html`<button
                          class="btn btn--xs danger"
                          ?disabled=${props.actionPending}
                          @click=${() => props.onRemove(model.name)}
                        >
                          ${icons.trash} Remove
                        </button>`}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderJobs(props: LocalModelsProps) {
  const running = props.jobs.filter((job) => job.status === "running");
  const failed = props.jobs.filter((job) => job.status === "failed");
  // A paused download has no running process, but its partial file is kept.
  // Without a row here it would vanish from the UI the moment it is paused.
  const paused = props.jobs.filter((job) => job.status === "cancelled");
  // Bail only when there is nothing of any kind: an early return keyed on
  // `running` alone would hide every failed download — and with it the only
  // place the real pull error is shown.
  if (running.length === 0 && failed.length === 0 && paused.length === 0) {
    return nothing;
  }
  return html`
    ${running.map(
      (job) => html`
        <div class="local-models__progress">
          <div class="local-models__progress-head">
            <span class="local-models__name">${job.model}</span>
            <span class="local-models__spacer"></span>
            ${renderDownloadStatus(job)}
            <button
              class="btn btn--xs"
              ?disabled=${props.actionPending}
              title="Pause this download. Progress is kept."
              @click=${() => props.onPausePull(job.id)}
            >
              ${icons.stop} Pause
            </button>
          </div>
          <div class="local-models__meta">
            Pausing keeps the partial download; Resume resumes from where it stopped.
          </div>
        </div>
      `,
    )}
    ${paused.map(
      (job) => html`
        <div class="local-models__progress">
          <div class="local-models__progress-head">
            <span class="local-models__name">${job.model}</span>
            <span class="local-models__spacer"></span>
            ${renderDownloadStatus(job)}
            <button
              class="btn btn--xs primary"
              ?disabled=${props.actionPending}
              title="Continue this download from where it stopped."
              @click=${() => props.onResumePull(job.id)}
            >
              ${icons.refresh} Resume
            </button>
            ${renderDismissButton(
              "Remove paused download",
              () => props.onForgetJob(job.id),
              props.actionPending,
            )}
          </div>
          <div class="local-models__meta">
            Progress is kept. Resume continues from the partial download.
          </div>
        </div>
      `,
    )}
    ${failed.map(
      (job) => html`
        <div class="local-models__progress local-models__progress--failed">
          <div class="local-models__progress-head">
            <span class="local-models__name">${job.model}</span>
            <span class="local-models__spacer"></span>
            ${renderDownloadStatus(job)}
            <button
              class="btn btn--xs"
              ?disabled=${props.actionPending}
              @click=${() => props.onPull(job.model)}
            >
              ${icons.refresh} Retry
            </button>
            ${renderDismissButton(
              "Remove failed download",
              () => props.onForgetJob(job.id),
              props.actionPending,
            )}
          </div>
        </div>
      `,
    )}
  `;
}

function renderChipsetPicker(props: LocalModelsProps) {
  return html`
    <div class="card">
      <div class="card-title">Select your chipset</div>
      <div class="card-sub">
        Your chipset could not be detected, so compatible models cannot be listed. AI Hub packages
        are built per chipset, so this must be set before downloading.
      </div>
      <div class="local-models__deploy" style="margin-top: 14px">
        <label class="field full">
          <select
            ?disabled=${props.actionPending || props.chipsets.length === 0}
            @change=${(event: Event) =>
              props.onChipsetChange((event.target as HTMLSelectElement).value)}
          >
            <option value="">Choose a chipset…</option>
            ${props.chipsets.map(
              (chipset) => html`<option value=${chipset.name}>${chipset.displayName}</option>`,
            )}
          </select>
        </label>
      </div>
    </div>
  `;
}

function renderDeploy(props: LocalModelsProps) {
  const downloadedNames = new Set(props.cached.map((model) => model.name));
  return html`
    <div class="card">
      <div class="card-title">Deploy a new model</div>
      <div class="card-sub">
        Pick a pre-compiled model from Qualcomm AI Hub, or enter a GGUF model from Hugging Face or
        ModelScope.
      </div>

      <div class="local-models__deploy" style="margin-top: 16px">
        <label class="field full">
          <span>
            Qualcomm AI Hub
            ${props.chipset ? html`· compatible with ${props.chipset}` : nothing}
            ${props.available.length > 0 ? html`(${props.available.length})` : nothing}
          </span>
          <select
            ?disabled=${props.availableLoading || props.available.length === 0}
            @change=${(event: Event) =>
              props.onSelectedAvailableChange((event.target as HTMLSelectElement).value)}
          >
            <option value="">
              ${props.availableLoading ? "Loading…" : "Choose a model…"}
            </option>
            ${props.available.map((model) => {
              const downloaded = downloadedNames.has(model.name);
              return html`<option
                value=${model.name}
                ?disabled=${downloaded}
                ?selected=${model.name === props.selectedAvailable}
              >
                ${model.displayName} — ${model.modelType.toUpperCase()}${downloaded
                  ? " (downloaded)"
                  : ""}
              </option>`;
            })}
          </select>
        </label>
        <button
          class="btn primary"
          ?disabled=${props.actionPending || !props.selectedAvailable}
          @click=${() => props.onPull(props.selectedAvailable)}
        >
          ${icons.download} Download
        </button>
      </div>

      ${props.availableError
        ? html`<div class="local-models__callout local-models__callout--error">
            <span class="local-models__callout-icon">⚠</span>
            <span>${props.availableError}</span>
          </div>`
        : nothing}

      <div class="local-models__divider"></div>

      <div class="local-models__deploy">
        <label class="field full">
          <span>Hugging Face / ModelScope (GGUF)</span>
          <input
            type="text"
            placeholder="org/repo[:precision], or paste a model page URL"
            .value=${props.manualInput}
            @input=${(event: Event) =>
              props.onManualInputChange((event.target as HTMLInputElement).value)}
          />
        </label>
        <button
          class="btn"
          ?disabled=${props.actionPending || !props.manualInput.trim()}
          @click=${() => props.onPull(props.manualInput)}
        >
          ${icons.download} Download
        </button>
      </div>

      ${renderJobs(props)}
    </div>
  `;
}

function renderReady(status: Extract<GenieXStatus, { state: "ready" }>, props: LocalModelsProps) {
  return html`
    <section class="local-models">
      ${renderServeStatus(status, props)} ${renderActionMessage(props)}

      <div class="card">
        <div class="row" style="justify-content: space-between; margin-bottom: 14px">
          <div>
            <div class="card-title">Downloaded models</div>
            <div class="card-sub">
              The runtime decides which compute units a model can use: qairt packages run on the NPU
              only, while llama.cpp GGUF models can use CPU, GPU, or NPU. Changes apply when the
              model is next loaded.
            </div>
          </div>
          <button class="btn" ?disabled=${props.cachedLoading} @click=${props.onRefresh}>
            ${icons.refresh} Refresh
          </button>
        </div>
        ${renderCachedModels(props)}
      </div>

      ${props.chipset ? nothing : renderChipsetPicker(props)} ${renderDeploy(props)}
    </section>
  `;
}

function renderLocalModelsInner(props: LocalModelsProps) {
  if (props.statusError) {
    return html`
      <section class="local-models">
        <div class="card">
          <div class="local-models__empty">
            <div class="local-models__empty-title">Could not read GenieX status</div>
            <p class="local-models__empty-text">${props.statusError}</p>
            <button class="btn" ?disabled=${props.statusLoading} @click=${props.onRefresh}>
              ${icons.refresh} Retry
            </button>
          </div>
        </div>
      </section>
    `;
  }
  if (!props.status) {
    return html`
      <section class="local-models">
        <div class="card">
          <div class="local-models__empty">
            <div class="local-models__empty-text">
              ${props.statusLoading ? "Checking GenieX…" : "No status available."}
            </div>
          </div>
        </div>
      </section>
    `;
  }
  if (props.status.state === "plugin-inactive") {
    return renderDisabled();
  }
  if (props.status.state === "unsupported-platform") {
    return renderUnsupported(props.status);
  }
  if (props.status.state === "cli-missing") {
    return renderCliMissing(props.status, props);
  }
  return renderReady(props.status, props);
}

/**
 * Error boundary around the whole tab.
 *
 * lit evaluates every interpolation while building the template, so a throw
 * anywhere below aborts the render before a single DOM update is committed —
 * the page silently freezes on its last good frame with no console-free clue
 * that anything is wrong. Degrade to a visible message instead.
 */
export function renderLocalModels(props: LocalModelsProps) {
  try {
    return renderLocalModelsInner(props);
  } catch (err) {
    console.error("Local Models render failed", err);
    return html`
      <section class="local-models">
        <div class="card">
          <div class="local-models__callout local-models__callout--error">
            <span class="local-models__callout-icon">⚠</span>
            <span>Failed to render this tab: ${String(err)}</span>
          </div>
        </div>
      </section>
    `;
  }
}
