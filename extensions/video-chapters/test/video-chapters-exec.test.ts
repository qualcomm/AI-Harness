// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnMock,
    },
  );
});

import {
  chaptersSidecarPathFor,
  extractVideoFrame,
  isVideoChaptersSupportedPlatform,
  runVideoChaptersSummarize,
  VIDEO_CHAPTERS_TIMEOUT_MS,
} from "../src/video-chapters-exec.js";

type MockChild = EventEmitter & { stderr: EventEmitter; pid: number };

function createMockChild(pid = 4321): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stderr = new EventEmitter();
  child.pid = pid;
  return child;
}

function mockPlatform(platform: string, arch: string) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
  vi.spyOn(process, "arch", "get").mockReturnValue(arch as NodeJS.Architecture);
}

/** The exe call is the first spawn(); any later spawn() (taskkill) gets its own child. */
function mockExeChild(): MockChild {
  const child = createMockChild();
  spawnMock.mockImplementationOnce(() => child);
  return child;
}

function succeedExec() {
  const child = mockExeChild();
  queueMicrotask(() => child.emit("close", 0));
}

function failExec(stderr: string) {
  const child = mockExeChild();
  queueMicrotask(() => {
    child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", 1);
  });
}

describe("isVideoChaptersSupportedPlatform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true on Windows ARM64", () => {
    mockPlatform("win32", "arm64");
    expect(isVideoChaptersSupportedPlatform()).toBe(true);
  });

  it("is false on Windows x64", () => {
    mockPlatform("win32", "x64");
    expect(isVideoChaptersSupportedPlatform()).toBe(false);
  });

  it("is false on non-Windows ARM64", () => {
    mockPlatform("darwin", "arm64");
    expect(isVideoChaptersSupportedPlatform()).toBe(false);
  });
});

describe("chaptersSidecarPathFor", () => {
  it("appends _chapters.json to the video's basename, same directory", () => {
    const video = path.join("C:", "Users", "HCKTest", "ouwen.mp4");
    expect(chaptersSidecarPathFor(video)).toBe(
      path.join("C:", "Users", "HCKTest", "ouwen_chapters.json"),
    );
  });
});

