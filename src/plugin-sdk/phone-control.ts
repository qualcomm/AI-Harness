// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Narrow plugin-sdk surface for the bundled phone-control plugin.
// Keep this list additive and scoped to the bundled phone-control surface.

export { definePluginEntry } from "./plugin-entry.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginService,
  PluginCommandContext,
} from "../plugins/types.js";
