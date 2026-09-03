// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { type ChannelPlugin, type ResolvedLineAccount } from "./channel-api.js";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { lineSetupAdapter } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";

export const lineSetupPlugin: ChannelPlugin<ResolvedLineAccount> = {
  id: "line",
  ...lineChannelPluginCommon,
  setupWizard: lineSetupWizard,
  setup: lineSetupAdapter,
};
