// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  normalizeGenieXPluginConfig,
  resolveGenieXModelSettings,
  stripGenieXProviderPrefix,
} from "./config.js";

describe("normalizeGenieXPluginConfig", () => {
  it("normalizes per-model settings", () => {
    const config = normalizeGenieXPluginConfig({
      models: {
        "unsloth/gpt-oss-20b-GGUF:F16": { compute: "CPU", contextSize: 8192, gpuLayers: 0 },
      },
    });
    expect(config.models?.["unsloth/gpt-oss-20b-GGUF:F16"]).toEqual({
      compute: "cpu",
      contextSize: 8192,
      gpuLayers: 0,
    });
  });

  it("normalizes MTP settings and drops them when no draft model is given", () => {
    const config = normalizeGenieXPluginConfig({
      models: {
        "a/target": {
          specDraftModel: "  b/draft:Q4_0 ",
          specDraftTokens: 3.7,
          specDraftPMin: 0.4,
        },
        "c/orphan": { specDraftTokens: 3, specDraftPMin: 2 },
      },
    });
    expect(config.models?.["a/target"]).toEqual({
      specDraftModel: "b/draft:Q4_0",
      specDraftTokens: 3,
      specDraftPMin: 0.4,
    });
    expect(config.models?.["c/orphan"]).toBeUndefined();
  });

  it("keeps ngl -1, which means all layers", () => {
    const config = normalizeGenieXPluginConfig({
      models: { "qualcomm/Qwen3-4B": { gpuLayers: -1 } },
    });
    expect(config.models?.["qualcomm/Qwen3-4B"]?.gpuLayers).toBe(-1);
  });

  it("drops invalid values rather than passing them to GenieX", () => {
    const config = normalizeGenieXPluginConfig({
      models: {
        "a/b": { compute: "tpu" },
        "c/d": { contextSize: 0 },
        "e/f": { gpuLayers: -5 },
      },
    });
    expect(config.models).toBeUndefined();
  });

  it("ignores blank model keys", () => {
    const config = normalizeGenieXPluginConfig({ models: { "   ": { compute: "cpu" } } });
    expect(config.models).toBeUndefined();
  });

  it("normalizes includeModels and drops blanks", () => {
    const config = normalizeGenieXPluginConfig({
      includeModels: ["  ggml-org/bge-m3-Q8_0-GGUF  ", "", 42],
    });
    expect(config.includeModels).toEqual(["ggml-org/bge-m3-Q8_0-GGUF"]);
  });

  it("tolerates a missing or malformed config bag", () => {
    expect(normalizeGenieXPluginConfig(undefined)).toEqual({});
    expect(normalizeGenieXPluginConfig("nonsense")).toEqual({});
    expect(normalizeGenieXPluginConfig([])).toEqual({});
  });
});

describe("resolveGenieXModelSettings", () => {
  const config = normalizeGenieXPluginConfig({
    models: {
      "unsloth/gpt-oss-20b-GGUF": { compute: "npu" },
      "unsloth/gpt-oss-20b-GGUF:F16": { compute: "cpu" },
      "qualcomm/Qwen3-4B": { compute: "gpu" },
    },
  });

  it("prefers an exact name:precision match", () => {
    expect(
      resolveGenieXModelSettings({ config, modelId: "unsloth/gpt-oss-20b-GGUF:F16" })?.compute,
    ).toBe("cpu");
  });

  it("falls back to the bare-name entry for another precision", () => {
    expect(
      resolveGenieXModelSettings({ config, modelId: "unsloth/gpt-oss-20b-GGUF:Q4_0" })?.compute,
    ).toBe("npu");
  });

  it("matches a bare-name entry when no precision is given", () => {
    expect(resolveGenieXModelSettings({ config, modelId: "qualcomm/Qwen3-4B" })?.compute).toBe(
      "gpu",
    );
  });

  it("strips a qualified provider prefix", () => {
    expect(
      resolveGenieXModelSettings({ config, modelId: "geniex/qualcomm/Qwen3-4B" })?.compute,
    ).toBe("gpu");
  });

  it("returns undefined for an unconfigured model", () => {
    expect(resolveGenieXModelSettings({ config, modelId: "qualcomm/Qwen3-8B" })).toBeUndefined();
  });

  it("returns undefined when nothing is configured", () => {
    expect(
      resolveGenieXModelSettings({ config: {}, modelId: "qualcomm/Qwen3-4B" }),
    ).toBeUndefined();
  });
});

describe("stripGenieXProviderPrefix", () => {
  it("removes only a leading geniex/ segment", () => {
    expect(stripGenieXProviderPrefix("geniex/qualcomm/Qwen3-4B")).toBe("qualcomm/Qwen3-4B");
    expect(stripGenieXProviderPrefix("qualcomm/Qwen3-4B")).toBe("qualcomm/Qwen3-4B");
  });
});
