// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createConfigIO, getRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSnapshot() ?? createConfigIO().loadConfig();
}
