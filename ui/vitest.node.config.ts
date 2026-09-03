// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";
import { resolveDefaultVitestPool } from "../test/vitest/vitest.shared.config.ts";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  test: {
    isolate: true,
    pool: resolveDefaultVitestPool(),
    testTimeout: 120_000,
    include: ["src/**/*.node.test.ts"],
    environment: "node",
  },
});
