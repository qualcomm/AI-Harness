// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Locating and invoking the `geniex` CLI.
 *
 * Duplicated from the `geniex` provider plugin's `src/cli.ts` — see
 * `defaults.ts` for why cross-plugin imports are not an option here.
 */
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolveWindowsExecutablePath } from "openclaw/plugin-sdk/windows-spawn";

const log = createSubsystemLogger("extensions/geniex-manager/cli");

export const GENIEX_CLI_COMMAND = "geniex";

/** `geniex version` is cheap but still a process spawn; keep the ceiling low. */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Resolves the `geniex` executable through PATH.
 *
 * Returns undefined rather than throwing when it is absent: a missing CLI is the
 * normal state on a machine where the user has not installed GenieX yet, not an
 * error condition.
 */
export function resolveGenieXCliPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform === "win32") {
    // Handles PATHEXT (.exe/.cmd/...) which a plain existence check would miss.
    const resolved = resolveWindowsExecutablePath(GENIEX_CLI_COMMAND, env);
    return resolved === GENIEX_CLI_COMMAND ? undefined : resolved;
  }

  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = path.join(trimmed, GENIEX_CLI_COMMAND);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep scanning PATH.
    }
  }
  return undefined;
}

/** Whether the `geniex` CLI is on PATH. Synchronous and filesystem-only. */
export function isGenieXCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGenieXCliPath(env) !== undefined;
}

/**
 * Parses the version out of `geniex version` output.
 *
 * Deliberately lenient: the exact wording is not a stable contract, so a version
 * we cannot parse degrades to undefined instead of failing the whole probe.
 */
export function parseGenieXVersion(output: string): string | undefined {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/);
  return match?.[1];
}

/** Reads the installed CLI version, or undefined if it cannot be determined. */
export async function readGenieXCliVersion(params?: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const cliPath = resolveGenieXCliPath(params?.env);
  if (!cliPath) {
    return undefined;
  }
  try {
    const result = await runCommandWithTimeout([cliPath, "version"], {
      timeoutMs: params?.timeoutMs ?? VERSION_TIMEOUT_MS,
      ...(params?.env ? { env: params.env } : {}),
    });
    if (result.code !== 0) {
      log.debug(`geniex version exited with code ${result.code}: ${result.stderr.trim()}`);
      return undefined;
    }
    return parseGenieXVersion(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    log.debug(`geniex version failed: ${String(error)}`);
    return undefined;
  }
}
