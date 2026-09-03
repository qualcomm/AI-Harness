// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";

export const whatsappCommandPolicy: NonNullable<ChannelPlugin["commands"]> = {
  enforceOwnerForCommands: true,
  preferSenderE164ForCommands: true,
  skipWhenConfigEmpty: true,
};
