// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, TelegramConfigSchema } from "../config-api.js";
import { telegramChannelConfigUiHints } from "./config-ui-hints.js";

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema, {
  uiHints: telegramChannelConfigUiHints,
});
