// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildChannelConfigSchema, SignalConfigSchema } from "../config-api.js";
import { signalChannelConfigUiHints } from "./config-ui-hints.js";

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema, {
  uiHints: signalChannelConfigUiHints,
});
