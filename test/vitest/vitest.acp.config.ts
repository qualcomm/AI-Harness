// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAcpVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/acp/**/*.test.ts"], {
    dir: "src/acp",
    env,
    name: "acp",
  });
}

export default createAcpVitestConfig();
