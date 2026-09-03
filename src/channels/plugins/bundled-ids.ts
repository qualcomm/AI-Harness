// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";

let bundledChannelPluginIds: string[] | null = null;

export function listBundledChannelPluginIds(): string[] {
  bundledChannelPluginIds ??= listChannelCatalogEntries({ origin: "bundled" })
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
  return [...bundledChannelPluginIds];
}
