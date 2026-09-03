// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export * from "openclaw/plugin-sdk/text-runtime";
export {
  assertWebChannel,
  isSelfChatMode,
  jidToE164,
  markdownToWhatsApp,
  resolveJidToE164,
  toWhatsappJid,
  type JidToE164Options,
  type WebChannel,
} from "./targets-runtime.js";
