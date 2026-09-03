// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateElevenLabsLegacyTalkConfig } from "./config-compat.js";

export default definePluginEntry({
  id: "elevenlabs",
  name: "ElevenLabs Setup",
  description: "Lightweight ElevenLabs setup hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateElevenLabsLegacyTalkConfig(config));
  },
});
