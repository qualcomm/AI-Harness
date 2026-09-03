#!/usr/bin/env node
// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";

const args = [
  "run",
  "--config",
  "vitest.config.ts",
  bundledPluginFile("voice-call", "src/manager.test.ts"),
  bundledPluginFile("voice-call", "src/media-stream.test.ts"),
  "src/plugins/voice-call.plugin.test.ts",
  "--maxWorkers=1",
];

execFileSync(process.execPath, ["scripts/run-vitest.mjs", ...args], {
  stdio: "inherit",
});
