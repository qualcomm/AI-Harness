// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createPerSenderSessionConfig(
  overrides: Partial<NonNullable<OpenClawConfig["session"]>> = {},
): NonNullable<OpenClawConfig["session"]> {
  return {
    mainKey: "main",
    scope: "per-sender",
    ...overrides,
  };
}
