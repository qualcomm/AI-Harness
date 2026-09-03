// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const memoryExtensionTestRoots = [
  "extensions/memory-core",
  "extensions/memory-lancedb",
  "extensions/memory-wiki",
];

export function isMemoryExtensionRoot(root) {
  return memoryExtensionTestRoots.includes(root);
}
