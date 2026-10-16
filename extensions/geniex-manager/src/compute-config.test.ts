// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { hasPrecisionOverride, readModelCompute, setModelCompute } from "./compute-config.js";

function withModels(models: Record<string, object> | undefined, extra?: object): OpenClawConfig {
  return {
    plugins: { entries: { geniex: { enabled: true, config: { models, ...extra } } } },
  } as unknown as OpenClawConfig;
}

function modelsOf(cfg: OpenClawConfig | null) {
  return (cfg?.plugins?.entries?.geniex?.config as { models?: Record<string, object> })?.models;
}

describe("setModelCompute", () => {
  it("creates the plugin entry on a config that has none", () => {
    const next = setModelCompute({} as OpenClawConfig, "a/b", "gpu");
    expect(modelsOf(next)).toEqual({ "a/b": { compute: "gpu" } });
  });

  it("only touches compute, keeping the model's other settings", () => {
    const cfg = withModels({ "a/b": { compute: "cpu", contextSize: 8192, specDraftModel: "c/d" } });
    const next = setModelCompute(cfg, "a/b", "npu");
    expect(modelsOf(next)?.["a/b"]).toEqual({
      compute: "npu",
      contextSize: 8192,
      specDraftModel: "c/d",
    });
  });

  it("keeps sibling models and unrelated plugin config", () => {
    const cfg = withModels({ "x/y": { compute: "cpu" } }, { includeModels: ["m/n"] });
    const next = setModelCompute(cfg, "a/b", "gpu");
    expect(modelsOf(next)).toEqual({ "x/y": { compute: "cpu" }, "a/b": { compute: "gpu" } });
    expect((next?.plugins?.entries?.geniex?.config as { includeModels?: string[] }).includeModels)
      .toEqual(["m/n"]);
  });

  it("does not mutate the input config", () => {
    const cfg = withModels({ "a/b": { compute: "cpu" } });
    setModelCompute(cfg, "a/b", "gpu");
    expect(modelsOf(cfg)?.["a/b"]).toEqual({ compute: "cpu" });
  });

  it("clears to default, dropping the entry only when it held nothing else", () => {
    const alone = setModelCompute(withModels({ "a/b": { compute: "gpu" } }), "a/b", undefined);
    expect(modelsOf(alone)).toEqual({});

    const shared = setModelCompute(
      withModels({ "a/b": { compute: "gpu", contextSize: 8192 } }),
      "a/b",
      undefined,
    );
    expect(modelsOf(shared)?.["a/b"]).toEqual({ contextSize: 8192 });
  });

  it("returns null when nothing would change", () => {
    expect(setModelCompute(withModels({ "a/b": { compute: "gpu" } }), "a/b", "gpu")).toBeNull();
    expect(setModelCompute({} as OpenClawConfig, "a/b", undefined)).toBeNull();
  });
});

describe("readModelCompute / hasPrecisionOverride", () => {
  it("reads the bare-name unit and ignores invalid values", () => {
    expect(readModelCompute(withModels({ "a/b": { compute: "GPU" } }), "a/b")).toBe("gpu");
    expect(readModelCompute(withModels({ "a/b": { compute: "tpu" } }), "a/b")).toBeUndefined();
    expect(readModelCompute({} as OpenClawConfig, "a/b")).toBeUndefined();
  });

  it("flags a hand-written name:precision entry that would win", () => {
    const cfg = withModels({ "a/b:Q4_0": { compute: "cpu" } });
    expect(hasPrecisionOverride(cfg, "a/b")).toBe(true);
    expect(hasPrecisionOverride(cfg, "a/c")).toBe(false);
    expect(hasPrecisionOverride(withModels({ "a/b:Q4_0": { contextSize: 1 } }), "a/b")).toBe(false);
  });
});
