// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Plugin-owned GenieX settings.
 *
 * Per-model compute lives in plugin config rather than in
 * `models.providers.geniex.models[]`, because `ModelDefinitionConfig` is a
 * fixed core shape with no vendor extension slot.
 *
 * Entries are keyed by the same `name[:precision]` string GenieX itself uses:
 * a model can be cached at several precisions (`geniex list --format json`
 * reports `precisions` as an array) and each is loaded separately, so compute
 * is tracked per precision too. A bare `name` entry applies to every precision
 * of that model.
 *
 * Process-level `geniex serve` settings (host, mode, default compute) are a
 * *different* config, owned by the `geniex-manager` plugin under
 * `plugins.entries.geniex-manager.config.serve` — see that plugin's README
 * for why the two are split.
 */
import { type GenieXComputeUnit, normalizeGenieXComputeUnit } from "./compute.js";
import { GENIEX_PROVIDER_ID } from "./defaults.js";

export type GenieXModelSettings = {
  /** Compute unit to request for this model. */
  compute?: GenieXComputeUnit;
  /** llama_cpp context size override (`nctx` in the request body). */
  contextSize?: number;
  /** llama_cpp GPU-layer override (`ngl`; 0 = pure CPU, -1 = all layers). */
  gpuLayers?: number;
  /**
   * Draft model for MTP speculative decoding (`spec_draft_model`). Setting it
   * turns speculation on (`spec_type: "draft-mtp"`). llama_cpp and text-only.
   */
  specDraftModel?: string;
  /** Max draft tokens per verification step (`spec_n_max`). */
  specDraftTokens?: number;
  /** Min draft tokens per step (`spec_n_min`). */
  specDraftMin?: number;
  /** Draft stops proposing below this confidence (`spec_p_min`, 0..1). */
  specDraftPMin?: number;
};

export type GenieXPluginConfig = {
  /** Per-model settings keyed by `name` or `name:precision`. */
  models?: Record<string, GenieXModelSettings>;
  /**
   * Model ids to keep in the chat catalog even if they match the
   * embedding-model name patterns.
   */
  includeModels?: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function normalizeGpuLayers(value: unknown): number | undefined {
  // -1 means "all layers" and 0 means "pure CPU", so both are meaningful.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored >= -1 ? floored : undefined;
}

export function normalizeGenieXModelSettings(value: unknown): GenieXModelSettings | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const settings: GenieXModelSettings = {};
  const compute = normalizeGenieXComputeUnit(record.compute);
  if (compute) {
    settings.compute = compute;
  }
  const contextSize = normalizePositiveInteger(record.contextSize);
  if (contextSize !== undefined) {
    settings.contextSize = contextSize;
  }
  const gpuLayers = normalizeGpuLayers(record.gpuLayers);
  if (gpuLayers !== undefined) {
    settings.gpuLayers = gpuLayers;
  }
  const specDraftModel =
    typeof record.specDraftModel === "string" ? record.specDraftModel.trim() : "";
  // The draft only means something with a draft model; without one the other
  // spec fields would be dead config, so drop them rather than half-enable.
  if (specDraftModel) {
    settings.specDraftModel = specDraftModel;
    const specDraftTokens = normalizePositiveInteger(record.specDraftTokens);
    if (specDraftTokens !== undefined) {
      settings.specDraftTokens = specDraftTokens;
    }
    const specDraftMin = normalizePositiveInteger(record.specDraftMin);
    if (specDraftMin !== undefined) {
      settings.specDraftMin = specDraftMin;
    }
    if (
      typeof record.specDraftPMin === "number" &&
      record.specDraftPMin > 0 &&
      record.specDraftPMin <= 1
    ) {
      settings.specDraftPMin = record.specDraftPMin;
    }
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Reads and normalizes this plugin's config out of the raw plugin entry bag. */
export function normalizeGenieXPluginConfig(raw: unknown): GenieXPluginConfig {
  const record = asRecord(raw);
  if (!record) {
    return {};
  }
  const config: GenieXPluginConfig = {};

  const models = asRecord(record.models);
  if (models) {
    const normalized: Record<string, GenieXModelSettings> = {};
    for (const [key, value] of Object.entries(models)) {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        continue;
      }
      const settings = normalizeGenieXModelSettings(value);
      if (settings) {
        normalized[trimmedKey] = settings;
      }
    }
    if (Object.keys(normalized).length > 0) {
      config.models = normalized;
    }
  }

  if (Array.isArray(record.includeModels)) {
    const includeModels = record.includeModels
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (includeModels.length > 0) {
      config.includeModels = includeModels;
    }
  }

  return config;
}

/** Strips a leading `geniex/` provider prefix from a qualified model ref. */
export function stripGenieXProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const prefix = `${GENIEX_PROVIDER_ID}/`;
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}

/**
 * Settings for `modelId`, preferring an exact `name:precision` match and
 * falling back to the bare `name` entry.
 */
export function resolveGenieXModelSettings(params: {
  config: GenieXPluginConfig;
  modelId: string;
}): GenieXModelSettings | undefined {
  const models = params.config.models;
  if (!models) {
    return undefined;
  }
  const modelId = stripGenieXProviderPrefix(params.modelId);
  if (!modelId) {
    return undefined;
  }
  const exact = models[modelId];
  if (exact) {
    return exact;
  }
  // GenieX splits on the last ':' (see SplitNamePrecision), so a bare-name
  // fallback has to split the same way.
  const separator = modelId.lastIndexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  return models[modelId.slice(0, separator)];
}

