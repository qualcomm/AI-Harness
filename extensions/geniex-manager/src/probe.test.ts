// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { resolveGenieXInferenceBase } from "./probe.js";

describe("resolveGenieXInferenceBase", () => {
  it("defaults to the documented serve address", () => {
    expect(resolveGenieXInferenceBase(undefined)).toBe("http://127.0.0.1:18181/v1");
    expect(resolveGenieXInferenceBase("  ")).toBe("http://127.0.0.1:18181/v1");
  });

  it("appends /v1 when the user supplies only the host", () => {
    expect(resolveGenieXInferenceBase("http://127.0.0.1:18181")).toBe("http://127.0.0.1:18181/v1");
  });

  it("leaves an existing /v1 suffix alone", () => {
    expect(resolveGenieXInferenceBase("http://127.0.0.1:18181/v1")).toBe(
      "http://127.0.0.1:18181/v1",
    );
  });

  it("strips trailing slashes before deciding", () => {
    expect(resolveGenieXInferenceBase("http://127.0.0.1:18181/v1/")).toBe(
      "http://127.0.0.1:18181/v1",
    );
    expect(resolveGenieXInferenceBase("http://127.0.0.1:18181//")).toBe(
      "http://127.0.0.1:18181/v1",
    );
  });
});

// probeGenieXServer itself just wraps fetch with a timeout; its true/false
// branches are exercised indirectly through serve-process.test.ts and this
// plugin's manual verification against a real `geniex serve` (no network
// mocking is worth the brittleness for a two-branch HTTP GET).
