// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    loadConfig,
    writeConfigFile,
  };
}
