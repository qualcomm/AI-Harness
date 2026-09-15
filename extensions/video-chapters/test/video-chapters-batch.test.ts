// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runVideoChaptersSummarize, readChapterSegments, ensureVideoIndexed } = vi.hoisted(() => ({
  runVideoChaptersSummarize: vi.fn(async (_params: { videoPath: string }) => ({})),
  readChapterSegments: vi.fn(() => [{ start: 0, end: 1, title: "t", desc: "d" }]),
  ensureVideoIndexed: vi.fn(async () => {}),
}));

vi.mock("../src/video-chapters-exec.js", async () => {
  const actual = await vi.importActual<typeof import("../src/video-chapters-exec.js")>(
    "../src/video-chapters-exec.js",
  );
  return {
    ...actual,
    runVideoChaptersSummarize,
    readChapterSegments,
  };
});

vi.mock("../src/video-chapters-index.js", () => ({
  ensureVideoIndexed,
}));

import {
  listMp4Files,
  needsSummarize,
  runVideoChaptersBatchIndex,
} from "../src/video-chapters-batch.js";

const EMBEDDINGS_CONFIG = {
  baseUrl: "http://127.0.0.1:8899/v1",
  apiKey: "test",
  model: "bge-m3",
  dimensions: 4,
};

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("listMp4Files", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-scan-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds .mp4 files recursively and ignores other extensions", () => {
    fs.writeFileSync(path.join(root, "a.mp4"), "");
    fs.writeFileSync(path.join(root, "notes.txt"), "");
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "B.MP4"), "");

    const found = listMp4Files([root]).toSorted();
    expect(found).toEqual([path.join(nested, "B.MP4"), path.join(root, "a.mp4")].toSorted());
  });

  it("logs a warning and keeps going when a directory can't be read", () => {
    const missing = path.join(root, "does-not-exist");
    fs.writeFileSync(path.join(root, "a.mp4"), "");
    const logger = fakeLogger();

    const found = listMp4Files([missing, root], logger);

    expect(found).toEqual([path.join(root, "a.mp4")]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(missing));
  });
});

describe("needsSummarize", () => {
  let dir: string;
  let videoPath: string;
  let sidecarPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-needs-test-"));
    videoPath = path.join(dir, "v.mp4");
    sidecarPath = path.join(dir, "v_chapters.json");
    fs.writeFileSync(videoPath, "");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is true when the sidecar doesn't exist yet", () => {
    expect(needsSummarize(videoPath, sidecarPath)).toBe(true);
  });

  it("is false when the sidecar is newer than the video", () => {
    fs.writeFileSync(sidecarPath, "{}");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sidecarPath, future, future);
    expect(needsSummarize(videoPath, sidecarPath)).toBe(false);
  });

  it("is true when the video changed after the sidecar was written", () => {
    fs.writeFileSync(sidecarPath, "{}");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(videoPath, future, future);
    expect(needsSummarize(videoPath, sidecarPath)).toBe(true);
  });
});

describe("runVideoChaptersBatchIndex", () => {
  let root: string;

  beforeEach(() => {
    runVideoChaptersSummarize.mockClear();
    readChapterSegments.mockClear();
    ensureVideoIndexed.mockClear();
    readChapterSegments.mockReturnValue([{ start: 0, end: 1, title: "t", desc: "d" }]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-batch-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("summarizes videos that have no sidecar yet, then indexes them", async () => {
    const videoPath = path.join(root, "a.mp4");
    fs.writeFileSync(videoPath, "");
    const logger = fakeLogger();

    await runVideoChaptersBatchIndex({
      toolDir: "C:\\tools\\vc",
      watchDirs: [root],
      embeddings: EMBEDDINGS_CONFIG,
      logger,
    });

    expect(runVideoChaptersSummarize).toHaveBeenCalledWith({ toolDir: "C:\\tools\\vc", videoPath });
    expect(ensureVideoIndexed).toHaveBeenCalledWith({
      videoPath,
      segments: [{ start: 0, end: 1, title: "t", desc: "d" }],
      embeddings: EMBEDDINGS_CONFIG,
    });
  });

  it("skips re-summarizing a video whose sidecar is already up to date", async () => {
    const videoPath = path.join(root, "a.mp4");
    const sidecarPath = path.join(root, "a_chapters.json");
    fs.writeFileSync(videoPath, "");
    fs.writeFileSync(sidecarPath, "{}");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sidecarPath, future, future);

    await runVideoChaptersBatchIndex({
      toolDir: undefined,
      watchDirs: [root],
      embeddings: EMBEDDINGS_CONFIG,
      logger: fakeLogger(),
    });

    expect(runVideoChaptersSummarize).not.toHaveBeenCalled();
    expect(ensureVideoIndexed).toHaveBeenCalledOnce();
  });

  it("logs and continues past a video that fails, instead of aborting the batch", async () => {
    const failing = path.join(root, "bad.mp4");
    const good = path.join(root, "good.mp4");
    fs.writeFileSync(failing, "");
    fs.writeFileSync(good, "");
    runVideoChaptersSummarize.mockImplementation(async (params: { videoPath: string }) => {
      if (params.videoPath === failing) {
        throw new Error("exe crashed");
      }
      return {};
    });
    const logger = fakeLogger();

    await runVideoChaptersBatchIndex({
      toolDir: undefined,
      watchDirs: [root],
      embeddings: EMBEDDINGS_CONFIG,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("exe crashed"));
    // the good video still gets processed even though the first one failed.
    expect(ensureVideoIndexed).toHaveBeenCalledOnce();
    expect(ensureVideoIndexed).toHaveBeenCalledWith(expect.objectContaining({ videoPath: good }));
  });
});
