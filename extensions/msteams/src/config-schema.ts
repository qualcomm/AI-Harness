// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, MSTeamsConfigSchema } from "../config-api.js";
import { msTeamsChannelConfigUiHints } from "./config-ui-hints.js";

export const MSTeamsChannelConfigSchema = buildChannelConfigSchema(MSTeamsConfigSchema, {
  uiHints: msTeamsChannelConfigUiHints,
});
