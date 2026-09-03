// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createTuiVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/tui/**/*.test.ts"], {
    dir: "src",
    env,
    name: "tui",
    passWithNoTests: true,
  });
}

export default createTuiVitestConfig();
