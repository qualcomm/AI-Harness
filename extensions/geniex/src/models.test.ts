// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  isGenieXVisionModel,
  mapGenieXWireModelsToConfig,
  resolveGenieXInferenceBase,
} from "./models.js";

/**
 * Models cached on a Snapdragon X2 Elite host, with `model_type` already
 * backfilled by `discoverGenieXModels` from the per-model detail endpoint.
 * `GET /v1/models` itself omits `model_type` (see the module comment).
 */
const WIRE_MODELS = [
  { id: "ggml-org/bge-m3-Q8_0-GGUF:Q8_0", owned_by: "ggml-org", model_type: "llm" },
  { id: "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16", owned_by: "qualcomm", model_type: "vlm" },
  { id: "qualcomm/Qwen3-4B-Instruct-2507:W4A16", owned_by: "qualcomm", model_type: "llm" },
  { id: "qualcomm/qwen3_vl_8b_instruct:W4A16", owned_by: "qualcomm", model_type: "vlm" },
  { id: "unsloth/gpt-oss-20b-GGUF:F16", owned_by: "unsloth", model_type: "llm" },
];

describe("mapGenieXWireModelsToConfig", () => {
  it("keeps chat models and drops the embedding model", () => {
    const models = mapGenieXWireModelsToConfig({ models: WIRE_MODELS });
    expect(models.map((model) => model.id)).toEqual([
      "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16",
      "qualcomm/Qwen3-4B-Instruct-2507:W4A16",
      "qualcomm/qwen3_vl_8b_instruct:W4A16",
      "unsloth/gpt-oss-20b-GGUF:F16",
    ]);
  });

  it("marks VLM entries as accepting image input", () => {
    const models = mapGenieXWireModelsToConfig({ models: WIRE_MODELS });
    const vlm = models.find((model) => model.id === "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16");
    expect(vlm?.input).toEqual(["text", "image"]);
  });

  it("keeps LLM entries text-only", () => {
    const models = mapGenieXWireModelsToConfig({ models: WIRE_MODELS });
    const llm = models.find((model) => model.id === "unsloth/gpt-oss-20b-GGUF:F16");
    expect(llm?.input).toEqual(["text"]);
  });

  it("treats a model with no reported type as text-only", () => {
    // `GET /v1/models` omits model_type; when the detail lookup also fails we
    // under-report a VLM rather than promise image support that may not work.
    const models = mapGenieXWireModelsToConfig({
      models: [{ id: "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16", owned_by: "qualcomm" }],
    });
    expect(models[0]?.input).toEqual(["text"]);
  });

  it("restores an excluded model when it is explicitly allowed", () => {
    const models = mapGenieXWireModelsToConfig({
      models: WIRE_MODELS,
      includeModels: ["ggml-org/bge-m3-Q8_0-GGUF:Q8_0"],
    });
    expect(models.map((model) => model.id)).toContain("ggml-org/bge-m3-Q8_0-GGUF:Q8_0");
  });

  it("skips entries with a missing or blank id", () => {
    const models = mapGenieXWireModelsToConfig({
      models: [{ model_type: "llm" }, { id: "   ", model_type: "llm" }, { id: "qualcomm/Qwen3-4B" }],
    });
    expect(models.map((model) => model.id)).toEqual(["qualcomm/Qwen3-4B"]);
  });

  it("does not guess reasoning support from the model name", () => {
    // GenieX exposes no reasoning metadata, so claiming support would be a lie.
    const models = mapGenieXWireModelsToConfig({
      models: [{ id: "qualcomm/Qwen3-4B", model_type: "llm" }],
    });
    expect(models[0]?.reasoning).toBe(false);
  });

  it("requests streaming usage, which GenieX supports", () => {
    const models = mapGenieXWireModelsToConfig({
      models: [{ id: "qualcomm/Qwen3-4B", model_type: "llm" }],
    });
    expect(models[0]?.compat?.supportsUsageInStreaming).toBe(true);
  });
});

describe("isGenieXVisionModel", () => {
  it("reads the model_type extension case-insensitively", () => {
    expect(isGenieXVisionModel({ model_type: "vlm" })).toBe(true);
    expect(isGenieXVisionModel({ model_type: "VLM" })).toBe(true);
    expect(isGenieXVisionModel({ model_type: "llm" })).toBe(false);
    expect(isGenieXVisionModel({})).toBe(false);
  });
});

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
