// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function isFireworksKimiModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^kimi-k2(?:p5|\.5)(?:[-_].+)?$/.test(lastSegment);
}
