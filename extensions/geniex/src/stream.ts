// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Injects GenieX's per-request model-load knobs into the outbound payload.
 *
 * `compute`, `nctx`, and `ngl` are request-body fields on
 * `/v1/chat/completions` (GenieX `cli/server/handler/chat.go`). The handler
 * prefills them from the `geniex serve` flags and then lets `ShouldBindJSON`
 * overwrite only the fields present in the body, so an omitted knob keeps the
 * server default and an explicit one wins. That is what makes per-model compute
 * work against a single long-running `geniex serve`.
 *
 * Changing a knob changes the `ModelParam` that GenieX's keep-alive cache keys
 * on, so the next request destroys the cached model and reloads it with the new
 * device. Only one model stays resident at a time, so switching is correct but
 * not free.
 *
 * Runtime gating is intentionally *not* done here: `GET /v1/models` does not
 * report a model's runtime, and guessing it from the id would be wrong. The
 * Local Models surface only offers a compute choice for `llama_cpp` models, so
 * a configured value is taken at face value. A hand-edited config that sets
 * compute on a `qairt` model is coerced back to NPU by GenieX with a warning
 * rather than failing.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  type GenieXModelSettings,
  type GenieXPluginConfig,
  resolveGenieXModelSettings,
} from "./config.js";
import { GENIEX_PROVIDER_ID } from "./defaults.js";

/**
 * Applies resolved settings onto an outbound request payload.
 *
 * `reasoning_format` is always sent: by default `geniex serve` leaves a
 * thinking model's chain-of-thought inline in `content` (Gemma 4 emits
 * `<|channel>thought ...<channel|>`, which no downstream tag parser knows), so
 * it would be shown to the user verbatim. `deepseek` makes the server move it
 * into `reasoning_content`, which the OpenAI transport already turns into a
 * thinking block. Models that do not think are unaffected.
 */
export function applyGenieXModelSettingsToPayload(params: {
  payload: Record<string, unknown>;
  settings: GenieXModelSettings | undefined;
}): void {
  const { payload, settings } = params;
  payload.reasoning_format ??= "deepseek";
  if (!settings) {
    return;
  }
  if (settings.compute) {
    payload.compute = settings.compute;
  }
  if (settings.contextSize !== undefined) {
    payload.nctx = settings.contextSize;
  }
  if (settings.gpuLayers !== undefined) {
    payload.ngl = settings.gpuLayers;
  }
  // The spec_* fields are part of GenieX's model cache key, so they must be sent
  // identically on every request or each one reloads the model.
  if (settings.specDraftModel) {
    payload.spec_type = "draft-mtp";
    payload.spec_draft_model = settings.specDraftModel;
    if (settings.specDraftTokens !== undefined) {
      payload.spec_n_max = settings.specDraftTokens;
    }
    if (settings.specDraftMin !== undefined) {
      payload.spec_n_min = settings.specDraftMin;
    }
    if (settings.specDraftPMin !== undefined) {
      payload.spec_p_min = settings.specDraftPMin;
    }
  }
}

/**
 * Wraps the stream fn so GenieX requests carry the model's configured load
 * settings and separated reasoning output.
 */
export function wrapGenieXModelLoadOptions(params: {
  ctx: ProviderWrapStreamFnContext;
  /**
   * Read per request, not captured once: the Local Models tab edits this config
   * while the gateway runs, and the wrapped stream fn outlives those edits.
   */
  getPluginConfig: () => GenieXPluginConfig;
}): StreamFn {
  const underlying = params.ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== GENIEX_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const settings = resolveGenieXModelSettings({
      config: params.getPluginConfig(),
      modelId: model.id,
    });
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      applyGenieXModelSettingsToPayload({ payload, settings });
    });
  };
}
