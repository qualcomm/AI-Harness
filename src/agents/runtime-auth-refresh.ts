// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

export function clampRuntimeAuthRefreshDelayMs(params: {
  refreshAt: number;
  now: number;
  minDelayMs: number;
}): number {
  return Math.min(MAX_SAFE_TIMEOUT_MS, Math.max(params.minDelayMs, params.refreshAt - params.now));
}
