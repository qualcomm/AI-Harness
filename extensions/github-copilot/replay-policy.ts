// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function buildGithubCopilotReplayPolicy(modelId?: string) {
  return normalizeLowercaseStringOrEmpty(modelId).includes("claude")
    ? {
        dropThinkingBlocks: true,
      }
    : {};
}
