// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import OpenAI from "openai";

export type VideoChaptersEmbeddingsConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
};

/**
 * Defaults point at a local `llama-server --embedding` instance (verified 2026-09-08 with
 * ggml-org/bge-m3-Q8_0-GGUF, which returns 1024-dim vectors). Any OpenAI-compatible
 * embeddings endpoint works; override via plugins.entries.video-chapters.config.embeddings.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:8899/v1";
const DEFAULT_MODEL = "bge-m3";
const DEFAULT_DIMENSIONS = 1024;

type RawEmbeddingsConfig = {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  dimensions?: unknown;
};

export function resolveVideoChaptersEmbeddingsConfig(
  raw: RawEmbeddingsConfig | undefined,
): VideoChaptersEmbeddingsConfig {
  return {
    baseUrl: typeof raw?.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : DEFAULT_BASE_URL,
    apiKey: typeof raw?.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : "video-chapters",
    model: typeof raw?.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    dimensions:
      typeof raw?.dimensions === "number" && Number.isFinite(raw.dimensions) && raw.dimensions > 0
        ? Math.floor(raw.dimensions)
        : DEFAULT_DIMENSIONS,
  };
}

export async function embedText(text: string, config: VideoChaptersEmbeddingsConfig): Promise<number[]> {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  const response = await client.embeddings.create({ model: config.model, input: text });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error("embeddings endpoint returned no vector");
  }
  return embedding;
}
