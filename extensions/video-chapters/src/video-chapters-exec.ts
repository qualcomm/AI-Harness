// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const VIDEO_CHAPTERS_TIMEOUT_MS = 20 * 60 * 1000;
export const VIDEO_CHAPTERS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const VIDEO_CHAPTERS_FRAME_TIMEOUT_MS = 30 * 1000;

const EXE_NAME = "video_chapters.exe";
const FFMPEG_RELATIVE_PATH = path.join("ffmpeg", "ffmpeg.exe");

/**
 * `video_chapters.exe` shells out to its own bundled ffmpeg/whisper-cli for the actual
 * frame/transcription work. Node's own child.kill() only signals the exe itself, leaving
 * those descendants running (and the NPU pegged) after a timeout — `taskkill /T` kills the
 * whole process tree instead. Best-effort: a failed taskkill just leaves the orphan running,
 * which is the pre-existing behavior this replaces, not a new failure mode.
 */
function killProcessTreeWindows(pid: number): void {
  try {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // Best-effort cleanup; nothing more to do if taskkill itself fails to spawn.
  }
}

export function isVideoChaptersSupportedPlatform(): boolean {
  return process.platform === "win32" && process.arch === "arm64";
}

export function chaptersSidecarPathFor(videoPath: string): string {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}_chapters.json`);
}

export type ChapterSegment = {
  start: number;
  end: number;
  title: string;
  desc: string;
};

/** Reads and validates the `segments` array out of an existing chapters sidecar file. */
export function readChapterSegments(videoPath: string): ChapterSegment[] {
  const sidecarPath = chaptersSidecarPathFor(videoPath);
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(
      `No chapters found for this video: ${sidecarPath} is missing. ` +
        "Run video_chapters_summarize on it first.",
    );
  }
  const raw = fs.readFileSync(sidecarPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse chapters JSON at ${sidecarPath}`);
  }
  const segments = (parsed as { segments?: unknown })?.segments;
  if (!Array.isArray(segments)) {
    throw new Error(`Chapters JSON at ${sidecarPath} has no segments array`);
  }
  return segments as ChapterSegment[];
}

function requireToolDir(toolDir: string | undefined): string {
  const trimmed = toolDir?.trim();
  if (!trimmed) {
    throw new Error(
      "video_chapters_summarize needs plugins.entries.video-chapters.config.toolDir " +
        "to be set to the folder containing video_chapters.exe.",
    );
  }
  if (!fs.existsSync(path.join(trimmed, EXE_NAME))) {
    throw new Error(`video_chapters.exe not found under toolDir: ${trimmed}`);
  }
  return trimmed;
}

function resolveBundledFfmpegPath(toolDir: string): string {
  const ffmpegPath = path.join(toolDir, FFMPEG_RELATIVE_PATH);
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(`Bundled ffmpeg.exe not found under toolDir: ${ffmpegPath}`);
  }
  return ffmpegPath;
}

/**
 * Runs the exe via `spawn` (not `execFile`'s built-in `timeout`) so a timeout can be
 * followed by `killProcessTree`. `video_chapters.exe` shells out to its own bundled
 * ffmpeg/whisper-cli for the actual frame/transcription work; killing only the exe
 * itself leaves those descendants running (and the NPU pegged) after we give up.
 */
function runExeWithTimeout(params: {
  exePath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
  /** Prefixes timeout/exit-code error messages, e.g. "video_chapters.exe summarize". */
  label: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.exePath, params.args, { cwd: params.cwd });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessTreeWindows(child.pid);
      }
    }, params.timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < params.maxBufferBytes) {
        stderr += chunk.toString();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(`${params.label} timed out after ${params.timeoutMs}ms and was killed`),
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`${params.label} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

export async function runVideoChaptersSummarize(params: {
  toolDir: string | undefined;
  videoPath: string;
  maxTokens?: number;
}): Promise<Record<string, unknown>> {
  if (!isVideoChaptersSupportedPlatform()) {
    throw new Error(
      "video_chapters_summarize is only available on Windows ARM64 (this host is " +
        `${process.platform}/${process.arch}).`,
    );
  }
  const toolDir = requireToolDir(params.toolDir);
  if (!fs.existsSync(params.videoPath)) {
    throw new Error(`Video file not found: ${params.videoPath}`);
  }

  const args = [
    "summarize",
    params.videoPath,
    ...(params.maxTokens ? ["--max-tokens", String(params.maxTokens)] : []),
  ];
  try {
    await runExeWithTimeout({
      exePath: path.join(toolDir, EXE_NAME),
      args,
      cwd: toolDir,
      timeoutMs: VIDEO_CHAPTERS_TIMEOUT_MS,
      maxBufferBytes: VIDEO_CHAPTERS_MAX_BUFFER_BYTES,
      label: "video_chapters.exe summarize",
    });
  } catch (err) {
    throw new Error(`video_chapters.exe summarize failed: ${(err as Error).message}`);
  }

  const sidecarPath = chaptersSidecarPathFor(params.videoPath);
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(
      `video_chapters.exe reported success but the expected output file is missing: ${sidecarPath}`,
    );
  }
  const raw = fs.readFileSync(sidecarPath, "utf-8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse chapters JSON at ${sidecarPath}`);
  }
}

/**
 * Extracts a single still frame at `timestampSeconds` via the ffmpeg bundled alongside
 * `video_chapters.exe`, so search results can show what a matched moment actually looks like.
 */
export async function extractVideoFrame(params: {
  toolDir: string | undefined;
  videoPath: string;
  timestampSeconds: number;
  outputPath: string;
}): Promise<void> {
  if (!isVideoChaptersSupportedPlatform()) {
    throw new Error(
      "video frame extraction is only available on Windows ARM64 (this host is " +
        `${process.platform}/${process.arch}).`,
    );
  }
  const toolDir = requireToolDir(params.toolDir);
  const ffmpegPath = resolveBundledFfmpegPath(toolDir);
  if (!fs.existsSync(params.videoPath)) {
    throw new Error(`Video file not found: ${params.videoPath}`);
  }
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });

  const args = [
    "-y",
    "-ss",
    String(params.timestampSeconds),
    "-i",
    params.videoPath,
    "-frames:v",
    "1",
    params.outputPath,
  ];
  try {
    await runExeWithTimeout({
      exePath: ffmpegPath,
      args,
      cwd: toolDir,
      timeoutMs: VIDEO_CHAPTERS_FRAME_TIMEOUT_MS,
      maxBufferBytes: VIDEO_CHAPTERS_MAX_BUFFER_BYTES,
      label: "ffmpeg frame extraction",
    });
  } catch (err) {
    throw new Error(`ffmpeg frame extraction failed: ${(err as Error).message}`);
  }
  if (!fs.existsSync(params.outputPath)) {
    throw new Error(`ffmpeg reported success but no frame was written: ${params.outputPath}`);
  }
}
