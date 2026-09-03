// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const msTeamsExtensionIds = ["msteams"];

export const msTeamsExtensionTestRoots = msTeamsExtensionIds.map((id) => bundledPluginRoot(id));

export function isMsTeamsExtensionRoot(root) {
  return msTeamsExtensionTestRoots.includes(root);
}
