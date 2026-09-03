// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";

export function normalizeMatrixApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixUserId(String(value));
  return normalized || undefined;
}
