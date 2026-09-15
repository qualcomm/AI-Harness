// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { runVideoChaptersBatchIndex } from "./src/video-chapters-batch.js";
import {
  resolveVideoChaptersEmbeddingsRaw,
  resolveVideoChaptersToolDir,
  resolveVideoChaptersWatchDirs,
} from "./src/video-chapters-config.js";
import { resolveVideoChaptersEmbeddingsConfig } from "./src/video-chapters-embeddings.js";
import { createVideoChaptersSearchTool } from "./src/video-chapters-search-tool.js";
import { createVideoChaptersSummarizeTool } from "./src/video-chapters-summarize-tool.js";

export default definePluginEntry({
  id: "video-chapters",
  name: "Video Chapters Plugin",
  description: "Summarize local videos into chapters, an overview, and tags via video_chapters.exe",
  register(api) {
    api.registerTool(createVideoChaptersSummarizeTool(api) as AnyAgentTool);
    api.registerTool(createVideoChaptersSearchTool(api) as AnyAgentTool);

    // Fire-and-forget: a full library scan can take hours (see the per-video timing from
    // the 2026-09-07 run), and `startPluginServices` awaits every service's `start()` in
    // sequence before the gateway is ready — awaiting the batch here would hang startup on
    // it. `start()` itself must return synchronously; the scan keeps running in the
    // background afterward.
    api.registerService({
      id: "video-chapters-batch-index",
      start: (ctx: OpenClawPluginServiceContext) => {
        const watchDirs = resolveVideoChaptersWatchDirs(ctx.config);
        if (watchDirs.length === 0) {
          return;
        }
        const toolDir = resolveVideoChaptersToolDir(ctx.config);
        const embeddings = resolveVideoChaptersEmbeddingsConfig(
          resolveVideoChaptersEmbeddingsRaw(ctx.config),
        );
        void runVideoChaptersBatchIndex({
          toolDir,
          watchDirs,
          embeddings,
          logger: ctx.logger,
        }).catch((err) => {
          ctx.logger.error(`video-chapters: startup batch index failed: ${String(err)}`);
        });
      },
    });
  },
});
