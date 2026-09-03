// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { buildSubagentsSendContext } from "./commands-subagents.test-helpers.js";

export function buildSubagentsDispatchContext(params: {
  handledPrefix: string;
  restTokens: string[];
}) {
  return buildSubagentsSendContext({
    handledPrefix: params.handledPrefix,
    restTokens: params.restTokens,
  });
}
