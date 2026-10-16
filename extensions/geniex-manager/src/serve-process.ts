// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Supervises a `geniex serve` child process for the lifetime of the gateway.
 *
 * Two things drive the design:
 *
 * 1. **`geniex serve` starts fine with zero models.** `Serve()` only resolves the
 *    host chipset and starts a keep-alive ticker; models load lazily on the first
 *    request (GenieX `cli/server/server.go`). So the process can come up before
 *    the user has downloaded anything, and a model pulled later needs no restart.
 *
 * 2. **Shutdown must be graceful.** GenieX warns that skipping its `DeInit`
 *    "pins NPU buffers till reboot". We therefore ask the process to exit and
 *    only hard-kill as a timeout backstop.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { GENIEX_CLI_COMMAND, resolveGenieXCliPath } from "./cli.js";
import { GENIEX_DEFAULT_HOST } from "./defaults.js";
import { probeGenieXServer } from "./probe.js";

/**
 * How the plugin treats the `geniex serve` process.
 *
 * - `auto` (default): reuse an instance already listening on the host, otherwise
 *   start one. Avoids fighting a `geniex serve` the user started by hand.
 * - `always`: always start our own (fails if the port is taken).
 * - `never`: never start one; the operator manages it.
 */
export type GenieXServeMode = "auto" | "always" | "never";

export type GenieXServeOptions = {
  mode?: GenieXServeMode;
  host?: string;
  /** Default compute unit for models that do not specify one per request. */
  compute?: string;
  /** Idle seconds before GenieX unloads the cached model. */
  keepAliveSeconds?: number;
};

export type GenieXServeState =
  /** Not started because the platform or CLI rules it out, or mode is `never`. */
  | { status: "inactive"; reason: string }
  /** An instance we did not start is serving the host. */
  | { status: "external" }
  | { status: "starting" }
  | { status: "running"; pid?: number }
  /** Exited unexpectedly; `restarts` counts attempts so far. */
  | { status: "failed"; reason: string; restarts: number };

/** Seconds between restart attempts, capped so a broken install stops spamming. */
const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000];
const MAX_RESTART_ATTEMPTS = RESTART_BACKOFF_MS.length;

/** How long to wait for the HTTP server to answer after spawn. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 500;

/** Grace period for a graceful exit before escalating to a hard kill. */
const SHUTDOWN_GRACE_MS = 10_000;

export function buildGenieXServeArgs(options: GenieXServeOptions): string[] {
  const args = ["serve", "--host", options.host?.trim() || GENIEX_DEFAULT_HOST];
  const compute = options.compute?.trim();
  if (compute) {
    args.push("--compute", compute);
  }
  if (typeof options.keepAliveSeconds === "number" && Number.isFinite(options.keepAliveSeconds)) {
    args.push("--keepalive", String(Math.max(0, Math.floor(options.keepAliveSeconds))));
  }
  return args;
}

