// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { imageResultFromFile } from "openclaw/plugin-sdk/browser-setup-tools";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveVideoChaptersEmbeddingsConfig } from "./video-chapters-embeddings.js";
import { extractVideoFrame, readChapterSegments } from "./video-chapters-exec.js";
import {
  searchAllIndexedSegments,
  searchVideoChapterSegments,
  type SegmentMatch,
} from "./video-chapters-index.js";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
/** Only the strongest matches get a still frame; extracting one per result would be too slow. */
const MAX_FRAME_MATCHES = 3;
const FRAME_CACHE_SUBDIR = "video-chapters-frames";

type VideoChaptersPluginConfig = {
  toolDir?: unknown;
  embeddings?: unknown;
};

/**
 * Frames go under the host's preferred temp dir, NOT a bare `os.tmpdir()` subdirectory: the
 * Control UI only previews assistant media whose path falls inside the host's media local
 * roots (which include this dir), and rejects anything else with "Outside allowed folders".
 *
 * Resolved lazily and cached — the resolver touches the filesystem, so doing it at module load
 * would run on plugin import even for calls that never extract a frame.
 */
let cachedFrameCacheDir: string | undefined;

function frameCacheDir(): string {
  if (!cachedFrameCacheDir) {
    cachedFrameCacheDir = path.join(resolvePreferredOpenClawTmpDir(), FRAME_CACHE_SUBDIR);
  }
  return cachedFrameCacheDir;
}

function frameOutputPath(videoPath: string, timestampSeconds: number): string {
  const key = createHash("sha256")
    .update(`${videoPath}@${timestampSeconds}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(frameCacheDir(), `${key}.jpg`);
}

/**
 * Extracts (or reuses a cached) still frame for each of the top `MAX_FRAME_MATCHES` matches
 * and appends them as image content blocks. A single match's extraction failing (e.g. an
 * unreadable codec) just drops that one image — the text matches are still returned in full.
 */
async function attachFrames<T extends SegmentMatch>(
  base: AgentToolResult<unknown>,
  matches: T[],
  toolDir: string | undefined,
  resolveVideoPath: (match: T) => string,
): Promise<AgentToolResult<unknown>> {
  const top = matches.slice(0, MAX_FRAME_MATCHES);
  const images = await Promise.all(
    top.map(async (match) => {
      const videoPath = resolveVideoPath(match);
      const outputPath = frameOutputPath(videoPath, match.start);
      try {
        if (!fs.existsSync(outputPath)) {
          await extractVideoFrame({
            toolDir,
            videoPath,
            timestampSeconds: match.start,
            outputPath,
          });
        }
        return await imageResultFromFile({
          label: match.title,
          path: outputPath,
          extraText: `${match.start}s–${match.end}s: ${match.desc}`,
        });
      } catch {
        return null;
      }
    }),
  );
  const imageContent = images
    .filter((image): image is Awaited<ReturnType<typeof imageResultFromFile>> => image !== null)
    .flatMap((image) => image.content);
  return { ...base, content: [...base.content, ...imageContent] };
}

const VideoChaptersSearchToolSchema = Type.Object(
  {
    video: Type.Optional(
      Type.String({
        description:
          "Absolute path to a specific local video file to search within (must already have a " +
          "<video>_chapters.json sidecar). Omit to search across every video already indexed " +
          "(e.g. by the startup batch scan) instead of one specific video.",
      }),
    ),
    query: Type.String({
      description: "Natural-language description of the moment to locate.",
    }),
    top_k: Type.Optional(
      Type.Number({
        description: `Number of matching segments to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`,
        minimum: 1,
        maximum: MAX_TOP_K,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createVideoChaptersSearchTool(api: OpenClawPluginApi) {
  return {
    name: "video_chapters_search",
    label: "Video Chapters Search",
    description:
      "Find the video segment (start/end timestamps) matching a natural-language description. " +
      "Pass `video` to search within one specific, already-summarized video, or omit it to search " +
      "across every video already indexed in the shared library (returns which video matched too).",
    parameters: VideoChaptersSearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const video = readStringParam(rawParams, "video");
      const query = readStringParam(rawParams, "query", { required: true });
      const topK = readNumberParam(rawParams, "top_k", { integer: true }) ?? DEFAULT_TOP_K;

      const pluginCfg = (api.pluginConfig ?? {}) as VideoChaptersPluginConfig;
      const toolDir = typeof pluginCfg.toolDir === "string" ? pluginCfg.toolDir : undefined;
      const embeddings = resolveVideoChaptersEmbeddingsConfig(
        pluginCfg.embeddings as Record<string, unknown> | undefined,
      );

      if (!video) {
        const matches = await searchAllIndexedSegments({ query, topK, embeddings });
        return attachFrames(jsonResult({ matches }), matches, toolDir, (match) => match.video);
      }

      const segments = readChapterSegments(video);
      const matches = await searchVideoChapterSegments({
        videoPath: video,
        segments,
        query,
        topK,
        embeddings,
      });
      return attachFrames(jsonResult({ matches }), matches, toolDir, () => video);
    },
  };
}
