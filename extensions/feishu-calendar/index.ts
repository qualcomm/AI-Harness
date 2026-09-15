// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createFeishuCalendarAgendaTool } from "./src/feishu-calendar-agenda-tool.js";

export default definePluginEntry({
  id: "feishu-calendar",
  name: "Feishu Calendar Plugin",
  description: "Read Feishu/Lark calendar agenda via the official lark-cli",
  register(api) {
    api.registerTool(createFeishuCalendarAgendaTool(api) as AnyAgentTool);
  },
});
