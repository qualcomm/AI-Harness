// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Controller for the Local Models tab (GenieX on-device inference).
 *
 * All data comes from the `geniex.*` gateway methods, which are split across two
 * plugins: `geniex` (the chat provider, lazily loaded when a request needs a
 * GenieX model) and `geniex-manager` (the `geniex serve` process supervisor and
 * the `geniex.*` gateway methods themselves, loaded unconditionally at gateway
 * startup because its manifest declares no provider). See
 * extensions/geniex-manager/README.md for why the split exists.
 *
 * Availability is decided by calling `geniex.status` itself, not by reading the
 * config snapshot: `geniex-manager` ships disabled and auto-enables itself at
 * gateway startup (`registerAutoEnableProbe`), but that auto-enable result is
 * never written back to `openclaw.json` — it is recomputed in memory on every
 * boot. A config-snapshot check (`plugins.entries["geniex-manager"].enabled`)
 * would therefore report "disabled" even while the plugin is actually loaded
 * and its gateway methods work, because the on-disk file never reflects the
 * auto-enable outcome. Calling `geniex.status` and reacting to an
 * "unknown method" error is the only signal that matches gateway reality.
 */
import type { GatewayBrowserClient } from "../gateway.ts";
import { GatewayRequestError } from "../gateway.ts";
import type { ConfigSnapshot } from "../types.ts";

/** Owns per-model compute config; written to `plugins.entries.geniex.config`. */
export const GENIEX_PROVIDER_PLUGIN_ID = "geniex";

/** Mirrors the plugin's serve supervisor state. */
export type GenieXServeState =
  | { status: "inactive"; reason: string }
  | { status: "external" }
  | { status: "starting" }
  | { status: "running"; pid?: number }
  | { status: "failed"; reason: string; restarts: number };

/** Mirrors `geniex.status`; the UI branches on `state`. */
export type GenieXStatus =
  | { state: "unsupported-platform"; platform: string; reason: string }
  | {
      state: "cli-missing";
      platform: string;
      install: { url: string; command?: string; note?: string };
    }
  | {
      state: "ready";
      platform: string;
      cliPath: string;
      version?: string;
      baseUrl: string;
      serve: GenieXServeState;
    }
  /**
   * Client-synthesized, not part of the gateway response: set when
   * `geniex.status` itself does not exist (the `geniex-manager` plugin has not
   * loaded), detected from the RPC's "unknown method" error rather than from
   * config, since auto-enable never persists to `openclaw.json`.
   */
  | { state: "plugin-inactive" };

export type GenieXCachedModel = {
  name: string;
  size: number;
  runtime: string;
  modelType: "llm" | "vlm" | "unknown";
  precisions: string[];
  /** False for NPU-only runtimes, where the compute unit is not a choice. */
  computeSelectable: boolean;
  /** Configured compute unit; "" means Default (GenieX decides, normally NPU). */
  compute?: string;
  /** A hand-written `name:precision` entry overrides the unit set here. */
  computeOverridden?: boolean;
};

export type GenieXAvailableModel = {
  name: string;
  displayName: string;
  id: string;
  modelType: "llm" | "vlm";
  supportedChipsets: string[];
};

export type GenieXChipset = {
  name: string;
  displayName: string;
  aliases: string[];
};

export type GenieXPullJob = {
  id: string;
  model: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  downloadedBytes?: number;
  message?: string;
  error?: string;
};

/** Slice of app state this controller owns. */
export type LocalModelsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  configSnapshot: ConfigSnapshot | null;
  applySessionKey: string;

  localModelsStatus: GenieXStatus | null;
  localModelsStatusLoading: boolean;
  localModelsStatusError: string | null;

  localModelsCached: GenieXCachedModel[];
  localModelsCachedLoading: boolean;
  localModelsCachedError: string | null;

  localModelsAvailable: GenieXAvailableModel[];
  localModelsAvailableLoading: boolean;
  localModelsAvailableError: string | null;
  /** Chipset the available list was filtered by; null when unresolved. */
  localModelsChipset: string | null;
  localModelsChipsets: GenieXChipset[];

  localModelsJobs: GenieXPullJob[];
  /** Ids of succeeded pull jobs already reflected in `localModelsCached`. */
  localModelsRefreshedJobIds: string[];
  /** Ids of failed pull jobs already surfaced in the banner. */
  localModelsFailedJobIds: string[];
  /** False until the first jobs poll has run; suppresses banners for pre-existing jobs. */
  localModelsJobsSeeded: boolean;
  localModelsActionPending: boolean;
  localModelsActionMessage: { kind: "success" | "error"; text: string } | null;
  /** Pending auto-clear timer for a success message; null when none is armed. */
  localModelsMessageTimer: number | null;

  /** Selection/input state for the deploy controls. */
  localModelsSelectedAvailable: string;
  localModelsManualInput: string;
};

