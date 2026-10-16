// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  computeUnitsForRuntime,
  isComputeUnitSelectable,
  normalizeGenieXComputeUnit,
  shouldSendComputeUnit,
} from "./compute.js";

describe("computeUnitsForRuntime", () => {
  it("restricts qairt models to the NPU", () => {
    expect(computeUnitsForRuntime("qairt")).toEqual(["npu"]);
  });

  it("offers every unit for llama_cpp models", () => {
    expect(computeUnitsForRuntime("llama_cpp")).toEqual(["cpu", "gpu", "npu", "hybrid"]);
  });

  it("normalizes runtime casing and padding", () => {
    expect(computeUnitsForRuntime("  QAIRT ")).toEqual(["npu"]);
  });

  it("falls back to the flexible set for an unknown runtime", () => {
    // A future GenieX runtime is more likely device-flexible than NPU-pinned,
    // and an empty list would silently strip a configured compute unit.
    expect(computeUnitsForRuntime("some_future_runtime")).toEqual([
      "cpu",
      "gpu",
      "npu",
      "hybrid",
    ]);
    expect(computeUnitsForRuntime(undefined)).toEqual(["cpu", "gpu", "npu", "hybrid"]);
  });
});

describe("isComputeUnitSelectable", () => {
  it("is false for qairt and true for llama_cpp", () => {
    expect(isComputeUnitSelectable("qairt")).toBe(false);
    expect(isComputeUnitSelectable("llama_cpp")).toBe(true);
  });
});

describe("normalizeGenieXComputeUnit", () => {
  it("accepts the documented aliases case-insensitively", () => {
    expect(normalizeGenieXComputeUnit("NPU")).toBe("npu");
    expect(normalizeGenieXComputeUnit(" gpu ")).toBe("gpu");
    expect(normalizeGenieXComputeUnit("hybrid")).toBe("hybrid");
  });

  it("rejects unknown or non-string values", () => {
    expect(normalizeGenieXComputeUnit("tpu")).toBeUndefined();
    expect(normalizeGenieXComputeUnit("")).toBeUndefined();
    expect(normalizeGenieXComputeUnit(42)).toBeUndefined();
    expect(normalizeGenieXComputeUnit(undefined)).toBeUndefined();
  });
});

describe("shouldSendComputeUnit", () => {
  it("sends a configured unit for llama_cpp models", () => {
    expect(shouldSendComputeUnit({ runtimeId: "llama_cpp", computeUnit: "cpu" })).toBe(true);
  });

  it("suppresses the unit for qairt models", () => {
    // GenieX coerces any non-NPU value back to NPU and logs a warning on every
    // request, so sending it is pure log noise.
    expect(shouldSendComputeUnit({ runtimeId: "qairt", computeUnit: "gpu" })).toBe(false);
    expect(shouldSendComputeUnit({ runtimeId: "qairt", computeUnit: "npu" })).toBe(false);
  });

  it("sends nothing when no unit is configured", () => {
    expect(shouldSendComputeUnit({ runtimeId: "llama_cpp", computeUnit: undefined })).toBe(false);
  });
});
