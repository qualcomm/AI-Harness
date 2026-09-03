// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
type PluginAllowlistConfigCarrier = {
  plugins?: {
    allow?: string[];
  };
};

export function ensurePluginAllowlisted<T extends PluginAllowlistConfigCarrier>(
  cfg: T,
  pluginId: string,
): T {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  } as T;
}
