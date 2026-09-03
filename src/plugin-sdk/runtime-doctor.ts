// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
export {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
} from "../config/channel-compat-normalization.js";
export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
export { removePluginFromConfig } from "../plugins/uninstall.js";
