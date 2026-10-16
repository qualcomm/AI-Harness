// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/** Discovery and auth wiring for the GenieX provider. */
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth,
} from "openclaw/plugin-sdk/provider-setup";
import {
  type GenieXPluginConfig,
  normalizeGenieXPluginConfig,
  resolveGenieXModelSettings,
} from "./config.js";
import {
  GENIEX_DEFAULT_API_KEY_ENV_VAR,
  GENIEX_DEFAULT_BASE_URL,
  GENIEX_MODEL_PLACEHOLDER,
  GENIEX_PROVIDER_ID,
  GENIEX_PROVIDER_LABEL,
} from "./defaults.js";
import { discoverGenieXModels, probeGenieXServer } from "./models.fetch.js";
import { resolveGenieXInferenceBase } from "./models.js";

/** Merges discovered models into explicitly configured ones, config winning. */
function mergeDiscoveredModels(params: {
  explicitModels?: ModelDefinitionConfig[];
  discoveredModels: ModelDefinitionConfig[];
}): ModelDefinitionConfig[] {
  const explicit = params.explicitModels ?? [];
  if (explicit.length === 0) {
    return params.discoveredModels;
  }
  const seen = new Set(explicit.map((model) => model.id.trim().toLowerCase()));
  return [
    ...explicit,
    ...params.discoveredModels.filter((model) => !seen.has(model.id.trim().toLowerCase())),
  ];
}

/**
 * Declares the context window GenieX will actually load.
 *
 * Without this the catalog advertises the generic self-hosted default (128k)
 * while the model runs with the much smaller `nctx`, so the gateway never
 * compacts early and the request is rejected as "prompt too large" instead.
 * `contextSize` is what stream.ts sends as `nctx`, so it is the source of truth.
 */
function alignContextWindowWithContextSize(
  model: ModelDefinitionConfig,
  pluginConfig: GenieXPluginConfig,
): ModelDefinitionConfig {
  const contextSize = resolveGenieXModelSettings({ config: pluginConfig, modelId: model.id })
    ?.contextSize;
  if (contextSize === undefined) {
    return model;
  }
  return {
    ...model,
    contextWindow: contextSize,
    maxTokens: Math.min(model.maxTokens, contextSize),
  };
}

/**
 * Discovers a local `geniex serve` instance.
 *
 * GenieX serves an unauthenticated OpenAI-compatible API, so unlike the other
 * self-hosted providers there is no API key to gate discovery on. Readiness is
 * decided by probing `GET /v1/` instead: `geniex serve` starts successfully with
 * an empty model cache (models load lazily per request), so an empty
 * `/v1/models` response is a valid ready state and must not suppress the
 * provider — otherwise a fresh install could never reach the UI that downloads
 * the first model.
 */
export async function discoverGenieXProvider(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig & { apiKey: string };
} | null> {
  const explicit = ctx.config.models?.providers?.[GENIEX_PROVIDER_ID];
  const baseUrl = resolveGenieXInferenceBase(explicit?.baseUrl);
  const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(GENIEX_PROVIDER_ID);

  const reachable = await probeGenieXServer({ baseUrl, apiKey: discoveryApiKey });
  if (!reachable) {
    return null;
  }

  const pluginConfig = normalizeGenieXPluginConfig(
    ctx.config.plugins?.entries?.[GENIEX_PROVIDER_ID]?.config,
  );
  const discoveredModels = await discoverGenieXModels({
    baseUrl,
    apiKey: discoveryApiKey,
    includeModels: pluginConfig.includeModels,
  });

  return {
    provider: {
      ...explicit,
      baseUrl,
      api: explicit?.api ?? "openai-completions",
      models: mergeDiscoveredModels({
        explicitModels: explicit?.models,
        discoveredModels: discoveredModels.map((model) =>
          alignContextWindowWithContextSize(model, pluginConfig),
        ),
      }),
      // GenieX needs no credential; the marker keeps the generic auth plumbing
      // satisfied without persisting a fake secret.
      apiKey: apiKey ?? CUSTOM_LOCAL_AUTH_MARKER,
    },
  };
}

/** Interactive `openclaw configure` path for a self-hosted GenieX endpoint. */
export async function promptAndConfigureGenieXInteractive(params: {
  config: Parameters<typeof promptAndConfigureOpenAICompatibleSelfHostedProviderAuth>[0]["cfg"];
  prompter: Parameters<typeof promptAndConfigureOpenAICompatibleSelfHostedProviderAuth>[0]["prompter"];
}): Promise<ProviderAuthResult> {
  return await promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
    cfg: params.config,
    prompter: params.prompter,
    providerId: GENIEX_PROVIDER_ID,
    providerLabel: GENIEX_PROVIDER_LABEL,
    defaultBaseUrl: GENIEX_DEFAULT_BASE_URL,
    defaultApiKeyEnvVar: GENIEX_DEFAULT_API_KEY_ENV_VAR,
    modelPlaceholder: GENIEX_MODEL_PLACEHOLDER,
  });
}

/** Non-interactive (`--yes`) configuration path. */
export async function configureGenieXNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
) {
  return await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx,
    providerId: GENIEX_PROVIDER_ID,
    providerLabel: GENIEX_PROVIDER_LABEL,
    defaultBaseUrl: GENIEX_DEFAULT_BASE_URL,
    defaultApiKeyEnvVar: GENIEX_DEFAULT_API_KEY_ENV_VAR,
    modelPlaceholder: GENIEX_MODEL_PLACEHOLDER,
  });
}
