// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * This plugin's own config: how it manages the `geniex serve` process.
 *
 * Per-model compute settings are a *different* config, owned by the `geniex`
 * provider plugin (under `plugins.entries.geniex.config.models`) — that plugin
 * reads it in its own `wrapStreamFn` to inject compute into each request. This
 * plugin only needs the process-level defaults below.
 */
import { type GenieXComputeUnit, normalizeGenieXComputeUnit } from "./compute.js";

/** How the gateway treats the `geniex serve` process. */
export type GenieXServeSettings = {
  mode?: "auto" | "always" | "never";
  host?: string;
  /** Fallback compute unit for requests that do not specify one. */
  compute?: GenieXComputeUnit;
  keepAliveSeconds?: number;
};

export type GenieXManagerPluginConfig = {
  serve?: GenieXServeSettings;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const SERVE_MODES = new Set(["auto", "always", "never"]);

export function normalizeGenieXServeSettings(value: unknown): GenieXServeSettings | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const settings: GenieXServeSettings = {};

  if (typeof record.mode === "string") {
    const mode = record.mode.trim().toLowerCase();
    if (SERVE_MODES.has(mode)) {
      settings.mode = mode as NonNullable<GenieXServeSettings["mode"]>;
    }
  }
  if (typeof record.host === "string" && record.host.trim()) {
    settings.host = record.host.trim();
  }
  const compute = normalizeGenieXComputeUnit(record.compute);
  if (compute) {
    settings.compute = compute;
  }
  // 0 is meaningful here (unload as soon as idle), so only reject negatives.
  if (typeof record.keepAliveSeconds === "number" && Number.isFinite(record.keepAliveSeconds)) {
    const seconds = Math.floor(record.keepAliveSeconds);
    if (seconds >= 0) {
      settings.keepAliveSeconds = seconds;
    }
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Reads and normalizes this plugin's config out of the raw plugin entry bag. */
export function normalizeGenieXManagerPluginConfig(raw: unknown): GenieXManagerPluginConfig {
  const record = asRecord(raw);
  if (!record) {
    return {};
  }
  const config: GenieXManagerPluginConfig = {};
  const serve = normalizeGenieXServeSettings(record.serve);
  if (serve) {
    config.serve = serve;
  }
  return config;
}
