// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createLoggingVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/logging/**/*.test.ts"], {
    dir: "src",
    env,
    name: "logging",
    passWithNoTests: true,
  });
}

export default createLoggingVitestConfig();
