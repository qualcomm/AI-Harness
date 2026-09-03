// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Backwards-compatible entry point.
// Implementation lives in `src/agents/cli-runner.ts` (so we can reuse the same runner for other CLIs).
export { runClaudeCliAgent, runCliAgent } from "./cli-runner.js";
