// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  buildAssistantMessage,
  buildOllamaChatRequest,
  createConfiguredOllamaCompatStreamWrapper,
  convertToOllamaMessages,
  createConfiguredOllamaCompatNumCtxWrapper,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  isOllamaCompatProvider,
  OLLAMA_NATIVE_BASE_URL,
  parseNdjsonStream,
  resolveOllamaBaseUrlForRun,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./src/stream.js";
export {
  createOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  type OllamaEmbeddingClient,
  type OllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
