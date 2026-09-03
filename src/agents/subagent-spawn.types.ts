// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];

export const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];
