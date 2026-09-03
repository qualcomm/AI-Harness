// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildNativeAnthropicReplayPolicyForModel } from "openclaw/plugin-sdk/provider-model-shared";

/**
 * Returns the provider-owned replay policy for Anthropic transports.
 */
export function buildAnthropicReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  return buildNativeAnthropicReplayPolicyForModel(ctx.modelId);
}
