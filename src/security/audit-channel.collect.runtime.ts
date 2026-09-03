// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { collectChannelSecurityFindings as collectChannelSecurityFindingsImpl } from "./audit-channel.js";

type CollectChannelSecurityFindings =
  typeof import("./audit-channel.js").collectChannelSecurityFindings;

export function collectChannelSecurityFindings(
  ...args: Parameters<CollectChannelSecurityFindings>
): ReturnType<CollectChannelSecurityFindings> {
  return collectChannelSecurityFindingsImpl(...args);
}
