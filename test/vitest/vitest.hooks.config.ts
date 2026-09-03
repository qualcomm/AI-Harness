// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createHooksVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/hooks/**/*.test.ts"], {
    dir: "src/hooks",
    env,
    name: "hooks",
    passWithNoTests: true,
  });
}

export default createHooksVitestConfig();
