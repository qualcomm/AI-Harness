// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tracks `geniex pull` downloads as long-running jobs.
 *
 * Downloads run to many gigabytes and take minutes, so a pull cannot be a
 * synchronous RPC: the method returns a job id and the UI polls for progress.
 *
 * **Progress does not come from stdout.** GenieX renders it with
 * `schollz/progressbar` configured for `OptionUseANSICodes(true)` and
 * `OptionFullWidth()` writing to stderr (GenieX
 * `cli/internal/render/progressbar.go`) — a same-line ANSI redraw sized to the
 * terminal, and we spawn without a TTY. That output is a human UI, not a
 * contract, and its format belongs to a third-party library. Instead, progress is
 * derived by polling `geniex list --format json`, whose schema *is* documented as
 * stable, for the model's growing on-disk size.
 *
 * Cancellation means **pause**: GenieX keeps partial downloads and resumes on the
 * next pull ("progress is saved, not discarded"), so the UI must not present it
 * as discarding work.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { resolveGenieXCliPath } from "./cli.js";
import { isValidGenieXModelName, listGenieXCachedModels } from "./model-store.js";

export type GenieXPullStatus = "running" | "succeeded" | "failed" | "cancelled";

export type GenieXPullJob = {
  id: string;
  /** Model reference as requested, e.g. `qualcomm/Qwen3-4B` or `org/repo:Q4_0`. */
  model: string;
  status: GenieXPullStatus;
  startedAt: number;
  endedAt?: number;
  /** Bytes on disk for this model, from the size poll. */
  downloadedBytes?: number;
  /** Tail of CLI output; the useful signal is GenieX's own summary lines. */
  message?: string;
  error?: string;
};

/** How often to re-read on-disk size while a pull runs. */
const PROGRESS_POLL_INTERVAL_MS = 3_000;

/** Finished jobs are kept this long so the UI can show the outcome. */
const COMPLETED_JOB_TTL_MS = 10 * 60_000;

/** Cap on retained output; enough for GenieX's summary block. */
const MAX_MESSAGE_CHARS = 2_000;

/** Grace period for a cancelled pull to save its partial state and exit. */
const CANCEL_GRACE_MS = 10_000;

type TrackedJob = GenieXPullJob & {
  child?: ChildProcess;
  pollTimer?: NodeJS.Timeout;
};

function extractMessageLine(text: string): string | undefined {
  const lines = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("%"));
  if (lines.length === 0) {
    return undefined;
  }
  return lines[lines.length - 1];
}

function compactMessage(text: string): string | undefined {
  const cleaned = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("%"))
    .join("\n");
  return cleaned.length > 0 ? cleaned : undefined;
}

function summarizeFailureOutput(job: TrackedJob, code: number): string {
  const message = compactMessage(job.message ?? "");
  if (message) {
    return message.length > MAX_MESSAGE_CHARS ? message.slice(-MAX_MESSAGE_CHARS) : message;
  }
  return `exit code ${code}`;
}

/** Strips the `:precision` suffix; the size poll keys on the bare model name. */
function stripPrecision(model: string): string {
  const separator = model.lastIndexOf(":");
  return separator > 0 ? model.slice(0, separator) : model;
}

export class GenieXPullJobManager {
  private readonly jobs = new Map<string, TrackedJob>();

  constructor(
    private readonly logger: PluginLogger,
    /** Called after a pull succeeds, so the host can refresh its model catalog. */
    private readonly onSucceeded?: (job: GenieXPullJob) => void,
  ) {}

  list(): GenieXPullJob[] {
    this.pruneCompleted();
    return [...this.jobs.values()]
      .map((job) => this.toPublic(job))
      .toSorted((left, right) => right.startedAt - left.startedAt);
  }

