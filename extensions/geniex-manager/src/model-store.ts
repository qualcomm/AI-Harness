// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Reads and mutates the local GenieX model cache through the `geniex` CLI.
 *
 * `geniex list --format json` is the one machine-readable surface GenieX offers
 * for cached models, and its shape is documented upstream as "the stable schema"
 * (`cli/cmd/geniex/model.go`). Everything else here shells out to the same CLI.
 *
 * Model names are validated before they reach argv. Commands are spawned as an
 * argv array with no shell, so this is defence in depth rather than the only
 * guard — but it also keeps malformed input from reaching GenieX at all.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolveGenieXCliPath } from "./cli.js";
import { isComputeUnitSelectable } from "./compute.js";

const log = createSubsystemLogger("extensions/geniex-manager/model-store");

const LIST_TIMEOUT_MS = 30_000;
const REMOVE_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 20_000;

/**
 * Accepted model reference: `org/repo`, optionally `:precision`, optionally a
 * bare name (GenieX rewrites those to `qualcomm/<name>`).
 *
 * Intentionally strict — no spaces, quotes, shell metacharacters, or path
 * traversal. A name that fails this never reaches the process.
 */
const MODEL_NAME_RE = /^[A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)?(?::[\w.-]+)?$/;

export function isValidGenieXModelName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) {
    return false;
  }
  if (trimmed.includes("..")) {
    return false;
  }
  return MODEL_NAME_RE.test(trimmed);
}

function assertValidModelName(name: string): string {
  const trimmed = name.trim();
  if (!isValidGenieXModelName(trimmed)) {
    throw new Error(`Invalid GenieX model name: ${JSON.stringify(name)}`);
  }
  return trimmed;
}

/** One row of `geniex list --format json`. */
export type GenieXListedModelWire = {
  name?: string;
  size?: number;
  runtime?: string;
  type?: string;
  precisions?: string[];
};

/** A cached model, as surfaced to the UI. */
export type GenieXCachedModel = {
  name: string;
  /** Total bytes on disk across every downloaded precision. */
  size: number;
  runtime: string;
  modelType: "llm" | "vlm" | "unknown";
  precisions: string[];
  /** Whether the user may choose a compute unit (false for NPU-only qairt). */
  computeSelectable: boolean;
};

function normalizeModelType(value: unknown): GenieXCachedModel["modelType"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "llm" || normalized === "vlm" ? normalized : "unknown";
}

/** Maps CLI rows into UI models, annotating whether compute is selectable. */
export function mapGenieXListedModels(rows: readonly GenieXListedModelWire[]): GenieXCachedModel[] {
  return rows.flatMap((row) => {
    const name = row.name?.trim();
    if (!name) {
      return [];
    }
    const runtime = row.runtime?.trim() || "unknown";
    return [
      {
        name,
        size: typeof row.size === "number" && Number.isFinite(row.size) ? row.size : 0,
        runtime,
        modelType: normalizeModelType(row.type),
        precisions: (row.precisions ?? []).filter(
          (precision): precision is string => typeof precision === "string",
        ),
        // Delegated to compute.ts so the UI and the request-injection path agree
        // on which runtimes are NPU-pinned.
        computeSelectable: isComputeUnitSelectable(runtime),
      },
    ];
  });
}

async function runGenieX(params: {
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const cliPath = resolveGenieXCliPath(params.env);
  if (!cliPath) {
    throw new Error("geniex CLI not found on PATH.");
  }
  const result = await runCommandWithTimeout([cliPath, ...params.args], {
    timeoutMs: params.timeoutMs,
    ...(params.env ? { env: params.env } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

/** Lists cached models. Returns an empty list when nothing is downloaded yet. */
export async function listGenieXCachedModels(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<GenieXCachedModel[]> {
  const result = await runGenieX({
    args: ["list", "--format", "json"],
    timeoutMs: LIST_TIMEOUT_MS,
    ...(params?.env ? { env: params.env } : {}),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `geniex list exited with code ${result.code}`);
  }
  return mapGenieXListedModels(parseGenieXListOutput(result.stdout));
}

/**
 * Extracts the JSON array from `geniex list --format json` output.
 *
 * Tolerates leading banner lines: the CLI prints informational text on some
 * paths, and a strict `JSON.parse` of the whole stream would fail.
 */
export function parseGenieXListOutput(stdout: string): GenieXListedModelWire[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end <= start) {
    log.debug("geniex list produced no JSON array");
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as GenieXListedModelWire[]) : [];
  } catch (error) {
    log.warn(`Failed to parse geniex list output: ${String(error)}`);
    return [];
  }
}

/** Deletes a cached model. `-y` because there is no TTY to confirm on. */
export async function removeGenieXModel(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const name = assertValidModelName(params.name);
  const result = await runGenieX({
    args: ["remove", "-y", name],
    timeoutMs: REMOVE_TIMEOUT_MS,
    ...(params.env ? { env: params.env } : {}),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `geniex remove exited with code ${result.code}`);
  }
}

/**
 * Reads the configured chipset.
 *
 * `geniex config get chipset` falls back to host autodetection and prints
 * `unknown` when neither is available — that string means "not resolved", and
 * the caller must ask the user before any AI Hub operation.
 */
export async function readGenieXChipset(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const result = await runGenieX({
    args: ["config", "get", "chipset"],
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(params?.env ? { env: params.env } : {}),
  });
  if (result.code !== 0) {
    return undefined;
  }
  return parseGenieXChipsetOutput(result.stdout);
}

export function parseGenieXChipsetOutput(stdout: string): string | undefined {
  const value = stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!value || value.toLowerCase() === "unknown") {
    return undefined;
  }
  return value;
}

/** Chipset ids are drawn from platform.json, so allow the same character set. */
const CHIPSET_NAME_RE = /^[A-Za-z0-9][\w.-]*$/;

export function isValidGenieXChipset(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && CHIPSET_NAME_RE.test(trimmed);
}

/** Persists the chipset so AI Hub operations stop needing the interactive picker. */
export async function writeGenieXChipset(params: {
  chipset: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const chipset = params.chipset.trim();
  if (!isValidGenieXChipset(chipset)) {
    throw new Error(`Invalid chipset id: ${JSON.stringify(params.chipset)}`);
  }
  const result = await runGenieX({
    args: ["config", "set", "chipset", chipset],
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(params.env ? { env: params.env } : {}),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `geniex config set exited with code ${result.code}`);
  }
}
