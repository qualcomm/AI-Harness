// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function stripUrlUserInfo(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value;
  }
}
