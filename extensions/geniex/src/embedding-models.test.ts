// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { excludeEmbeddingModels, isLikelyEmbeddingModel } from "./embedding-models.js";

describe("isLikelyEmbeddingModel", () => {
  it("flags the bge model GenieX mislabels as an llm", () => {
    expect(isLikelyEmbeddingModel({ modelId: "ggml-org/bge-m3-Q8_0-GGUF" })).toBe(true);
  });

  it("flags common embedding families", () => {
    for (const modelId of [
      "nomic-ai/nomic-embed-text-v1.5-GGUF",
      "intfloat/e5-large-v2",
      "thenlper/gte-base",
      "jinaai/jina-embeddings-v3",
      "sentence-transformers/all-MiniLM-L6-v2",
      "text-embedding-3-small",
    ]) {
      expect(isLikelyEmbeddingModel({ modelId })).toBe(true);
    }
  });

  it("leaves chat models alone", () => {
    for (const modelId of [
      "qualcomm/Qwen3-4B-Instruct-2507",
      "qualcomm/Qwen2.5-VL-7B-Instruct",
      "qualcomm/qwen3_vl_8b_instruct",
      "unsloth/gpt-oss-20b-GGUF",
      "qualcomm/Llama-v3.2-3B-Instruct",
      "qualcomm/Phi-3.5-Mini-Instruct",
      "qualcomm/Gemma-4-E4B-it",
    ]) {
      expect(isLikelyEmbeddingModel({ modelId })).toBe(false);
    }
  });

  it("honours the allow list over the name patterns", () => {
    expect(
      isLikelyEmbeddingModel({
        modelId: "ggml-org/bge-m3-Q8_0-GGUF",
        allowList: ["ggml-org/bge-m3-Q8_0-GGUF"],
      }),
    ).toBe(false);
  });

  it("matches the allow list case-insensitively", () => {
    expect(
      isLikelyEmbeddingModel({
        modelId: "ggml-org/bge-m3-Q8_0-GGUF",
        allowList: ["GGML-ORG/BGE-M3-Q8_0-GGUF"],
      }),
    ).toBe(false);
  });

  it("returns false for a blank id", () => {
    expect(isLikelyEmbeddingModel({ modelId: "   " })).toBe(false);
  });
});

describe("excludeEmbeddingModels", () => {
  it("filters in place without reordering the survivors", () => {
    const models = [
      { id: "qualcomm/Qwen3-4B" },
      { id: "ggml-org/bge-m3-Q8_0-GGUF" },
      { id: "unsloth/gpt-oss-20b-GGUF" },
    ];
    expect(excludeEmbeddingModels({ models }).map((model) => model.id)).toEqual([
      "qualcomm/Qwen3-4B",
      "unsloth/gpt-oss-20b-GGUF",
    ]);
  });
});
