// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createPatchedAccountSetupAdapter } from "openclaw/plugin-sdk/setup-runtime";

const channel = "zalouser" as const;

export const zalouserSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: () => null,
  buildPatch: () => ({}),
});
