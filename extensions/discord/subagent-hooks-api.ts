// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Subagent hooks live behind a dedicated barrel so the bundled entry can lazy
// load only the handlers it needs.
export {
  handleDiscordSubagentDeliveryTarget,
  handleDiscordSubagentEnded,
  handleDiscordSubagentSpawning,
} from "./src/subagent-hooks.js";
