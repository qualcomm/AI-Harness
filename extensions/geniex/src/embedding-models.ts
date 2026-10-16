// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Embedding-model detection for the GenieX chat catalog.
 *
 * GenieX reports every non-VLM model as `model_type: "llm"` — including
 * sentence-embedding models such as `ggml-org/bge-m3-Q8_0-GGUF` — and
 * `geniex serve` exposes no `/v1/embeddings` route (see GenieX
 * `cli/server/route.go`). An embedding model that reaches the chat model
 * picker can therefore only fail at inference time.
 *
 * There is no reliable signal to separate the two: the GGUF architecture field
 * would say `bert` / `xlm-roberta`, but GenieX does not surface it. Name
 * matching is the only option available, so it is kept here as an explicit,
 * testable list rather than scattered inline checks. Users can override a false
 * positive via `models.providers.geniex.includeModels`.
 */

/**
 * Substrings that mark a model as embedding-only. Matched case-insensitively
 * against the model id. Kept deliberately narrow — a false positive hides a
 * usable chat model, which is worse than letting an embedding model through.
 */
const EMBEDDING_NAME_PATTERNS: readonly string[] = [
  "bge-",
  "bge_",
  "e5-",
  "gte-",
  "jina-embed",
  "nomic-embed",
  "text-embedding",
  "all-minilm",
  "gist-embed",
  "stella_en",
];

/** Exact substrings that are decisive regardless of separators. */
const EMBEDDING_KEYWORDS: readonly string[] = ["embedding", "embed-text", "-embeddings"];

/**
 * Whether `modelId` looks like an embedding-only model.
 *
 * `allowList` entries (already-normalized model ids from
 * `models.providers.geniex.includeModels`) always win, so a misclassified model
 * can be forced back into the catalog without a code change.
 */
export function isLikelyEmbeddingModel(params: {
  modelId: string;
  allowList?: readonly string[];
}): boolean {
  const modelId = params.modelId.trim().toLowerCase();
  if (!modelId) {
    return false;
  }
  const allowed = params.allowList?.some((entry) => entry.trim().toLowerCase() === modelId);
  if (allowed) {
    return false;
  }
  if (EMBEDDING_KEYWORDS.some((keyword) => modelId.includes(keyword))) {
    return true;
  }
  return EMBEDDING_NAME_PATTERNS.some((pattern) => modelId.includes(pattern));
}

/** Filters embedding models out of a chat-facing model list. */
export function excludeEmbeddingModels<T extends { id: string }>(params: {
  models: readonly T[];
  allowList?: readonly string[];
}): T[] {
  return params.models.filter(
    (model) => !isLikelyEmbeddingModel({ modelId: model.id, allowList: params.allowList }),
  );
}
