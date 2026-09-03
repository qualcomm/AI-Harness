// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { resolvePluginWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";

export const runtimeWebToolsFallbackProviders = {
  resolvePluginWebFetchProviders,
  resolvePluginWebSearchProviders,
};
