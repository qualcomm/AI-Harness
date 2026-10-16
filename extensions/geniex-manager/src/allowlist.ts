// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Keeps `agents.defaults.models` in step with downloaded GenieX models.
 *
 * `models.list` filters the chat catalog through that map whenever it is
 * non-empty, so a freshly pulled model would be discovered yet invisible in the
 * chat model picker. An empty map means "allow everything" and is left alone —
 * adding an entry there would silently turn the allowlist on and hide every
 * other model.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { resolveGenieXInferenceBase } from "./probe.js";

const PROVIDER_PREFIX = "geniex/";
const REQUEST_TIMEOUT_MS = 5000;

/** Strips the `:precision` suffix; allowlist keys and pull names differ by it. */
function bareName(model: string): string {
  const separator = model.lastIndexOf(":");
  return (separator > 0 ? model.slice(0, separator) : model).toLowerCase();
}

type ConfigApi = {
  loadConfig: () => OpenClawConfig;
  writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
};

/**
 * Bare names of every model configured as an MTP draft.
 *
 * Read from the `geniex` provider plugin's config (`specDraftModel`). A draft is
 * a helper loaded alongside its target; selecting it for chat is meaningless, so
 * it must not be offered in the picker.
 */
function collectDraftModelNames(cfg: OpenClawConfig): Set<string> {
  const models = (
    cfg.plugins?.entries?.geniex?.config as
      | { models?: Record<string, { specDraftModel?: unknown }> }
      | undefined
  )?.models;
  const drafts = new Set<string>();
  for (const settings of Object.values(models ?? {})) {
    const draft = settings?.specDraftModel;
    if (typeof draft === "string" && draft.trim()) {
      drafts.add(bareName(draft.trim()));
    }
  }
  return drafts;
}

/**
 * Adds `geniex/<id>` entries for `ids`, skipping configured draft models;
 * returns null when nothing changes.
 */
export function addGenieXModelsToAllowlist(
  cfg: OpenClawConfig,
  ids: readonly string[],
): OpenClawConfig | null {
  const current = cfg.agents?.defaults?.models;
  if (!current || Object.keys(current).length === 0) {
    return null;
  }
  const drafts = collectDraftModelNames(cfg);
  const missing = ids.filter(
    (id) => !(`${PROVIDER_PREFIX}${id}` in current) && !drafts.has(bareName(id)),
  );
  if (missing.length === 0) {
    return null;
  }
  const next = structuredClone(cfg);
  const models = next.agents!.defaults!.models!;
  for (const id of missing) {
    models[`${PROVIDER_PREFIX}${id}`] = {};
  }
  return next;
}

/** Drops every `geniex/<name>[:precision]` entry for a removed model. */
export function removeGenieXModelFromAllowlist(
  cfg: OpenClawConfig,
  name: string,
): OpenClawConfig | null {
  const current = cfg.agents?.defaults?.models;
  if (!current) {
    return null;
  }
  const target = bareName(name);
  const stale = Object.keys(current).filter(
    (key) => key.startsWith(PROVIDER_PREFIX) && bareName(key.slice(PROVIDER_PREFIX.length)) === target,
  );
  if (stale.length === 0) {
    return null;
  }
  const next = structuredClone(cfg);
  for (const key of stale) {
    delete next.agents!.defaults!.models![key];
  }
  return next;
}

/** Ids `geniex serve` currently reports for a pulled model reference. */
async function fetchServedIdsForModel(baseUrl: string, model: string): Promise<string[]> {
  const response = await fetch(`${resolveGenieXInferenceBase(baseUrl)}/models`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET /v1/models returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const target = bareName(model);
  return (payload.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
    .filter((id) => id && bareName(id) === target);
}

/**
 * Allowlists a just-pulled model under the id `geniex serve` actually reports,
 * so the key matches the catalog entry rather than the name typed at pull time.
 */
export async function allowlistPulledModel(params: {
  config: ConfigApi;
  baseUrl: string;
  model: string;
  logger: PluginLogger;
}): Promise<void> {
  const ids = await fetchServedIdsForModel(params.baseUrl, params.model);
  const next = addGenieXModelsToAllowlist(params.config.loadConfig(), ids);
  if (next) {
    await params.config.writeConfigFile(next);
    params.logger.info(`Added ${ids.map((id) => PROVIDER_PREFIX + id).join(", ")} to the model allowlist.`);
  }
}

/** Removes a deleted model's allowlist entries. */
export async function unallowlistRemovedModel(params: {
  config: ConfigApi;
  model: string;
  logger: PluginLogger;
}): Promise<void> {
  const next = removeGenieXModelFromAllowlist(params.config.loadConfig(), params.model);
  if (next) {
    await params.config.writeConfigFile(next);
    params.logger.info(`Removed "${params.model}" from the model allowlist.`);
  }
}
