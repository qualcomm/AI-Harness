// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

type VideoChaptersConfig = {
  toolDir?: unknown;
  embeddings?: unknown;
  watchDirs?: unknown;
};

function resolveVideoChaptersConfig(cfg: OpenClawConfig | undefined): VideoChaptersConfig | undefined {
  const entries = cfg?.plugins?.entries as Record<string, { config?: unknown }> | undefined;
  const config = entries?.["video-chapters"]?.config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as VideoChaptersConfig)
    : undefined;
}

export function resolveVideoChaptersToolDir(cfg: OpenClawConfig | undefined): string | undefined {
  const toolDir = resolveVideoChaptersConfig(cfg)?.toolDir;
  return typeof toolDir === "string" && toolDir.trim() ? toolDir.trim() : undefined;
}

export function resolveVideoChaptersEmbeddingsRaw(
  cfg: OpenClawConfig | undefined,
): Record<string, unknown> | undefined {
  const embeddings = resolveVideoChaptersConfig(cfg)?.embeddings;
  return embeddings && typeof embeddings === "object" && !Array.isArray(embeddings)
    ? (embeddings as Record<string, unknown>)
    : undefined;
}

/** Empty/absent by design — batch indexing on startup requires an explicit opt-in list. */
export function resolveVideoChaptersWatchDirs(cfg: OpenClawConfig | undefined): string[] {
  const watchDirs = resolveVideoChaptersConfig(cfg)?.watchDirs;
  if (!Array.isArray(watchDirs)) {
    return [];
  }
  return watchDirs.filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0);
}
