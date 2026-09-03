// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Focused runtime contract for memory file/backend access.

export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
} from "./host/types.js";
