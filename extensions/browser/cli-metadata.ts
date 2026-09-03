// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerBrowserCli } = await import("./runtime-api.js");
        registerBrowserCli(program);
      },
      { commands: ["browser"] },
    );
  },
});
