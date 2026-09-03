// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export type {
  SlackInteractiveHandlerContext,
  SlackInteractiveHandlerRegistration,
} from "./src/interactive-dispatch.js";
export { collectSlackSecurityAuditFindings } from "./src/security-audit.js";
