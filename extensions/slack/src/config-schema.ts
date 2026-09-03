// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, SlackConfigSchema } from "../config-api.js";
import { slackChannelConfigUiHints } from "./config-ui-hints.js";

export const SlackChannelConfigSchema = buildChannelConfigSchema(SlackConfigSchema, {
  uiHints: slackChannelConfigUiHints,
});
