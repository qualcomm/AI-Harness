// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.apply.js";
export { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
export type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
export { resolvePluginAutoEnableCandidateReason } from "./plugin-auto-enable.shared.js";