describe("runVideoChaptersSummarize", () => {
  let toolDir: string;
  let videoPath: string;

  beforeEach(() => {
    mockPlatform("win32", "arm64");
    spawnMock.mockReset();
    toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-test-"));
    fs.writeFileSync(path.join(toolDir, "video_chapters.exe"), "");
    videoPath = path.join(toolDir, "sample.mp4");
    fs.writeFileSync(videoPath, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(toolDir, { recursive: true, force: true });
  });

  it("rejects on unsupported platforms", async () => {
    mockPlatform("win32", "x64");
    await expect(runVideoChaptersSummarize({ toolDir, videoPath })).rejects.toThrow(
      "only available on Windows ARM64",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects when toolDir is not configured", async () => {
    await expect(
      runVideoChaptersSummarize({ toolDir: undefined, videoPath }),
    ).rejects.toThrow("toolDir");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects when video_chapters.exe is missing from toolDir", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-empty-"));
    try {
      await expect(
        runVideoChaptersSummarize({ toolDir: emptyDir, videoPath }),
      ).rejects.toThrow("video_chapters.exe not found");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("rejects when the video file does not exist", async () => {
    await expect(
      runVideoChaptersSummarize({
        toolDir,
        videoPath: path.join(toolDir, "missing.mp4"),
      }),
    ).rejects.toThrow("Video file not found");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs the exe and returns the parsed sidecar json", async () => {
    const sidecarPath = chaptersSidecarPathFor(videoPath);
    fs.writeFileSync(sidecarPath, JSON.stringify({ summary: "a video", tags: ["x"] }));
    succeedExec();

    const result = await runVideoChaptersSummarize({ toolDir, videoPath });

    expect(result).toEqual({ summary: "a video", tags: ["x"] });
    expect(spawnMock).toHaveBeenCalledWith(
      path.join(toolDir, "video_chapters.exe"),
      ["summarize", videoPath],
      expect.objectContaining({ cwd: toolDir }),
    );
  });

  it("passes --max-tokens through to the exe", async () => {
    fs.writeFileSync(chaptersSidecarPathFor(videoPath), JSON.stringify({ summary: "ok" }));
    succeedExec();

    await runVideoChaptersSummarize({ toolDir, videoPath, maxTokens: 256 });

    expect(spawnMock).toHaveBeenCalledWith(
      path.join(toolDir, "video_chapters.exe"),
      ["summarize", videoPath, "--max-tokens", "256"],
      expect.objectContaining({ cwd: toolDir }),
    );
  });

  it("surfaces the exe's stderr when it exits non-zero", async () => {
    failExec("annotate failed: unsupported codec");
    await expect(runVideoChaptersSummarize({ toolDir, videoPath })).rejects.toThrow(
      "unsupported codec",
    );
  });

  it("throws when the exe succeeds but never writes the sidecar file", async () => {
    succeedExec();
    await expect(runVideoChaptersSummarize({ toolDir, videoPath })).rejects.toThrow(
      "expected output file is missing",
    );
  });

  it("throws when the sidecar file is not valid json", async () => {
    fs.writeFileSync(chaptersSidecarPathFor(videoPath), "not json");
    succeedExec();
    await expect(runVideoChaptersSummarize({ toolDir, videoPath })).rejects.toThrow(
      "Failed to parse chapters JSON",
    );
  });

  /**
   * The 2026-09-07 target-machine run: the exe was killed by our own timeout, but ffmpeg/
   * whisper-cli (its children) kept the NPU pegged afterward, because Node's own kill only
   * signals the direct child. This pins that a timeout now also spawns `taskkill /T` against
   * the exe's pid, which recursively kills its descendants too.
   */
  it("kills the whole process tree via taskkill when the exe exceeds the timeout", async () => {
    vi.useFakeTimers();
    const execChild = mockExeChild();
    const taskkillChild = createMockChild();
    spawnMock.mockImplementationOnce(() => taskkillChild);

    const pending = runVideoChaptersSummarize({ toolDir, videoPath });
    await vi.advanceTimersByTimeAsync(VIDEO_CHAPTERS_TIMEOUT_MS);

    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", String(execChild.pid)],
      expect.objectContaining({ detached: true }),
    );

    execChild.emit("close", null);
    await expect(pending).rejects.toThrow("timed out after");
  });
});

describe("extractVideoFrame", () => {
  let toolDir: string;
  let videoPath: string;
  let outputPath: string;

  beforeEach(() => {
    mockPlatform("win32", "arm64");
    spawnMock.mockReset();
    toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-frame-test-"));
    fs.writeFileSync(path.join(toolDir, "video_chapters.exe"), "");
    videoPath = path.join(toolDir, "sample.mp4");
    fs.writeFileSync(videoPath, "");
    outputPath = path.join(toolDir, "frames", "out.jpg");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(toolDir, { recursive: true, force: true });
  });

  function succeedFfmpeg() {
    const child = mockExeChild();
    // ffmpeg actually needs to have written the output file by the time it exits.
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "fake-jpeg-bytes");
    queueMicrotask(() => child.emit("close", 0));
  }

  it("rejects when ffmpeg/ffmpeg.exe doesn't exist under toolDir", async () => {
    await expect(
      extractVideoFrame({ toolDir, videoPath, timestampSeconds: 1, outputPath }),
    ).rejects.toThrow("Bundled ffmpeg.exe not found");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs the nested ffmpeg/ffmpeg.exe with the expected args", async () => {
    fs.mkdirSync(path.join(toolDir, "ffmpeg"));
    fs.writeFileSync(path.join(toolDir, "ffmpeg", "ffmpeg.exe"), "");
    succeedFfmpeg();

    await extractVideoFrame({ toolDir, videoPath, timestampSeconds: 12, outputPath });

    expect(spawnMock).toHaveBeenCalledWith(
      path.join(toolDir, "ffmpeg", "ffmpeg.exe"),
      ["-y", "-ss", "12", "-i", videoPath, "-frames:v", "1", outputPath],
      expect.objectContaining({ cwd: toolDir }),
    );
  });

  it("throws when ffmpeg exits non-zero", async () => {
    fs.mkdirSync(path.join(toolDir, "ffmpeg"));
    fs.writeFileSync(path.join(toolDir, "ffmpeg", "ffmpeg.exe"), "");
    failExec("unsupported codec");

    await expect(
      extractVideoFrame({ toolDir, videoPath, timestampSeconds: 1, outputPath }),
    ).rejects.toThrow("unsupported codec");
  });

  it("throws when ffmpeg exits 0 but never wrote the frame", async () => {
    fs.mkdirSync(path.join(toolDir, "ffmpeg"));
    fs.writeFileSync(path.join(toolDir, "ffmpeg", "ffmpeg.exe"), "");
    const child = mockExeChild();
    queueMicrotask(() => child.emit("close", 0));

    await expect(
      extractVideoFrame({ toolDir, videoPath, timestampSeconds: 1, outputPath }),
    ).rejects.toThrow("no frame was written");
  });
});
