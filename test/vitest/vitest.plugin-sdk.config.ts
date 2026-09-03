// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createPluginSdkVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/plugin-sdk/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: pluginSdkLightTestFiles,
    name: "plugin-sdk",
    passWithNoTests: true,
  });
}

export default createPluginSdkVitestConfig();
