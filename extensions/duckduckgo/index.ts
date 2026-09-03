// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDuckDuckGoWebSearchProvider } from "./src/ddg-search-provider.js";

export default definePluginEntry({
  id: "duckduckgo",
  name: "DuckDuckGo Plugin",
  description: "Bundled DuckDuckGo web search plugin",
  register(api) {
    api.registerWebSearchProvider(createDuckDuckGoWebSearchProvider());
  },
});
