// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs";
import path from "node:path";
import type { VideoChaptersEmbeddingsConfig } from "./video-chapters-embeddings.js";
import {
  chaptersSidecarPathFor,
  readChapterSegments,
  runVideoChaptersSummarize,
} from "./video-chapters-exec.js";
import { ensureVideoIndexed } from "./video-chapters-index.js";

export type BatchLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

const MP4_EXTENSION = ".mp4";

/**
 * Recursively lists every `.mp4` under `dirs`. Best-effort: a directory that can't be read
 * (permissions, a broken junction) is skipped with a warning rather than aborting the whole
 * scan — one bad folder in a user-supplied list shouldn't block every other one.
 */
export function listMp4Files(dirs: string[], logger?: BatchLogger): string[] {
  const found: string[] = [];
  const stack = [...dirs];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    const resolved = path.resolve(dir);
    if (visited.has(resolved)) {
      continue;
    }
    visited.add(resolved);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
      logger?.warn(`video-chapters: skipping unreadable directory ${resolved}: ${String(err)}`);
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === MP4_EXTENSION) {
        found.push(fullPath);
      }
    }
  }
  return found;
}

/** A video needs (re)summarizing when it has no chapters sidecar yet, or the video changed since. */
export function needsSummarize(videoPath: string, sidecarPath: string): boolean {
  if (!fs.existsSync(sidecarPath)) {
    return true;
  }
  return fs.statSync(videoPath).mtimeMs > fs.statSync(sidecarPath).mtimeMs;
}

/**
 * Startup batch job: summarize + index every `.mp4` under `watchDirs` that is new or has
 * changed since it was last processed. Runs sequentially, not in parallel — a single
 * `video_chapters.exe` run already saturates the NPU (see the 2026-09-07 timeout
 * investigation), so running several at once would only make each one slower, not the
 * batch faster.
 *
 * Errors on one video are logged and skipped rather than aborting the batch — a single
 * corrupt or unsupported file shouldn't stop the rest of the library from getting indexed.
 */
export async function runVideoChaptersBatchIndex(params: {
  toolDir: string | undefined;
  watchDirs: string[];
  embeddings: VideoChaptersEmbeddingsConfig;
  logger: BatchLogger;
}): Promise<void> {
  const { toolDir, watchDirs, embeddings, logger } = params;
  const videos = listMp4Files(watchDirs, logger);
  logger.info(`video-chapters: batch scan found ${videos.length} .mp4 file(s) under ${watchDirs.length} dir(s)`);

  let processed = 0;
  let skippedErrors = 0;
  for (const [i, videoPath] of videos.entries()) {
    try {
      const sidecarPathBefore = chaptersSidecarPathFor(videoPath);
      if (needsSummarize(videoPath, sidecarPathBefore)) {
        logger.info(`video-chapters: summarizing (${i + 1}/${videos.length}) ${videoPath}`);
        await runVideoChaptersSummarize({ toolDir, videoPath });
      }
      const segments = readChapterSegments(videoPath);
      await ensureVideoIndexed({ videoPath, segments, embeddings });
      processed += 1;
    } catch (err) {
      skippedErrors += 1;
      logger.warn(`video-chapters: skipping ${videoPath}: ${String(err)}`);
    }
  }
  logger.info(
    `video-chapters: batch index complete — ${processed} indexed, ${skippedErrors} skipped due to errors`,
  );
}
