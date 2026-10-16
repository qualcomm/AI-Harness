// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { normalizeGenieXManagerPluginConfig } from "./config.js";

describe("normalizeGenieXManagerPluginConfig", () => {
  it("normalizes serve settings", () => {
    const config = normalizeGenieXManagerPluginConfig({
      serve: { mode: "NEVER", host: " 127.0.0.1:19000 ", compute: "CPU", keepAliveSeconds: 120 },
    });
    expect(config.serve).toEqual({
      mode: "never",
      host: "127.0.0.1:19000",
      compute: "cpu",
      keepAliveSeconds: 120,
    });
  });

  it("keeps keepAliveSeconds 0, which unloads as soon as idle", () => {
    expect(normalizeGenieXManagerPluginConfig({ serve: { keepAliveSeconds: 0 } }).serve).toEqual({
      keepAliveSeconds: 0,
    });
  });

  it("drops invalid serve values instead of forwarding them", () => {
    expect(
      normalizeGenieXManagerPluginConfig({
        serve: { mode: "sometimes", compute: "tpu", keepAliveSeconds: -1 },
      }).serve,
    ).toBeUndefined();
  });

  it("tolerates a missing or malformed config bag", () => {
    expect(normalizeGenieXManagerPluginConfig(undefined)).toEqual({});
    expect(normalizeGenieXManagerPluginConfig("nonsense")).toEqual({});
    expect(normalizeGenieXManagerPluginConfig([])).toEqual({});
  });
});
