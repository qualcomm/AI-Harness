// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const acpxExtensionTestRoots = ["extensions/acpx"];

export function isAcpxExtensionRoot(root) {
  return acpxExtensionTestRoots.includes(root);
}
