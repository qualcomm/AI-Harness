// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Reads and writes per-model compute units in the `geniex` provider plugin's
 * config (`plugins.entries.geniex.config.models.<name>.compute`) — the same
 * place the provider's request injection reads from, so a unit chosen in the
 * Local Models tab is sent with the next request for that model.
 *
 * Entries are keyed by the bare model `name`, which the provider applies to
 * every precision. A more specific `name:precision` entry takes precedence over
 * it there, so it is reported (not rewritten) when present: silently editing a
 * key the user wrote by hand would be surprising.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { type GenieXComputeUnit, normalizeGenieXComputeUnit } from "./compute.js";

const PROVIDER_PLUGIN_ID = "geniex";

/** Units the UI offers. `hybrid` is accepted by GenieX but has no dedicated mode. */
export const SELECTABLE_COMPUTE_UNITS = ["cpu", "gpu", "npu"] as const;

type ModelSettings = Record<string, unknown>;

function readModels(cfg: OpenClawConfig): Record<string, ModelSettings> {
  const config = cfg.plugins?.entries?.[PROVIDER_PLUGIN_ID]?.config as
    | { models?: Record<string, ModelSettings> }
    | undefined;
  return config?.models ?? {};
}

/** Compute unit configured under the bare `name`, or undefined for "default". */
export function readModelCompute(cfg: OpenClawConfig, name: string): GenieXComputeUnit | undefined {
  return normalizeGenieXComputeUnit(readModels(cfg)[name]?.compute);
}

/**
 * Whether a `name:precision` entry overrides the bare-name one for this model.
 * When true the dropdown would appear to do nothing for that precision.
 */
export function hasPrecisionOverride(cfg: OpenClawConfig, name: string): boolean {
  const prefix = `${name}:`;
  return Object.entries(readModels(cfg)).some(
    ([key, settings]) =>
      key.startsWith(prefix) && normalizeGenieXComputeUnit(settings?.compute) !== undefined,
  );
}

/**
 * Returns a copy of `cfg` with the model's compute set, or null when nothing
 * changes. `undefined` clears it back to "default" (the field is removed, and
 * so is the entry when it held nothing else). Only this one key is touched:
 * the same entry may carry `contextSize`, `specDraftModel`, etc.
 */
export function setModelCompute(
  cfg: OpenClawConfig,
  name: string,
  compute: GenieXComputeUnit | undefined,
): OpenClawConfig | null {
  if (readModelCompute(cfg, name) === compute) {
    return null;
  }
  const next = structuredClone(cfg);
  next.plugins ??= {};
  next.plugins.entries ??= {};
  const entry = (next.plugins.entries[PROVIDER_PLUGIN_ID] ??= {});
  const config = ((entry as { config?: Record<string, unknown> }).config ??= {});
  const models = ((config as { models?: Record<string, ModelSettings> }).models ??= {});

  if (compute === undefined) {
    const settings = models[name];
    if (settings) {
      delete settings.compute;
      if (Object.keys(settings).length === 0) {
        delete models[name];
      }
    }
  } else {
    models[name] = { ...models[name], compute };
  }
  return next;
}
