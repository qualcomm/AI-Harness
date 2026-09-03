// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function createInternalHookEventPayload(
  type: string,
  action: string,
  sessionKey: string,
  context: Record<string, unknown>,
) {
  return {
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
}
