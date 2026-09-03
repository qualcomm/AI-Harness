// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["browser/**/*.test.ts"], {
  dir: "extensions",
  name: "extension-browser",
  passWithNoTests: true,
  setupFiles: ["test/setup.extensions.ts"],
});
