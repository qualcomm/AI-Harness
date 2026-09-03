// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  ELEVENLABS_TALK_PROVIDER_ID,
  ELEVENLABS_TALK_LEGACY_CONFIG_RULES,
  hasLegacyTalkFields,
  legacyConfigRules,
  normalizeCompatibilityConfig,
} from "./doctor-contract.js";
export { migrateElevenLabsLegacyTalkConfig } from "./config-compat.js";
