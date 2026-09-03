// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, IMessageConfigSchema } from "../config-api.js";
import { iMessageChannelConfigUiHints } from "./config-ui-hints.js";

export const IMessageChannelConfigSchema = buildChannelConfigSchema(IMessageConfigSchema, {
  uiHints: iMessageChannelConfigUiHints,
});
