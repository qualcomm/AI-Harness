// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { extractTextCached } from "./message-extract.ts";

export function getPinnedMessageSummary(message: unknown): string {
  return extractTextCached(message) ?? "";
}
