// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const feishuExtensionIds = ["feishu"];

export const feishuExtensionTestRoots = feishuExtensionIds.map((id) => bundledPluginRoot(id));

export function isFeishuExtensionRoot(root) {
  return feishuExtensionTestRoots.includes(root);
}
