// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, DiscordConfigSchema } from "../config-api.js";
import { discordChannelConfigUiHints } from "./config-ui-hints.js";

export const DiscordChannelConfigSchema = buildChannelConfigSchema(DiscordConfigSchema, {
  uiHints: discordChannelConfigUiHints,
});