function canRequest(state: LocalModelsState): boolean {
  return Boolean(state.client) && state.connected;
}

/**
 * Whether `error` is the gateway's "unknown method" response for a
 * `geniex.*` call — the signal that `geniex-manager` has not loaded, since
 * there is no config-based way to tell (see the module comment).
 */
function isUnknownGenieXGatewayMethodError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    /^unknown method: geniex\./.test(error.message)
  );
}

export async function loadLocalModelsStatus(state: LocalModelsState): Promise<void> {
  if (!canRequest(state) || state.localModelsStatusLoading) {
    return;
  }
  state.localModelsStatusLoading = true;
  state.localModelsStatusError = null;
  try {
    state.localModelsStatus = await state.client!.request<GenieXStatus>("geniex.status", {});
  } catch (err) {
    if (isUnknownGenieXGatewayMethodError(err)) {
      // Not a fetch failure — the RPC reached the gateway and it plainly does
      // not know this method. Render the "not active" explainer instead of a
      // generic error banner.
      state.localModelsStatus = { state: "plugin-inactive" };
    } else {
      state.localModelsStatusError = String(err);
    }
  } finally {
    state.localModelsStatusLoading = false;
  }
}

export async function loadLocalModelsCached(state: LocalModelsState): Promise<void> {
  if (!canRequest(state) || state.localModelsCachedLoading) {
    return;
  }
  state.localModelsCachedLoading = true;
  state.localModelsCachedError = null;
  try {
    const payload = await state.client!.request<{ models?: GenieXCachedModel[] }>(
      "geniex.models.list",
      {},
    );
    state.localModelsCached = payload?.models ?? [];
  } catch (err) {
    state.localModelsCachedError = String(err);
  } finally {
    state.localModelsCachedLoading = false;
  }
}

export async function loadLocalModelsAvailable(
  state: LocalModelsState,
  options?: { allChipsets?: boolean },
): Promise<void> {
  if (!canRequest(state) || state.localModelsAvailableLoading) {
    return;
  }
  state.localModelsAvailableLoading = true;
  state.localModelsAvailableError = null;
  try {
    const payload = await state.client!.request<{
      models?: GenieXAvailableModel[];
      chipset?: string | null;
    }>("geniex.models.available", options?.allChipsets ? { allChipsets: true } : {});
    state.localModelsAvailable = payload?.models ?? [];
    state.localModelsChipset = payload?.chipset ?? null;
  } catch (err) {
    state.localModelsAvailableError = String(err);
  } finally {
    state.localModelsAvailableLoading = false;
  }
}

/**
 * Loads the chipset catalogue for manual selection.
 *
 * Only needed when GenieX could not resolve a chipset: AI Hub assets are built
 * per chipset, and an unresolved one would send `geniex pull` into an interactive
 * picker it can never answer.
 */
export async function loadLocalModelsChipsets(state: LocalModelsState): Promise<void> {
  if (!canRequest(state)) {
    return;
  }
  try {
    const payload = await state.client!.request<{ chipsets?: GenieXChipset[] }>(
      "geniex.chipset.list",
      {},
    );
    state.localModelsChipsets = payload?.chipsets ?? [];
  } catch (err) {
    state.localModelsAvailableError = String(err);
  }
}

