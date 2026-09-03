// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function normalizeSlackWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "/slack/events";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
