// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const blueBubblesExtensionTestRoots = ["extensions/bluebubbles"];

export function isBlueBubblesExtensionRoot(root) {
  return blueBubblesExtensionTestRoots.includes(root);
}
