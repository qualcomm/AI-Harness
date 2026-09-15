// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { searchVideoChapterSegments, searchAllIndexedSegments, extractVideoFrame, imageResultFromFile } =
  vi.hoisted(() => ({
    searchVideoChapterSegments: vi.fn(async () => [
      { start: 0, end: 6, title: "Basketball Action", desc: "A player dribbles.", score: 0.9 },
    ]),
    searchAllIndexedSegments: vi.fn(async () => [
      {
        video: "C:\\videos\\ouwen.mp4",
        start: 0,
        end: 6,
        title: "Basketball Action",
        desc: "A player dribbles.",
        score: 0.9,
      },
    ]),
    extractVideoFrame: vi.fn(async () => {}),
    imageResultFromFile: vi.fn(async (params: { label: string; path: string }) => ({
      content: [{ type: "image", data: `fake:${params.path}`, mimeType: "image/jpeg" }],
      details: { path: params.path },
    })),
  }));

vi.mock("../src/video-chapters-index.js", () => ({
  searchVideoChapterSegments,
  searchAllIndexedSegments,
}));

vi.mock("../src/video-chapters-exec.js", async () => {
  const actual = await vi.importActual<typeof import("../src/video-chapters-exec.js")>(
    "../src/video-chapters-exec.js",
  );
  return { ...actual, extractVideoFrame };
});

vi.mock("openclaw/plugin-sdk/browser-setup-tools", () => ({ imageResultFromFile }));

import { createVideoChaptersSearchTool } from "../src/video-chapters-search-tool.js";

function fakeApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return { pluginConfig } as unknown as OpenClawPluginApi;
}

