/**
 * Info-level logging gated by `cfg.logging` — see the "Enable Logging" uiHint
 * in openclaw.plugin.json ("Emit info logs for decomposition and delegation
 * activity"). Warnings for actual failures (see hooks.ts/orchestrator.ts/
 * pipeline.ts `logger?.warn` calls) are unconditional and untouched by this:
 * an operator debugging a failure should see it regardless of this toggle.
 *
 * Messages must stay structural (counts, agent ids, hop numbers, session
 * keys) — never the user's prompt or a subtask description — since this is
 * meant to be safe to leave on without turning the log into a transcript.
 */

import type { Logger } from "./runtime-contract.js";

export function logInfo(logging: boolean, logger: Logger | undefined, message: string): void {
  if (!logging) return;
  logger?.info(`[dragon-task-orchestrator] ${message}`);
}
