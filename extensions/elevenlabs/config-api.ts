// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Narrow barrel for ElevenLabs config compatibility helpers consumed outside the plugin.
// Keep this separate from runtime exports so doctor/config code stays lightweight.

export {
  ELEVENLABS_TALK_PROVIDER_ID,
  migrateElevenLabsLegacyTalkConfig,
  resolveElevenLabsApiKeyWithProfileFallback,
} from "./config-compat.js";
