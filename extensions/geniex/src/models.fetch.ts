// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/** Network access to `geniex serve`'s OpenAI-compatible endpoints. */
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { excludeEmbeddingModels } from "./embedding-models.js";
import {
  type GenieXModelsResponse,
  type GenieXModelWire,
  mapGenieXWireModelsToConfig,
  resolveGenieXInferenceBase,
} from "./models.js";

const log = createSubsystemLogger("extensions/geniex/models");

const REQUEST_TIMEOUT_MS = 5000;

function buildHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  const trimmed = apiKey?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : undefined;
}

/**
 * Whether a `geniex serve` instance is reachable at `baseUrl`.
 *
 * Probes `GET /v1/`, which returns "GenieX-CLI is running" as soon as the HTTP
 * server is up. Deliberately not `/v1/models`: `geniex serve` starts fine with
 * zero models cached (it loads models lazily per request), so an empty model
 * list is a valid ready state, not a failure.
 */
export async function probeGenieXServer(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const base = resolveGenieXInferenceBase(params.baseUrl);
  try {
    const response = await fetch(`${base}/`, {
      headers: buildHeaders(params.apiKey),
      signal: AbortSignal.timeout(params.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Logged because a silent false here is indistinguishable from "server not
      // running", which makes an empty model list very hard to diagnose.
      log.debug(`GenieX probe at ${base}/ returned HTTP ${response.status}`);
    }
    return response.ok;
  } catch (error) {
    log.debug(`GenieX probe at ${base}/ failed: ${String(error)}`);
    return false;
  }
}

/**
 * Fetches one model's detail to read its `model_type`.
 *
 * `GET /v1/models` returns bare `openai.Model` objects with no GenieX
 * extensions — only `GET /v1/models/<name>` returns the `ModelResponse` shape
 * that carries `model_type` (GenieX `cli/server/handler/model.go`). Vision
 * support therefore needs a per-model lookup.
 */
export async function fetchGenieXModelType(params: {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const base = resolveGenieXInferenceBase(params.baseUrl);
  try {
    // The route is `/models/*model` — a gin wildcard that captures the rest of
    // the path verbatim, including the slashes in "org/repo:precision". Do NOT
    // percent-encode the id: GenieX would then try to resolve a literal "%2F".
    const response = await fetch(`${base}/models/${params.modelId}`, {
      headers: buildHeaders(params.apiKey),
      signal: AbortSignal.timeout(params.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.debug(`GenieX model detail for "${params.modelId}": HTTP ${response.status}`);
      return undefined;
    }
    const payload = (await response.json()) as GenieXModelWire | null;
    return typeof payload?.model_type === "string" ? payload.model_type : undefined;
  } catch (error) {
    log.debug(`GenieX model detail for "${params.modelId}" failed: ${String(error)}`);
    return undefined;
  }
}

/** Fetches raw `/v1/models` entries; returns an empty list on any failure. */
export async function fetchGenieXModels(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<GenieXModelWire[]> {
  const base = resolveGenieXInferenceBase(params.baseUrl);
  const url = `${base}/models`;
  try {
    const response = await fetch(url, {
      headers: buildHeaders(params.apiKey),
      signal: AbortSignal.timeout(params.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn(`Failed to list GenieX models: HTTP ${response.status}`);
      return [];
    }
    const payload = (await response.json()) as GenieXModelsResponse;
    return Array.isArray(payload.data) ? payload.data : [];
  } catch (error) {
    log.warn(`Failed to list GenieX models: ${String(error)}`);
    return [];
  }
}

/**
 * Fetches `/v1/models` and maps it into chat-facing model definitions.
 *
 * Because the list endpoint omits `model_type`, each surviving model gets one
 * follow-up detail request to recover it. Those run concurrently and fail soft:
 * a model whose type cannot be read is treated as text-only, which under-reports
 * a VLM rather than promising image support that is not there.
 */
export async function discoverGenieXModels(params: {
  baseUrl: string;
  apiKey?: string;
  includeModels?: readonly string[];
  timeoutMs?: number;
}): Promise<ModelDefinitionConfig[]> {
  const models = await fetchGenieXModels(params);
  if (models.length === 0) {
    return [];
  }

  // Resolve types only for models that survive the embedding filter, so the
  // extra requests track the chat catalog rather than the whole cache.
  const chatModels = excludeEmbeddingModels({
    models: models.filter((model): model is GenieXModelWire & { id: string } =>
      Boolean(model.id?.trim()),
    ),
    allowList: params.includeModels,
  });

  const withTypes = await Promise.all(
    chatModels.map(async (model) => {
      if (typeof model.model_type === "string" && model.model_type.trim()) {
        return model;
      }
      const modelType = await fetchGenieXModelType({
        baseUrl: params.baseUrl,
        modelId: model.id,
        apiKey: params.apiKey,
        timeoutMs: params.timeoutMs,
      });
      return modelType ? { ...model, model_type: modelType } : model;
    }),
  );

  return mapGenieXWireModelsToConfig({
    models: withTypes,
    includeModels: params.includeModels,
  });
}
