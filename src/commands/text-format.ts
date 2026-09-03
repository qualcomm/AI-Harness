// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const shortenText = (value: string, maxLen: number) => {
  const chars = Array.from(value);
  if (chars.length <= maxLen) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};
