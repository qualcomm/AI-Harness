// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const channelPluginSurfaceKeys = [
  "actions",
  "setup",
  "status",
  "outbound",
  "messaging",
  "threading",
  "directory",
  "gateway",
] as const;

export type ChannelPluginSurface = (typeof channelPluginSurfaceKeys)[number];

export const sessionBindingContractChannelIds = [
  "bluebubbles",
  "discord",
  "feishu",
  "imessage",
  "matrix",
  "telegram",
] as const;

export type SessionBindingContractChannelId = (typeof sessionBindingContractChannelIds)[number];