function resolveBaseUrl(host: string): string {
  return `http://${host}/v1`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class GenieXServeSupervisor {
  private child: ChildProcess | null = null;
  private state: GenieXServeState = { status: "inactive", reason: "not started" };
  private restarts = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly host: string;
  private readonly mode: GenieXServeMode;

  constructor(
    private readonly options: GenieXServeOptions,
    private readonly logger: PluginLogger,
  ) {
    this.host = options.host?.trim() || GENIEX_DEFAULT_HOST;
    this.mode = options.mode ?? "auto";
  }

  getState(): GenieXServeState {
    return this.state;
  }

  get baseUrl(): string {
    return resolveBaseUrl(this.host);
  }

  /** True when this supervisor owns the running process (so it may stop it). */
  get ownsProcess(): boolean {
    return this.child !== null;
  }

  async start(): Promise<GenieXServeState> {
    this.stopping = false;

    if (this.mode === "never") {
      this.state = { status: "inactive", reason: "serve.mode is \"never\"" };
      return this.state;
    }

    if (!resolveGenieXCliPath()) {
      // Not an error: the user simply has not installed GenieX. The UI turns
      // this into install guidance.
      this.state = { status: "inactive", reason: "geniex CLI not found on PATH" };
      this.logger.info(
        "GenieX CLI not found on PATH; skipping managed serve. Install GenieX to enable on-device inference.",
      );
      return this.state;
    }

    if (this.mode === "auto" && (await probeGenieXServer({ baseUrl: this.baseUrl }))) {
      this.state = { status: "external" };
      this.logger.info(`Reusing the GenieX server already listening on ${this.host}.`);
      return this.state;
    }

    return await this.spawnAndWait();
  }

  private async spawnAndWait(): Promise<GenieXServeState> {
    const cliPath = resolveGenieXCliPath();
    if (!cliPath) {
      this.state = { status: "inactive", reason: "geniex CLI not found on PATH" };
      return this.state;
    }

    const args = buildGenieXServeArgs({ ...this.options, host: this.host });
    this.state = { status: "starting" };
    this.logger.info(`Starting GenieX server: ${GENIEX_CLI_COMMAND} ${args.join(" ")}`);

    let child: ChildProcess;
    try {
      child = spawn(cliPath, args, {
        // argv array, never a shell string: model names and hosts reach the
        // process as discrete arguments with no shell interpretation.
        shell: false,
        // Nothing on stdin — `serve` is non-interactive, and leaving stdin open
        // to a TTY would let a stray prompt block forever.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      // Covers the race where the CLI vanished between the PATH check and spawn.
      this.state = { status: "failed", reason: String(error), restarts: this.restarts };
      this.logger.warn(`Failed to spawn GenieX server: ${String(error)}`);
      return this.state;
    }

    this.child = child;
    this.pipeOutput(child);
    child.once("exit", (code, signal) => {
      this.handleExit(code, signal);
    });

    const ready = await this.waitForReady();
    if (!ready) {
      // Leave the process running: it may still be initializing the NPU runtime,
      // and killing it here would lose a slow but valid startup.
      this.logger.warn(
        `GenieX server did not answer on ${this.host} within ${READY_TIMEOUT_MS / 1000}s; continuing without it for now.`,
      );
      this.state = {
        status: "failed",
        reason: "server did not become ready in time",
        restarts: this.restarts,
      };
      return this.state;
    }

    this.restarts = 0;
    this.state = { status: "running", ...(child.pid !== undefined ? { pid: child.pid } : {}) };
    this.logger.info(`GenieX server ready on ${this.host}.`);
    return this.state;
  }

  private pipeOutput(child: ChildProcess): void {
    // `debug` is optional on PluginLogger; serve output is verbose enough that
    // it should stay out of the default log level rather than fall back to info.
    const forward = (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this.logger.debug?.(`[geniex serve] ${text}`);
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
  }

  private async waitForReady(): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping || !this.child) {
        return false;
      }
      if (await probeGenieXServer({ baseUrl: this.baseUrl, timeoutMs: 2_000 })) {
        return true;
      }
      await delay(READY_POLL_INTERVAL_MS);
    }
    return false;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    if (this.stopping) {
      this.logger.info("GenieX server stopped.");
      this.state = { status: "inactive", reason: "stopped" };
      return;
    }

    const detail = signal ? `signal ${signal}` : `exit code ${code}`;
    this.state = { status: "failed", reason: detail, restarts: this.restarts };

    if (this.restarts >= MAX_RESTART_ATTEMPTS) {
      // Stop retrying: past this point the failure is almost certainly
      // configuration (a taken port, a broken install) that retries cannot fix,
      // and further attempts would just flood the log.
      this.logger.warn(
        `GenieX server exited (${detail}) and will not be restarted after ${this.restarts} attempts. Use the Local Models page to retry.`,
      );
      return;
    }

    const backoffMs = RESTART_BACKOFF_MS[this.restarts] ?? RESTART_BACKOFF_MS.at(-1) ?? 60_000;
    this.restarts += 1;
    this.logger.warn(
      `GenieX server exited (${detail}); restarting in ${backoffMs / 1000}s (attempt ${this.restarts}/${MAX_RESTART_ATTEMPTS}).`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) {
        void this.spawnAndWait();
      }
    }, backoffMs);
    // Do not hold the process open just to retry a background service.
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.state = { status: "inactive", reason: "stopped" };
      return;
    }

    // Ask first, kill second. GenieX releases NPU buffers in its signal handler;
    // skipping that leaves them reserved until the machine reboots.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill("SIGTERM");

    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS);
      timer.unref?.();
    });

    const outcome = await Promise.race([exited.then(() => "exited" as const), timeout]);
    if (outcome === "timeout") {
      this.logger.warn(
        `GenieX server did not exit within ${SHUTDOWN_GRACE_MS / 1000}s; terminating. NPU buffers may stay reserved until reboot.`,
      );
      child.kill("SIGKILL");
    }

    this.child = null;
    this.state = { status: "inactive", reason: "stopped" };
  }

  /** Stops (if we own the process) and starts again — used by the UI restart action. */
  async restart(): Promise<GenieXServeState> {
    await this.stop();
    this.restarts = 0;
    return await this.start();
  }
}
