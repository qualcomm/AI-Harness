// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const ircExtensionTestRoots = ["extensions/irc"];

export function isIrcExtensionRoot(root) {
  return ircExtensionTestRoots.includes(root);
}
