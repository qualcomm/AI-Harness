// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
const INLINE_HORIZONTAL_WHITESPACE_RE = /[^\S\n]+/g;

export function collapseInlineHorizontalWhitespace(value: string): string {
  return value.replace(INLINE_HORIZONTAL_WHITESPACE_RE, " ");
}
