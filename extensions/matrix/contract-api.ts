// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  createMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./src/matrix/thread-bindings.js";
export { setMatrixRuntime } from "./src/runtime.js";
export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  namedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget,
  singleAccountKeysToMove,
} from "./src/setup-contract.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export { matrixSetupAdapter } from "./src/setup-core.js";
export { matrixSetupWizard } from "./src/setup-surface.js";