export async function loadLocalModelsJobs(state: LocalModelsState): Promise<void> {
  if (!canRequest(state)) {
    return;
  }
  try {
    const payload = await state.client!.request<{ jobs?: GenieXPullJob[] }>(
      "geniex.models.pullJobs",
      {},
    );
    const newJobs = payload?.jobs ?? [];
    state.localModelsJobs = newJobs;

    // `succeeded` is a persistent status, not an event: the gateway keeps
    // reporting completed jobs, so acting on every sighting would re-issue
    // `geniex.models.list` on each poll tick — flipping
    // `localModelsCachedLoading` back and forth and making loading-bound
    // controls flicker — and would re-raise the same banner forever. Act only
    // on jobs that completed since the last tick.
    const succeeded = newJobs.filter((job) => job.status === "succeeded");
    const newlySucceeded = succeeded.filter(
      (job) => !state.localModelsRefreshedJobIds.includes(job.id),
    );
    // Reassigning also drops ids the gateway no longer reports, so the list
    // cannot grow without bound.
    state.localModelsRefreshedJobIds = succeeded.map((job) => job.id);

    // The first poll of a fresh page sees every historical job as "new"; seed
    // the id list silently so the user is not told about downloads they did
    // not just start.
    const seeded = state.localModelsJobsSeeded;
    state.localModelsJobsSeeded = true;

    // `failed` is persistent for the same reason `succeeded` is, so raise the
    // banner only for jobs that failed since the last tick — otherwise the same
    // error comes straight back after the user closes it.
    const failedJobs = newJobs.filter((job) => job.status === "failed" && job.error?.trim());
    const newlyFailed = failedJobs.filter(
      (job) => !state.localModelsFailedJobIds.includes(job.id),
    );
    state.localModelsFailedJobIds = failedJobs.map((job) => job.id);
    if (newlyFailed.length > 0 && seeded) {
      setLocalModelsActionMessage(state, { kind: "error", text: newlyFailed[0].error! });
    }

    if (newlySucceeded.length > 0 && seeded) {
      // Refresh first: `geniex.models.list` reports the final on-disk size, and
      // doing it before the banner keeps the success message's lifetime from
      // being eaten by the request.
      await loadLocalModelsCached(state);
      setLocalModelsActionMessage(state, {
        kind: "success",
        text:
          newlySucceeded.length === 1
            ? `Downloaded ${newlySucceeded[0].model}.`
            : `Downloaded ${newlySucceeded.length} models.`,
      });
    } else if (newlySucceeded.length > 0) {
      await loadLocalModelsCached(state);
    }
  } catch (err) {
    // Job polling is cosmetic; a failure here must not replace the page with an
    // error when the rest of the data is fine. Log it, though — a silently
    // failing poll leaves running jobs frozen on screen with no explanation.
    console.warn("geniex.models.pullJobs polling failed", err);
  }
}

/** Loads everything the tab needs. */
export async function loadLocalModels(state: LocalModelsState): Promise<void> {
  await loadLocalModelsStatus(state);
  if (state.localModelsStatus?.state !== "ready") {
    return;
  }
  await Promise.all([
    loadLocalModelsCached(state),
    loadLocalModelsAvailable(state),
    loadLocalModelsJobs(state),
  ]);
  if (!state.localModelsChipset) {
    await loadLocalModelsChipsets(state);
  }
}

/** Success banners are transient feedback; errors stay until the next action. */
const LOCAL_MODELS_SUCCESS_MESSAGE_TTL_MS = 5000;

/**
 * Single writer for the action banner.
 *
 * Always cancels any armed auto-clear first, so a new message cannot be wiped
 * by the previous one's timer, and arms a fresh timer only for success.
 */
function setLocalModelsActionMessage(
  state: LocalModelsState,
  message: { kind: "success" | "error"; text: string } | null,
): void {
  if (state.localModelsMessageTimer !== null) {
    clearTimeout(state.localModelsMessageTimer);
    state.localModelsMessageTimer = null;
  }
  state.localModelsActionMessage = message;
  if (message?.kind === "success") {
    state.localModelsMessageTimer = setTimeout(() => {
      state.localModelsActionMessage = null;
      state.localModelsMessageTimer = null;
    }, LOCAL_MODELS_SUCCESS_MESSAGE_TTL_MS) as unknown as number;
  }
}

async function runAction(
  state: LocalModelsState,
  action: () => Promise<string>,
): Promise<void> {
  if (!canRequest(state) || state.localModelsActionPending) {
    return;
  }
  state.localModelsActionPending = true;
  setLocalModelsActionMessage(state, null);
  try {
    setLocalModelsActionMessage(state, { kind: "success", text: await action() });
  } catch (err) {
    setLocalModelsActionMessage(state, { kind: "error", text: String(err) });
  } finally {
    state.localModelsActionPending = false;
  }
}

export async function startLocalModelPull(
  state: LocalModelsState,
  model: string,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) {
    return;
  }
  await runAction(state, async () => {
    await state.client!.request("geniex.models.pull", { model: trimmed });
    return `Downloading ${trimmed}…`;
  });
  // Deliberately outside `runAction`: `geniex.models.pull` only queues the job
  // and returns, so a download that fails immediately surfaces through the jobs
  // poll. Running it inside the action would let the returned "Downloading …"
  // string overwrite the error banner this call just set.
  await loadLocalModelsJobs(state);
}

/**
 * Resumes a paused download.
 *
 * Pausing keeps GenieX's partial file, so pulling the same model again continues
 * from it. That starts a *new* job, so the paused record is dropped only after
 * the pull is accepted: if starting fails (e.g. the CLI vanished) the record
 * stays and the user can try again.
 */
