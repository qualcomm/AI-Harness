// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function buildTelegramInboundDebounceKey(params: {
  accountId?: string | null;
  conversationKey: string;
  senderId: string;
  debounceLane: "default" | "forward";
}): string {
  const resolvedAccountId = params.accountId?.trim() || "default";
  return `telegram:${resolvedAccountId}:${params.conversationKey}:${params.senderId}:${params.debounceLane}`;
}
