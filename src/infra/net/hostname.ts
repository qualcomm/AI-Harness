// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export function normalizeHostname(hostname: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}