export async function resumeLocalModelPull(state: LocalModelsState, jobId: string): Promise<void> {
  const paused = state.localModelsJobs.find((job) => job.id === jobId);
  if (!paused || paused.status !== "cancelled") {
    return;
  }
  await runAction(state, async () => {
    await state.client!.request("geniex.models.pull", { model: paused.model });
    const payload = await state.client!.request<{ jobs?: GenieXPullJob[] }>(
      "geniex.models.pullForget",
      { jobId },
    );
    state.localModelsJobs = payload?.jobs ?? [];
    return `Resuming ${paused.model}…`;
  });
  // Outside `runAction`, like `startLocalModelPull`: the new job shows up via the
  // jobs poll, and a pull that fails immediately must not be overwritten by the
  // "Resuming" message above.
  await loadLocalModelsJobs(state);
}

export async function pauseLocalModelPull(state: LocalModelsState, jobId: string): Promise<void> {
  await runAction(state, async () => {
    await state.client!.request("geniex.models.pullCancel", { jobId });
    await loadLocalModelsJobs(state);
    // Wording matters: GenieX keeps the partial file and the next pull resumes
    // from it, so this is a pause rather than a discard.
    return "Download paused. Progress is kept; downloading again resumes it.";
  });
}

/**
 * Deletes a finished pull job from the gateway's job table.
 *
 * Hiding it client-side was not enough: `geniex.models.pullJobs` reports every
 * retained job — the manager keeps terminal ones for `COMPLETED_JOB_TTL_MS` —
 * so anything short of removing it there reappears on the next page load. The
 * gateway rejects running jobs, which own a live child process.
 */
export async function forgetLocalModelPullJob(
  state: LocalModelsState,
  jobId: string,
): Promise<void> {
  await runAction(state, async () => {
    const payload = await state.client!.request<{ jobs?: GenieXPullJob[] }>(
      "geniex.models.pullForget",
      { jobId },
    );
    state.localModelsJobs = payload?.jobs ?? [];
    // The gateway will never report this id again, so the banner-dedupe list
    // has nothing left to track for it.
    state.localModelsFailedJobIds = state.localModelsFailedJobIds.filter((id) => id !== jobId);
    return "Download record removed.";
  });
}

/** Closes the action banner; error messages have no auto-clear timer. */
export function clearLocalModelsActionMessage(state: LocalModelsState): void {
  setLocalModelsActionMessage(state, null);
}

export async function removeLocalModel(state: LocalModelsState, name: string): Promise<void> {
  await runAction(state, async () => {
    const payload = await state.client!.request<{ models?: GenieXCachedModel[] }>(
      "geniex.models.remove",
      { name },
    );
    state.localModelsCached = payload?.models ?? [];
    return `Removed ${name}.`;
  });
}

/** Sets a model's compute unit ("" = Default); applies from its next request. */
export async function setLocalModelCompute(
  state: LocalModelsState,
  name: string,
  compute: string,
): Promise<void> {
  await runAction(state, async () => {
    const payload = await state.client!.request<{ models?: GenieXCachedModel[] }>(
      "geniex.models.setCompute",
      { name, compute },
    );
    state.localModelsCached = payload?.models ?? [];
    return compute
      ? `${name} will run on ${compute.toUpperCase()} from its next request.`
      : `${name} will use the default compute unit from its next request.`;
  });
}

export async function setLocalModelsChipset(
  state: LocalModelsState,
  chipset: string,
): Promise<void> {
  await runAction(state, async () => {
    const payload = await state.client!.request<{ chipset?: string | null }>("geniex.chipset.set", {
      chipset,
    });
    state.localModelsChipset = payload?.chipset ?? null;
    await loadLocalModelsAvailable(state);
    return `Chipset set to ${chipset}.`;
  });
}

async function runServeAction(state: LocalModelsState, method: string, label: string) {
  await runAction(state, async () => {
    await state.client!.request(method, {});
    await loadLocalModelsStatus(state);
    return label;
  });
}

export async function startLocalModelsServe(state: LocalModelsState): Promise<void> {
  await runServeAction(state, "geniex.serve.start", "Inference server started.");
}

export async function stopLocalModelsServe(state: LocalModelsState): Promise<void> {
  await runServeAction(state, "geniex.serve.stop", "Inference server stopped.");
}

export async function restartLocalModelsServe(state: LocalModelsState): Promise<void> {
  await runServeAction(state, "geniex.serve.restart", "Inference server restarted.");
}

/** Running download for a model, if any. */
export function findJobForModel(
  jobs: readonly GenieXPullJob[],
  modelName: string,
): GenieXPullJob | undefined {
  return jobs.find((job) => job.status === "running" && job.model.startsWith(modelName));
}

/** Formats bytes for display; GenieX reports IEC units, so match it. */
export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "—";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}
