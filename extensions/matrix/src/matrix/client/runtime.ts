// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function isBunRuntime(): boolean {
  const versions = process.versions as { bun?: string };
  return typeof versions.bun === "string";
}
