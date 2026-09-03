// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";

export const telegramOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkMarkdownText,
  chunkerMode: "markdown" as const,
  textChunkLimit: 4000,
  pollMaxOptions: 10,
};
