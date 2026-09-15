// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { runFeishuCalendarAgenda } from "./feishu-calendar-exec.js";

type FeishuCalendarPluginConfig = {
  cliPath?: unknown;
};

const FeishuCalendarAgendaToolSchema = Type.Object(
  {
    start: Type.Optional(
      Type.String({
        description:
          "Range start (ISO 8601 or plain YYYY-MM-DD). Defaults to today when omitted.",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description: "Range end (ISO 8601 or plain YYYY-MM-DD). Defaults to `start`'s day end.",
      }),
    ),
    calendar_id: Type.Optional(
      Type.String({
        description: "Calendar id to query. Defaults to the user's primary calendar.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFeishuCalendarAgendaTool(api: OpenClawPluginApi) {
  return {
    name: "feishu_calendar_agenda",
    label: "Feishu Calendar Agenda",
    description:
      "Read the user's Feishu/Lark calendar agenda for a date range (event time, location, " +
      "organizer, video-meeting link) via lark-cli. Requires `lark-cli auth login` to have " +
      "already been run out of band.",
    parameters: FeishuCalendarAgendaToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const start = readStringParam(rawParams, "start");
      const end = readStringParam(rawParams, "end");
      const calendarId = readStringParam(rawParams, "calendar_id");
      const pluginCfg = (api.pluginConfig ?? {}) as FeishuCalendarPluginConfig;
      const cliPath = typeof pluginCfg.cliPath === "string" ? pluginCfg.cliPath : undefined;

      const data = await runFeishuCalendarAgenda({ cliPath, start, end, calendarId });
      return jsonResult({ events: data });
    },
  };
}
