// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createMediaVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/media/**/*.test.ts"], {
    dir: "src",
    env,
    name: "media",
    passWithNoTests: true,
  });
}

export default createMediaVitestConfig();
