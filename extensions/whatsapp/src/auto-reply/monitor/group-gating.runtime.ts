// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
export { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
export { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
export { parseActivationCommand } from "openclaw/plugin-sdk/reply-runtime";
export { normalizeE164 } from "../../text-runtime.js";
