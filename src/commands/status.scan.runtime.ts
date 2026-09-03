// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { buildChannelsTable } from "./status-all/channels.js";

export const statusScanRuntime = {
  collectChannelStatusIssues,
  buildChannelsTable,
};
