// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { runVideoChaptersSummarize } from "./video-chapters-exec.js";

type VideoChaptersPluginConfig = {
  toolDir?: unknown;
};

const VideoChaptersSummarizeToolSchema = Type.Object(
  {
    video: Type.String({
      description: "Absolute path to the local video file to summarize.",
    }),
    max_tokens: Type.Optional(
      Type.Number({
        description: "Maximum tokens for the generated summary.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createVideoChaptersSummarizeTool(api: OpenClawPluginApi) {
  return {
    name: "video_chapters_summarize",
    label: "Video Chapters Summarize",
    description:
      "Summarize a local video file (shot-level chapters, overview, tags) using video_chapters.exe. " +
      "Windows ARM64 only; requires plugins.entries.video-chapters.config.toolDir to be configured.",
    parameters: VideoChaptersSummarizeToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const video = readStringParam(rawParams, "video", { required: true });
      const maxTokens = readNumberParam(rawParams, "max_tokens", { integer: true });
      const pluginCfg = (api.pluginConfig ?? {}) as VideoChaptersPluginConfig;
      const toolDir = typeof pluginCfg.toolDir === "string" ? pluginCfg.toolDir : undefined;

      const chapters = await runVideoChaptersSummarize({
        toolDir,
        videoPath: video,
        maxTokens,
      });
      return jsonResult(chapters);
    },
  };
}
