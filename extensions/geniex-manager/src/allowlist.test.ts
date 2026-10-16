// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { addGenieXModelsToAllowlist, removeGenieXModelFromAllowlist } from "./allowlist.js";

function withModels(models: Record<string, object> | undefined): OpenClawConfig {
  return { agents: { defaults: { models } } } as OpenClawConfig;
}

describe("addGenieXModelsToAllowlist", () => {
  it("leaves an empty allowlist alone, since empty means allow-all", () => {
    expect(addGenieXModelsToAllowlist(withModels({}), ["qualcomm/Qwen3-0.6B"])).toBeNull();
    expect(addGenieXModelsToAllowlist(withModels(undefined), ["qualcomm/Qwen3-0.6B"])).toBeNull();
  });

  it("adds new models without touching existing entries or the input", () => {
    const cfg = withModels({ "deepseek/deepseek-v4-pro": { alias: "pro" } });
    const next = addGenieXModelsToAllowlist(cfg, ["qualcomm/Qwen3-0.6B"]);
    expect(next?.agents?.defaults?.models).toEqual({
      "deepseek/deepseek-v4-pro": { alias: "pro" },
      "geniex/qualcomm/Qwen3-0.6B": {},
    });
    expect(Object.keys(cfg.agents!.defaults!.models!)).toHaveLength(1);
  });

  it("skips models configured as an MTP draft, whatever their precision", () => {
    const cfg = {
      agents: { defaults: { models: { "deepseek/deepseek-v4-pro": {} } } },
      plugins: {
        entries: {
          geniex: {
            config: { models: { "a/target": { specDraftModel: "b/Draft-GGUF:Q4_0" } } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(addGenieXModelsToAllowlist(cfg, ["b/draft-gguf:Q4_0"])).toBeNull();
    const next = addGenieXModelsToAllowlist(cfg, ["b/draft-gguf:Q4_0", "a/target"]);
    expect(Object.keys(next?.agents?.defaults?.models ?? {})).toEqual([
      "deepseek/deepseek-v4-pro",
      "geniex/a/target",
    ]);
  });

  it("is a no-op when every model is already allowlisted", () => {
    const cfg = withModels({ "geniex/qualcomm/Qwen3-0.6B": { alias: "q" } });
    expect(addGenieXModelsToAllowlist(cfg, ["qualcomm/Qwen3-0.6B"])).toBeNull();
  });
});

describe("removeGenieXModelFromAllowlist", () => {
  it("removes the entry regardless of precision suffix or case", () => {
    const cfg = withModels({
      "geniex/qualcomm/Qwen3-0.6B": {},
      "geniex/qualcomm/Qwen3-0.6B:Q4_0": {},
      "geniex/qualcomm/Other": {},
    });
    const next = removeGenieXModelFromAllowlist(cfg, "qualcomm/qwen3-0.6b");
    expect(Object.keys(next?.agents?.defaults?.models ?? {})).toEqual(["geniex/qualcomm/Other"]);
  });

  it("ignores other providers and returns null when nothing matches", () => {
    const cfg = withModels({ "deepseek/qualcomm/Qwen3-0.6B": {} });
    expect(removeGenieXModelFromAllowlist(cfg, "qualcomm/Qwen3-0.6B")).toBeNull();
  });
});
