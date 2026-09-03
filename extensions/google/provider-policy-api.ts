// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { normalizeGoogleProviderConfig } from "./provider-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}
