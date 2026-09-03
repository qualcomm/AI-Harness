// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const voiceCallExtensionIds = ["voice-call"];

export const voiceCallExtensionTestRoots = voiceCallExtensionIds.map((id) => bundledPluginRoot(id));

export function isVoiceCallExtensionRoot(root) {
  return voiceCallExtensionTestRoots.includes(root);
}
