// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const telegramExtensionTestRoots = ["extensions/telegram"];

export function isTelegramExtensionRoot(root) {
  return telegramExtensionTestRoots.includes(root);
}