describe("video_chapters_search tool", () => {
  let videoPath: string;
  let sidecarPath: string;

  beforeEach(() => {
    searchVideoChapterSegments.mockClear();
    searchAllIndexedSegments.mockClear();
    extractVideoFrame.mockClear();
    extractVideoFrame.mockResolvedValue(undefined);
    imageResultFromFile.mockClear();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-chapters-search-test-"));
    videoPath = path.join(dir, "sample.mp4");
    sidecarPath = path.join(dir, "sample_chapters.json");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(sidecarPath), { recursive: true, force: true });
  });

  it("throws when the chapters sidecar file is missing", async () => {
    const tool = createVideoChaptersSearchTool(fakeApi());
    await expect(
      tool.execute("call-1", { video: videoPath, query: "dunk" }),
    ).rejects.toThrow("Run video_chapters_summarize");
    expect(searchVideoChapterSegments).not.toHaveBeenCalled();
  });

  it("throws when the sidecar file is not valid json", async () => {
    fs.writeFileSync(sidecarPath, "not json");
    const tool = createVideoChaptersSearchTool(fakeApi());
    await expect(tool.execute("call-2", { video: videoPath, query: "dunk" })).rejects.toThrow(
      "Failed to parse chapters JSON",
    );
  });

  it("throws when the sidecar file has no segments array", async () => {
    fs.writeFileSync(sidecarPath, JSON.stringify({ video: videoPath }));
    const tool = createVideoChaptersSearchTool(fakeApi());
    await expect(tool.execute("call-3", { video: videoPath, query: "dunk" })).rejects.toThrow(
      "no segments array",
    );
  });

  it("passes segments, query, default top_k, and resolved embeddings config through", async () => {
    const segments = [{ start: 0, end: 6, title: "Basketball Action", desc: "A player dribbles." }];
    fs.writeFileSync(sidecarPath, JSON.stringify({ segments }));
    const tool = createVideoChaptersSearchTool(
      fakeApi({ embeddings: { baseUrl: "http://127.0.0.1:8899/v1", model: "bge-m3" } }),
    );

    await tool.execute("call-4", { video: videoPath, query: "dunk" });

    expect(searchVideoChapterSegments).toHaveBeenCalledWith({
      videoPath,
      segments,
      query: "dunk",
      topK: 5,
      embeddings: {
        baseUrl: "http://127.0.0.1:8899/v1",
        apiKey: "video-chapters",
        model: "bge-m3",
        dimensions: 1024,
      },
    });
  });

  it("honors an explicit top_k", async () => {
    fs.writeFileSync(sidecarPath, JSON.stringify({ segments: [] }));
    const tool = createVideoChaptersSearchTool(fakeApi());

    await tool.execute("call-5", { video: videoPath, query: "dunk", top_k: 2 });

    expect(searchVideoChapterSegments).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 2 }),
    );
  });

  it("returns the matches from the index as the tool's json result", async () => {
    fs.writeFileSync(sidecarPath, JSON.stringify({ segments: [] }));
    const tool = createVideoChaptersSearchTool(fakeApi());

    const result = await tool.execute("call-6", { video: videoPath, query: "dunk" });

    expect(result.details).toEqual({
      matches: [
        { start: 0, end: 6, title: "Basketball Action", desc: "A player dribbles.", score: 0.9 },
      ],
    });
  });

  it("searches the whole indexed library, not a specific video, when `video` is omitted", async () => {
    const tool = createVideoChaptersSearchTool(fakeApi());

    const result = await tool.execute("call-7", { query: "dunk" });

    expect(searchAllIndexedSegments).toHaveBeenCalledWith({
      query: "dunk",
      topK: 5,
      embeddings: expect.objectContaining({ model: "bge-m3" }),
    });
    expect(searchVideoChapterSegments).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      matches: [
        {
          video: "C:\\videos\\ouwen.mp4",
          start: 0,
          end: 6,
          title: "Basketball Action",
          desc: "A player dribbles.",
          score: 0.9,
        },
      ],
    });
  });

  it("honors an explicit top_k for the whole-library search too", async () => {
    const tool = createVideoChaptersSearchTool(fakeApi());

    await tool.execute("call-8", { query: "dunk", top_k: 3 });

    expect(searchAllIndexedSegments).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 3 }),
    );
  });

  describe("frame attachment", () => {
    function fiveMatches() {
      return Array.from({ length: 5 }, (_, i) => ({
        video: `C:\\videos\\v${i}.mp4`,
        start: i,
        end: i + 1,
        title: `Match ${i}`,
        desc: `desc ${i}`,
        score: 1 - i * 0.1,
      }));
    }

    it("extracts frames for at most the top 3 matches, using each match's own video", async () => {
      searchAllIndexedSegments.mockResolvedValueOnce(fiveMatches());
      const tool = createVideoChaptersSearchTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

      const result = await tool.execute("call-9", { query: "dunk" });

      expect(extractVideoFrame).toHaveBeenCalledTimes(3);
      expect(extractVideoFrame).toHaveBeenNthCalledWith(1, expect.objectContaining({
        toolDir: "C:\\tools\\vc",
        videoPath: "C:\\videos\\v0.mp4",
        timestampSeconds: 0,
      }));
      expect(imageResultFromFile).toHaveBeenCalledTimes(3);
      const imageBlocks = result.content.filter((block: { type: string }) => block.type === "image");
      expect(imageBlocks).toHaveLength(3);
    });

    it("uses the given `video` param (not per-match data) for a scoped search", async () => {
      fs.writeFileSync(sidecarPath, JSON.stringify({ segments: [] }));
      const tool = createVideoChaptersSearchTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

      await tool.execute("call-10", { video: videoPath, query: "dunk" });

      expect(extractVideoFrame).toHaveBeenCalledWith(
        expect.objectContaining({ videoPath, timestampSeconds: 0 }),
      );
    });

    it("drops only the failing match's image, keeping the rest of the result intact", async () => {
      searchAllIndexedSegments.mockResolvedValueOnce(fiveMatches().slice(0, 2));
      extractVideoFrame.mockRejectedValueOnce(new Error("ffmpeg frame extraction failed"));
      const tool = createVideoChaptersSearchTool(fakeApi({ toolDir: "C:\\tools\\vc" }));

      const result = await tool.execute("call-11", { query: "dunk" });

      expect(imageResultFromFile).toHaveBeenCalledTimes(1);
      const imageBlocks = result.content.filter((block: { type: string }) => block.type === "image");
      expect(imageBlocks).toHaveLength(1);
      // The text/json result is untouched by the partial frame failure.
      expect(result.details).toEqual({ matches: fiveMatches().slice(0, 2) });
    });
  });
});
