// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Shared constants for the GenieX manager plugin.
 *
 * Deliberately duplicated from the `geniex` provider plugin's own
 * `src/defaults.ts` rather than imported: extension production code must not
 * use relative imports that escape its own package root (see
 * `extensions/AGENTS.md`), and these two plugins are separate packages by
 * design — see this plugin's README for why the split exists. The values are
 * small and stable, so duplication is cheaper than a shared workspace package.
 */

export const GENIEX_MANAGER_PLUGIN_ID = "geniex-manager";

/** Default `geniex serve` bind address (see GenieX `cli/cmd/geniex/serve.go`). */
export const GENIEX_DEFAULT_HOST = "127.0.0.1:18181";
export const GENIEX_DEFAULT_BASE_URL = `http://${GENIEX_DEFAULT_HOST}/v1`;

/**
 * GenieX runtime ("plugin") ids, mirroring `RuntimeLlamaCpp` / `RuntimeQairt`
 * in GenieX `bindings/go/device.go`. A model's runtime is fixed when it is
 * pulled — it is written to the on-disk `geniex.json` manifest as `PluginId`
 * and is derived from the source format (GGUF vs. AI Hub bundle), never chosen
 * by the user.
 */
export const GENIEX_RUNTIME_LLAMA_CPP = "llama_cpp";
export const GENIEX_RUNTIME_QAIRT = "qairt";
