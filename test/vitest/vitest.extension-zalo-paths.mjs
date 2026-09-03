// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const zaloExtensionTestRoots = ["extensions/zalo", "extensions/zalouser"];

export function isZaloExtensionRoot(root) {
  return zaloExtensionTestRoots.includes(root);
}
