// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/** Shared GenieX defaults used by setup, discovery, and stream paths. */

export const GENIEX_PROVIDER_ID = "geniex";
export const GENIEX_PROVIDER_LABEL = "GenieX";

/** Default `geniex serve` bind address (see GenieX `cli/cmd/geniex/serve.go`). */
export const GENIEX_DEFAULT_HOST = "127.0.0.1:18181";
export const GENIEX_DEFAULT_BASE_URL = `http://${GENIEX_DEFAULT_HOST}/v1`;

/**
 * GenieX serves an OpenAI-compatible API with no authentication, so there is no
 * API key to collect. The env var exists only so operators can point the
 * provider at a proxied deployment that does require one.
 */
export const GENIEX_DEFAULT_API_KEY_ENV_VAR = "GENIEX_API_KEY";

export const GENIEX_MODEL_PLACEHOLDER = "qualcomm/Qwen3-4B-Instruct-2507";

/**
 * GenieX runtime ("plugin") ids, mirroring `RuntimeLlamaCpp` / `RuntimeQairt`
 * in GenieX `bindings/go/device.go`. A model's runtime is fixed when it is
 * pulled — it is written to the on-disk `geniex.json` manifest as `PluginId`
 * and is derived from the source format (GGUF vs. AI Hub bundle), never chosen
 * by the user.
 */
export const GENIEX_RUNTIME_LLAMA_CPP = "llama_cpp";
export const GENIEX_RUNTIME_QAIRT = "qairt";