  get(id: string): GenieXPullJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.toPublic(job) : undefined;
  }

  /** True when a pull for this model (any precision) is already running. */
  findRunningForModel(model: string): GenieXPullJob | undefined {
    const bare = stripPrecision(model.trim());
    for (const job of this.jobs.values()) {
      if (job.status === "running" && stripPrecision(job.model) === bare) {
        return this.toPublic(job);
      }
    }
    return undefined;
  }

  /**
   * Starts a pull and returns immediately with the job.
   *
   * Rejects an invalid model name before spawning, and refuses a duplicate pull
   * for a model already downloading — two writers on one cache entry would
   * corrupt the partial file.
   */
  start(params: { model: string; env?: NodeJS.ProcessEnv }): GenieXPullJob {
    const model = params.model.trim();
    if (!isValidGenieXModelName(model)) {
      throw new Error(`Invalid GenieX model name: ${JSON.stringify(params.model)}`);
    }
    const existing = this.findRunningForModel(model);
    if (existing) {
      throw new Error(`A download for "${existing.model}" is already running.`);
    }

    const cliPath = resolveGenieXCliPath(params.env);
    if (!cliPath) {
      throw new Error("geniex CLI not found on PATH.");
    }

    const job: TrackedJob = {
      id: randomUUID(),
      model,
      status: "running",
      startedAt: Date.now(),
    };

    // Omitting the precision is deliberate when the caller did not pin one:
    // without a TTY, `geniex pull` skips its interactive picker and takes the
    // SDK's recommended precision (the head of the sorted candidate list).
    const child = spawn(cliPath, ["pull", model], {
      shell: false,
      // No stdin: `pull` must never wait on a prompt we cannot answer.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(params.env ? { env: params.env } : {}),
    });

    job.child = child;
    this.jobs.set(job.id, job);
    this.attachOutput(job, child);
    this.startProgressPolling(job, params.env);

    child.once("error", (error) => {
      this.finish(job, "failed", { error: String(error) });
    });
    child.once("exit", (code, signal) => {
      if (job.status === "cancelled") {
        this.finish(job, "cancelled");
        return;
      }
      if (code === 0) {
        this.finish(job, "succeeded");
        return;
      }
      this.finish(job, "failed", {
        error:
          signal ? `terminated by ${signal}` : summarizeFailureOutput(job, code),
      });
    });

    this.logger.info(`GenieX pull started for "${model}" (job ${job.id}).`);
    return this.toPublic(job);
  }

  /**
   * Cancels a running pull.
   *
   * SIGTERM rather than SIGKILL so GenieX can flush what it has downloaded —
   * the partial file is what makes the next pull resume instead of restart.
   */
  async cancel(id: string): Promise<GenieXPullJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") {
      return job ? this.toPublic(job) : undefined;
    }
    job.status = "cancelled";
    const child = job.child;
    if (!child || child.exitCode !== null) {
      this.finish(job, "cancelled");
      return this.toPublic(job);
    }

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), CANCEL_GRACE_MS);
      timer.unref?.();
    });
    if ((await Promise.race([exited.then(() => "exited" as const), timeout])) === "timeout") {
      this.logger.warn(`GenieX pull ${id} did not exit after SIGTERM; terminating.`);
      child.kill("SIGKILL");
    }
    return this.toPublic(job);
  }

  /** Cancels every running pull; used on gateway shutdown. */
  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) => job.status === "running")
        .map((job) => this.cancel(job.id)),
    );
  }

  /**
   * Drops a finished job record.
   *
   * Only terminal jobs: a running pull owns a child process and a poll timer,
   * and deleting its record would leave both unsupervised with no way to reach
   * them again. `finish()` has already cleared those for anything terminal, so
   * removal here is just a map delete.
   */
  forget(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }
    if (job.status === "running") {
      throw new Error("Cannot remove a running download. Pause it first.");
    }
    return this.jobs.delete(id);
  }

  private attachOutput(job: TrackedJob, child: ChildProcess): void {
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      // Drop the ANSI progress redraw; keep GenieX's own summary lines
      // ("Download success", "Size:", "Detected model type:", ...).
      const cleaned = text
        // oxlint-disable-next-line no-control-regex -- stripping terminal control sequences is the point
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .split(/\r?\n|\r/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.includes("%"))
        .join("\n");
      if (!cleaned) {
        return;
      }
      const next = job.message ? `${job.message}\n${cleaned}` : cleaned;
      job.message = next.length > MAX_MESSAGE_CHARS ? next.slice(-MAX_MESSAGE_CHARS) : next;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
  }

  private startProgressPolling(job: TrackedJob, env?: NodeJS.ProcessEnv): void {
    const bare = stripPrecision(job.model);
    const poll = async () => {
      if (job.status !== "running") {
        return;
      }
      try {
        const models = await listGenieXCachedModels(env ? { env } : undefined);
        const match = models.find((model) => model.name === bare || model.name === job.model);
        if (match) {
          job.downloadedBytes = match.size;
        }
      } catch {
        // A failed size poll is cosmetic: the job's real outcome comes from the
        // process exit code, so never let this surface as an error.
      }
    };
    const timer = setInterval(() => void poll(), PROGRESS_POLL_INTERVAL_MS);
    timer.unref?.();
    job.pollTimer = timer;
  }

  private finish(job: TrackedJob, status: GenieXPullStatus, extra?: { error?: string }): void {
    if (job.pollTimer) {
      clearInterval(job.pollTimer);
      job.pollTimer = undefined;
    }
    job.child = undefined;
    job.status = status;
    job.endedAt = Date.now();
    if (extra?.error) {
      job.error = extra.error;
    }
    if (status === "succeeded") {
      this.logger.info(`GenieX pull finished for "${job.model}".`);
      try {
        this.onSucceeded?.(this.toPublic(job));
      } catch (error) {
        // The download itself succeeded; a failed catalog refresh must not
        // turn it into an error.
        this.logger.warn(`GenieX post-pull hook failed for "${job.model}": ${String(error)}`);
      }
    } else if (status === "failed") {
      this.logger.warn(`GenieX pull failed for "${job.model}": ${job.error ?? "unknown error"}`);
    } else {
      this.logger.info(`GenieX pull paused for "${job.model}"; partial download is kept.`);
    }
  }

  private pruneCompleted(): void {
    const cutoff = Date.now() - COMPLETED_JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && (job.endedAt ?? 0) < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  private toPublic(job: TrackedJob): GenieXPullJob {
    const { child: _child, pollTimer: _pollTimer, ...rest } = job;
    return { ...rest };
  }
}
