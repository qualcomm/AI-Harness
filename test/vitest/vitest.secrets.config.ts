// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createSecretsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/secrets/**/*.test.ts"], {
    dir: "src/secrets",
    env,
    name: "secrets",
    pool: "forks",
    passWithNoTests: true,
  });
}

export default createSecretsVitestConfig();
