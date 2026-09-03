// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function deriveLegacySessionChatType(sessionKey: string): "channel" | undefined {
  return /^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(sessionKey) ? "channel" : undefined;
}
