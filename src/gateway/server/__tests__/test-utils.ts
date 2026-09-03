// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createEmptyPluginRegistry, type PluginRegistry } from "../../../plugins/registry.js";

export const createTestRegistry = (overrides: Partial<PluginRegistry> = {}): PluginRegistry => {
  const merged = { ...createEmptyPluginRegistry(), ...overrides };
  return {
    ...merged,
    gatewayHandlers: merged.gatewayHandlers ?? {},
    httpRoutes: merged.httpRoutes ?? [],
  };
};
