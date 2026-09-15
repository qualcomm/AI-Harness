// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runVideoChaptersSummarize } = vi.hoisted(() => ({
  runVideoChaptersSummarize: vi.fn(async (): Promise<Record<string, unknown>> => ({
    summary: "stub",
  })),
}));

vi.mock("../src/video-chapters-exec.js", () => ({
  runVideoChaptersSummarize,
}));

import { createVideoChaptersSummarizeTool } from "../src/video-chapters-summarize-tool.js";

function fakeApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return { pluginConfig } as unknown as OpenClawPluginApi;
}

describe("video_chapters_summarize tool", () => {
  beforeEach(() => {
    runVideoChaptersSummarize.mockReset();
    runVideoChaptersSummarize.mockImplementation(async () => ({ summary: "stub" }));
  });

  it("requires a video parameter", async () => {
    const tool = createVideoChaptersSummarizeTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

    await expect(tool.execute("call-1", {})).rejects.toThrow();
    expect(runVideoChaptersSummarize).not.toHaveBeenCalled();
  });

  it("passes the configured toolDir, video path, and max_tokens through", async () => {
    const tool = createVideoChaptersSummarizeTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

    await tool.execute("call-2", {
      video: "C:\\videos\\ouwen.mp4",
      max_tokens: 256,
    });

    expect(runVideoChaptersSummarize).toHaveBeenCalledWith({
      toolDir: "C:\\tools\\vc",
      videoPath: "C:\\videos\\ouwen.mp4",
      maxTokens: 256,
    });
  });

  it("omits max_tokens when not provided", async () => {
    const tool = createVideoChaptersSummarizeTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

    await tool.execute("call-3", { video: "C:\\videos\\ouwen.mp4" });

    expect(runVideoChaptersSummarize).toHaveBeenCalledWith({
      toolDir: "C:\\tools\\vc",
      videoPath: "C:\\videos\\ouwen.mp4",
      maxTokens: undefined,
    });
  });

  it("passes toolDir as undefined when the plugin is unconfigured", async () => {
    const tool = createVideoChaptersSummarizeTool(fakeApi());

    await tool.execute("call-4", { video: "C:\\videos\\ouwen.mp4" });

    expect(runVideoChaptersSummarize).toHaveBeenCalledWith(
      expect.objectContaining({ toolDir: undefined }),
    );
  });

  it("returns the exec result as the tool's json result", async () => {
    runVideoChaptersSummarize.mockResolvedValueOnce({ summary: "a video", tags: ["a", "b"] });
    const tool = createVideoChaptersSummarizeTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

    const result = await tool.execute("call-5", { video: "C:\\videos\\ouwen.mp4" });

    expect(result.details).toEqual({ summary: "a video", tags: ["a", "b"] });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("propagates errors from the exec layer", async () => {
    runVideoChaptersSummarize.mockRejectedValueOnce(new Error("video_chapters.exe not found"));
    const tool = createVideoChaptersSummarizeTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

    await expect(
      tool.execute("call-6", { video: "C:\\videos\\ouwen.mp4" }),
    ).rejects.toThrow("video_chapters.exe not found");
  });
});
