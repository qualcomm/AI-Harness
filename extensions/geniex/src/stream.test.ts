// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { normalizeGenieXPluginConfig } from "./config.js";
import { applyGenieXModelSettingsToPayload, wrapGenieXModelLoadOptions } from "./stream.js";

describe("applyGenieXModelSettingsToPayload", () => {
  it("writes the request-body knobs GenieX reads", () => {
    const payload: Record<string, unknown> = {};
    applyGenieXModelSettingsToPayload({
      payload,
      settings: { compute: "cpu", contextSize: 8192, gpuLayers: 0 },
    });
    expect(payload).toEqual({
      reasoning_format: "deepseek",
      compute: "cpu",
      nctx: 8192,
      ngl: 0,
    });
  });

  it("omits knobs that are not configured, so serve defaults survive", () => {
    // GenieX prefills each field from its --compute/--nctx/--ngl flags and only
    // overwrites what the body actually contains.
    const payload: Record<string, unknown> = {};
    applyGenieXModelSettingsToPayload({ payload, settings: { compute: "npu" } });
    expect(payload).toEqual({ reasoning_format: "deepseek", compute: "npu" });
  });

  it("enables MTP speculative decoding only when a draft model is set", () => {
    const payload: Record<string, unknown> = {};
    applyGenieXModelSettingsToPayload({
      payload,
      settings: {
        specDraftModel: "org/draft:Q4_0",
        specDraftTokens: 3,
        specDraftMin: 1,
        specDraftPMin: 0.5,
      },
    });
    expect(payload).toEqual({
      reasoning_format: "deepseek",
      spec_type: "draft-mtp",
      spec_draft_model: "org/draft:Q4_0",
      spec_n_max: 3,
      spec_n_min: 1,
      spec_p_min: 0.5,
    });

    const plain: Record<string, unknown> = {};
    applyGenieXModelSettingsToPayload({ payload: plain, settings: { compute: "cpu" } });
    expect(plain).not.toHaveProperty("spec_type");
  });

  it("writes ngl 0, which means pure CPU rather than 'unset'", () => {
    const payload: Record<string, unknown> = {};
    applyGenieXModelSettingsToPayload({ payload, settings: { gpuLayers: 0 } });
    expect(payload).toEqual({ reasoning_format: "deepseek", ngl: 0 });
  });
});

type CapturedCall = {
  modelId: string;
  payload: Record<string, unknown> | undefined;
};

/**
 * Minimal stand-in for the core stream fn: runs the `onPayload` hook the way
 * `streamWithPayloadPatch` expects and records what it produced.
 */
function createCapturingStreamFn(calls: CapturedCall[]) {
  return ((model: { id: string }, _context: unknown, options?: Record<string, unknown>) => {
    const payload: Record<string, unknown> = { model: model.id, messages: [] };
    const onPayload = options?.onPayload as
      | ((payload: unknown, model: unknown) => unknown)
      | undefined;
    onPayload?.(payload, model);
    calls.push({ modelId: model.id, payload });
    return undefined as never;
  }) as never;
}

function runWrapped(params: {
  pluginConfigRaw: unknown;
  model: { id: string; provider: string };
}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const streamFn = createCapturingStreamFn(calls);
  const wrapped = wrapGenieXModelLoadOptions({
    ctx: {
      provider: "geniex",
      modelId: params.model.id,
      streamFn,
    } as never,
    getPluginConfig: () => normalizeGenieXPluginConfig(params.pluginConfigRaw),
  });
  // The fake stream fn runs `onPayload` synchronously and returns nothing, so
  // there is no stream to consume — `void` documents that the declared
  // StreamFn promise is intentionally dropped.
  void wrapped(params.model as never, [] as never, {} as never);
  return calls;
}

describe("wrapGenieXModelLoadOptions", () => {
  it("injects the configured compute unit into the outbound payload", () => {
    const calls = runWrapped({
      pluginConfigRaw: { models: { "unsloth/gpt-oss-20b-GGUF:F16": { compute: "cpu" } } },
      model: { id: "unsloth/gpt-oss-20b-GGUF:F16", provider: "geniex" },
    });
    expect(calls[0]?.payload?.compute).toBe("cpu");
  });

  it("still separates reasoning when the model has no settings", () => {
    const calls = runWrapped({
      pluginConfigRaw: { models: { "qualcomm/Qwen3-4B": { compute: "gpu" } } },
      model: { id: "unsloth/gpt-oss-20b-GGUF:F16", provider: "geniex" },
    });
    expect(calls[0]?.payload).toEqual({
      model: "unsloth/gpt-oss-20b-GGUF:F16",
      messages: [],
      reasoning_format: "deepseek",
    });
  });

  it("sees config edited after the stream fn was wrapped", () => {
    // The Local Models tab rewrites this config while the gateway keeps running,
    // and the wrapped fn lives for the whole process.
    const calls: CapturedCall[] = [];
    let raw: unknown = { models: { "a/b": { compute: "cpu" } } };
    const wrapped = wrapGenieXModelLoadOptions({
      ctx: {
        provider: "geniex",
        modelId: "a/b",
        streamFn: createCapturingStreamFn(calls),
      } as never,
      getPluginConfig: () => normalizeGenieXPluginConfig(raw),
    });
    const model = { id: "a/b", provider: "geniex" } as never;

    void wrapped(model, [] as never, {} as never);
    raw = { models: { "a/b": { compute: "gpu" } } };
    void wrapped(model, [] as never, {} as never);

    expect(calls.map((call) => call.payload?.compute)).toEqual(["cpu", "gpu"]);
  });

  it("ignores models from other providers", () => {
    const calls = runWrapped({
      pluginConfigRaw: { models: { "qualcomm/Qwen3-4B": { compute: "gpu" } } },
      model: { id: "qualcomm/Qwen3-4B", provider: "lmstudio" },
    });
    expect(calls[0]?.payload?.compute).toBeUndefined();
    expect(calls[0]?.payload).not.toHaveProperty("reasoning_format");
  });

  it("applies a bare-name setting to a precision-qualified model", () => {
    const calls = runWrapped({
      pluginConfigRaw: { models: { "unsloth/gpt-oss-20b-GGUF": { compute: "npu" } } },
      model: { id: "unsloth/gpt-oss-20b-GGUF:F16", provider: "geniex" },
    });
    expect(calls[0]?.payload?.compute).toBe("npu");
  });

  it("separates reasoning even when nothing at all is configured", () => {
    const calls = runWrapped({
      pluginConfigRaw: {},
      model: { id: "qualcomm/Qwen3-4B", provider: "geniex" },
    });
    expect(calls[0]?.payload).toEqual({
      model: "qualcomm/Qwen3-4B",
      messages: [],
      reasoning_format: "deepseek",
    });
  });
});
