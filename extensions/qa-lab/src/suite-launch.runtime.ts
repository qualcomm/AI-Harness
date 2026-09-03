// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { QaSuiteRunParams } from "./suite.js";

async function loadQaLabServerRuntime() {
  const { startQaLabServer } = await import("./lab-server.js");
  return startQaLabServer;
}

export async function runQaSuiteFromRuntime(...args: [QaSuiteRunParams?]) {
  const { runQaSuite } = await import("./suite.js");
  const params = args[0];
  return await runQaSuite({
    ...params,
    startLab: params?.startLab ?? (await loadQaLabServerRuntime()),
  });
}
