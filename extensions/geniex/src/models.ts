// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Maps `geniex serve` model payloads into catalog entries.
 *
 * Note the asymmetry in GenieX `cli/server/handler/model.go`: `GET /v1/models`
 * returns bare `openai.Model` objects, while only `GET /v1/models/<name>`
 * returns the `ModelResponse` shape carrying the `model_type` extension
 * (`"llm"` / `"vlm"`). `discoverGenieXModels` backfills the type per model;
 * entries reaching this mapper may legitimately have it unset.
 *
 * Neither endpoint reports a model's runtime, so runtime metadata comes from
 * the Local Models surface (`geniex list --format json`), not from here.
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { GENIEX_DEFAULT_BASE_URL } from "./defaults.js";
import { excludeEmbeddingModels } from "./embedding-models.js";

/** One entry of GenieX's `GET /v1/models` response. */
export type GenieXModelWire = {
  id?: string;
  owned_by?: string;
  /** GenieX extension: `"llm"` or `"vlm"`. */
  model_type?: string;
};

export type GenieXModelsResponse = {
  object?: string;
  data?: GenieXModelWire[];
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether GenieX reported this entry as a vision-language model. */
export function isGenieXVisionModel(entry: Pick<GenieXModelWire, "model_type">): boolean {
  return normalizeOptionalString(entry.model_type)?.toLowerCase() === "vlm";
}

/**
 * Normalizes `/v1/models` wire entries into model definitions.
 *
 * Embedding models are dropped: GenieX labels them `"llm"` and `geniex serve`
 * has no `/v1/embeddings` route, so they cannot work as chat models.
 */
export function mapGenieXWireModelsToConfig(params: {
  models: readonly GenieXModelWire[];
  contextWindow?: number;
  maxTokens?: number;
  /** Model ids to keep even if they look like embedding models. */
  includeModels?: readonly string[];
}): ModelDefinitionConfig[] {
  const normalized = params.models
    .map((model) => ({ id: normalizeOptionalString(model.id), wire: model }))
    .filter((entry): entry is { id: string; wire: GenieXModelWire } => Boolean(entry.id));

  const chatModels = excludeEmbeddingModels({
    models: normalized,
    allowList: params.includeModels,
  });

  return chatModels.map((entry) => {
    const vision = isGenieXVisionModel(entry.wire);
    return {
      id: entry.id,
      name: entry.id,
      // GenieX exposes no reasoning metadata; leave it off rather than guess
      // from the model name.
      reasoning: false,
      input: vision ? (["text", "image"] as const).slice() : (["text"] as const).slice(),
      cost: SELF_HOSTED_DEFAULT_COST,
      contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
      compat: { supportsUsageInStreaming: true },
    } satisfies ModelDefinitionConfig;
  });
}

/**
 * Normalizes a user-supplied base URL to GenieX's OpenAI-compatible root.
 *
 * Accepts the bare host (`http://127.0.0.1:18181`) as well as the full
 * inference base (`.../v1`), since both appear in GenieX docs.
 */
export function resolveGenieXInferenceBase(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return GENIEX_DEFAULT_BASE_URL;
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function normalizeGenieXProviderConfig(
  providerConfig: ModelProviderConfig | undefined,
): ModelProviderConfig | undefined {
  if (!providerConfig) {
    return undefined;
  }
  const baseUrl = resolveGenieXInferenceBase(providerConfig.baseUrl);
  if (baseUrl === providerConfig.baseUrl) {
    return providerConfig;
  }
  return { ...providerConfig, baseUrl };
}
