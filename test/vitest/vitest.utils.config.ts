// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { unitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createUtilsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/utils/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: unitFastTestFiles,
    includeOpenClawRuntimeSetup: false,
    name: "utils",
    passWithNoTests: true,
  });
}

export default createUtilsVitestConfig();
