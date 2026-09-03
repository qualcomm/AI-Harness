// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  legacyConfigRules as NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeNextcloudTalkCompatibilityConfig,
} from "./doctor-contract.js";

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeNextcloudTalkCompatibilityConfig,
};
