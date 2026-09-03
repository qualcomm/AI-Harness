// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

export default createUnitVitestConfigWithOptions(process.env, {
  name: "unit-security",
  includePatterns: ["src/security/**/*.test.ts"],
});
