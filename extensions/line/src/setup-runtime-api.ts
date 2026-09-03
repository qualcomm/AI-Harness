// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
export type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
export { listLineAccountIds, normalizeAccountId, resolveLineAccount } from "./accounts.js";
export type { LineConfig } from "./types.js";
