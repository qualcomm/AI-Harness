// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function normalizePhoneNumber(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}

export function isAllowlistedCaller(
  normalizedFrom: string,
  allowFrom: string[] | undefined,
): boolean {
  if (!normalizedFrom) {
    return false;
  }
  return (allowFrom ?? []).some((num) => {
    const normalizedAllow = normalizePhoneNumber(num);
    return normalizedAllow !== "" && normalizedAllow === normalizedFrom;
  });
}
