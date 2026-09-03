// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function readAccessToken(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const token =
      (value as { accessToken?: unknown }).accessToken ?? (value as { token?: unknown }).token;
    return typeof token === "string" ? token : null;
  }
  return null;
}
