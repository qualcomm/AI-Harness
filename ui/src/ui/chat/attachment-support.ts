// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const CHAT_ATTACHMENT_ACCEPT = "image/*";

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}
