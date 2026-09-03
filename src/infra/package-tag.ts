// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeOptionalString } from "../shared/string-coerce.js";

export function normalizePackageTagInput(
  value: string | undefined | null,
  packageNames: readonly string[],
): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }

  for (const packageName of packageNames) {
    if (trimmed === packageName) {
      return null;
    }
    const prefix = `${packageName}@`;
    if (trimmed.startsWith(prefix)) {
      const tag = trimmed.slice(prefix.length).trim();
      return tag ? tag : null;
    }
  }

  return trimmed;
}
