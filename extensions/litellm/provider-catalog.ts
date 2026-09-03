// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildLitellmModelDefinition, LITELLM_BASE_URL } from "./onboard.js";

export function buildLitellmProvider(): ModelProviderConfig {
  return {
    baseUrl: LITELLM_BASE_URL,
    api: "openai-completions",
    models: [buildLitellmModelDefinition()],
  };
}
