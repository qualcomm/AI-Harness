// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { stripAnsi } from "../../src/terminal/ansi.js";

export function normalizeTestText(input: string): string {
  return stripAnsi(input)
    .replaceAll("\r\n", "\n")
    .replaceAll("…", "...")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
    .replace(/[\uD800-\uDFFF]/g, "?");
}
