// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, WhatsAppConfigSchema } from "../config-api.js";
import { whatsAppChannelConfigUiHints } from "./config-ui-hints.js";

export const WhatsAppChannelConfigSchema = buildChannelConfigSchema(WhatsAppConfigSchema, {
  uiHints: whatsAppChannelConfigUiHints,
});
