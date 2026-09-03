// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type PluginManifestRegistryCacheEntry = {
  expiresAt: number;
  registry: unknown;
};

export const pluginManifestRegistryCache = new Map<string, PluginManifestRegistryCacheEntry>();

export function clearPluginManifestRegistryCache(): void {
  pluginManifestRegistryCache.clear();
}
