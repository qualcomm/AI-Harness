// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const CHANNEL_MESSAGE_CAPABILITIES = [
  "interactive",
  "buttons",
  "cards",
  "components",
  "blocks",
] as const;

export type ChannelMessageCapability = (typeof CHANNEL_MESSAGE_CAPABILITIES)[number];
