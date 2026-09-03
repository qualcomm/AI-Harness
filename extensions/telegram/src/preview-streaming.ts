// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { resolveChannelPreviewStreamMode } from "openclaw/plugin-sdk/channel-streaming";

export type TelegramPreviewStreamMode = "off" | "partial" | "block";

export function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  return resolveChannelPreviewStreamMode(params, "partial");
}
