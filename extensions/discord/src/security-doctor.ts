// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function isDiscordMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const maybeMentionId = text.replace(/^<@!?/, "").replace(/>$/, "");
  if (/^\d+$/.test(maybeMentionId)) {
    return false;
  }

  for (const prefix of ["discord:", "user:", "pk:"]) {
    if (!text.startsWith(prefix)) {
      continue;
    }
    return text.slice(prefix.length).trim().length === 0;
  }

  return true;
}
