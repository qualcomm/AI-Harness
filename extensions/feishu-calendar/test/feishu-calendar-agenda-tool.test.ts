// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runFeishuCalendarAgenda } = vi.hoisted(() => ({
  runFeishuCalendarAgenda: vi.fn(async (): Promise<Array<Record<string, unknown>>> => [
    { summary: "stub" },
  ]),
}));

vi.mock("../src/feishu-calendar-exec.js", () => ({
  runFeishuCalendarAgenda,
}));

import { createFeishuCalendarAgendaTool } from "../src/feishu-calendar-agenda-tool.js";

function fakeApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return { pluginConfig } as unknown as OpenClawPluginApi;
}

describe("feishu_calendar_agenda tool", () => {
  beforeEach(() => {
    runFeishuCalendarAgenda.mockClear();
    runFeishuCalendarAgenda.mockResolvedValue([{ summary: "stub" }]);
  });

  it("passes start/end/calendar_id through, with an undefined cliPath when unconfigured", async () => {
    const tool = createFeishuCalendarAgendaTool(fakeApi());

    await tool.execute("call-1", { start: "2026-09-10", end: "2026-10-10", calendar_id: "primary" });

    expect(runFeishuCalendarAgenda).toHaveBeenCalledWith({
      cliPath: undefined,
      start: "2026-09-10",
      end: "2026-10-10",
      calendarId: "primary",
    });
  });

  it("passes the configured cliPath through", async () => {
    const tool = createFeishuCalendarAgendaTool(fakeApi({ cliPath: "C:\\tools\\lark-cli.exe" }));

    await tool.execute("call-2", {});

    expect(runFeishuCalendarAgenda).toHaveBeenCalledWith(
      expect.objectContaining({ cliPath: "C:\\tools\\lark-cli.exe" }),
    );
  });

  it("works with no parameters at all", async () => {
    const tool = createFeishuCalendarAgendaTool(fakeApi());

    await tool.execute("call-3", {});

    expect(runFeishuCalendarAgenda).toHaveBeenCalledWith({
      cliPath: undefined,
      start: undefined,
      end: undefined,
      calendarId: undefined,
    });
  });

  it("returns the events as the tool's json result", async () => {
    runFeishuCalendarAgenda.mockResolvedValueOnce([{ summary: "business trip", location: {} }]);
    const tool = createFeishuCalendarAgendaTool(fakeApi());

    const result = await tool.execute("call-4", {});

    expect(result.details).toEqual({ events: [{ summary: "business trip", location: {} }] });
  });

  it("propagates errors from the exec layer", async () => {
    runFeishuCalendarAgenda.mockRejectedValueOnce(new Error("insufficient scope"));
    const tool = createFeishuCalendarAgendaTool(fakeApi());

    await expect(tool.execute("call-5", {})).rejects.toThrow("insufficient scope");
  });
});
