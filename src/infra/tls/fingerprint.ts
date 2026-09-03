// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export function normalizeFingerprint(input: string): string {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(/^sha-?256\s*:?\s*/i, "");
  return normalizeLowercaseStringOrEmpty(withoutPrefix.replace(/[^a-fA-F0-9]/g, ""));
}
