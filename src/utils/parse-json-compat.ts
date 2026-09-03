// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import JSON5 from "json5";

export function parseJsonWithJson5Fallback(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON5.parse(raw);
  }
}
