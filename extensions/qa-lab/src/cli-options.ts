// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function collectString(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}
