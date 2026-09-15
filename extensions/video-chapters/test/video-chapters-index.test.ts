// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/**
 * Extracts the quoted value out of a `<col> = '<value>'` or `<col> = "<value>"` filter
 * string this module builds — the schema-placeholder cleanup uses double quotes
 * (`id = "__schema__"`), everything else uses single quotes.
 */
function filterValue(where: string): string {
  const match = where.match(/=\s*['"]([^'"]*)['"]/);
  if (!match) {
    throw new Error(`unparseable test filter: ${where}`);
  }
  return match[1];
}

function createFakeTable(rows: Row[]) {
  return {
    delete: vi.fn(async (where: string) => {
      const value = filterValue(where);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].videoKey === value || rows[i].id === value) {
          rows.splice(i, 1);
        }
      }
    }),
    add: vi.fn(async (newRows: Row[]) => {
      rows.push(...newRows);
    }),
    query: vi.fn(() => {
      let whereClause = "";
      const builder = {
        where: vi.fn((clause: string) => {
          whereClause = clause;
          return builder;
        }),
        limit: vi.fn((_n: number) => builder),
        toArray: vi.fn(async () => rows.filter((r) => r.videoKey === filterValue(whereClause))),
      };
      return builder;
    }),
    vectorSearch: vi.fn((_vector: number[]) => {
      let whereClause: string | null = null;
      let limitN = rows.length;
      const builder = {
        where: vi.fn((clause: string) => {
          whereClause = clause;
          return builder;
        }),
        limit: vi.fn((n: number) => {
          limitN = n;
          return builder;
        }),
        toArray: vi.fn(async () =>
          (whereClause === null
            ? rows
            : rows.filter((r) => r.videoKey === filterValue(whereClause!)))
            .slice(0, limitN)
            .map((r) => ({ ...r, _distance: 0 })),
        ),
      };
      return builder;
    }),
  };
}

const { connectMock, embedTextMock, backingRows } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  embedTextMock: vi.fn(),
  backingRows: [] as Row[],
}));

vi.mock("@lancedb/lancedb", () => ({
  connect: connectMock,
}));

vi.mock("../src/video-chapters-embeddings.js", () => ({
  embedText: embedTextMock,
}));

import {
  resetVideoChaptersIndexForTest,
  searchAllIndexedSegments,
  searchVideoChapterSegments,
} from "../src/video-chapters-index.js";

const EMBEDDINGS_CONFIG = {
  baseUrl: "http://127.0.0.1:8899/v1",
  apiKey: "test",
  model: "bge-m3",
  dimensions: 4,
};

describe("searchVideoChapterSegments", () => {
  beforeEach(() => {
    resetVideoChaptersIndexForTest();
    backingRows.length = 0;
    connectMock.mockReset();
    connectMock.mockResolvedValue({
      tableNames: vi.fn(async () => []),
      createTable: vi.fn(async (_name: string, _seed: Row[]) => createFakeTable(backingRows)),
      openTable: vi.fn(async (_name: string) => createFakeTable(backingRows)),
    });
    embedTextMock.mockReset();
    embedTextMock.mockImplementation(async (text: string) => [text.length, 0, 0, 0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("indexes segments on first search and returns matches", async () => {
    const matches = await searchVideoChapterSegments({
      videoPath: "C:\\videos\\ouwen.mp4",
      segments: [
        { start: 0, end: 6, title: "Basketball Action", desc: "A player dribbles." },
        { start: 7, end: 8, title: "Basketball Match", desc: "A game is being played." },
      ],
      query: "dunk",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ start: 0, end: 6, title: "Basketball Action" });
    expect(matches[0].score).toBeGreaterThan(0);
    // one embed call per segment (2) plus one for the query itself.
    expect(embedTextMock).toHaveBeenCalledTimes(3);
  });

  it("does not re-embed segments on a second search when they haven't changed", async () => {
    const segments = [{ start: 0, end: 6, title: "Basketball Action", desc: "A player dribbles." }];
    await searchVideoChapterSegments({
      videoPath: "C:\\videos\\ouwen.mp4",
      segments,
      query: "dribble",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });
    embedTextMock.mockClear();

    await searchVideoChapterSegments({
      videoPath: "C:\\videos\\ouwen.mp4",
      segments,
      query: "dunk",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    // Only the query gets embedded; the unchanged segment is not re-embedded.
    expect(embedTextMock).toHaveBeenCalledTimes(1);
    expect(embedTextMock).toHaveBeenCalledWith("dunk", EMBEDDINGS_CONFIG);
  });

  it("re-indexes when the segments changed since the last index", async () => {
    await searchVideoChapterSegments({
      videoPath: "C:\\videos\\ouwen.mp4",
      segments: [{ start: 0, end: 6, title: "A", desc: "old" }],
      query: "dribble",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });
    embedTextMock.mockClear();

    const matches = await searchVideoChapterSegments({
      videoPath: "C:\\videos\\ouwen.mp4",
      segments: [{ start: 0, end: 6, title: "B", desc: "new" }],
      query: "dunk",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    // one embed for the changed segment, one for the query.
    expect(embedTextMock).toHaveBeenCalledTimes(2);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ title: "B", desc: "new" });
  });

  it("scopes results to the requested video only", async () => {
    await searchVideoChapterSegments({
      videoPath: "C:\\videos\\a.mp4",
      segments: [{ start: 0, end: 1, title: "A-only", desc: "a" }],
      query: "x",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });
    const matches = await searchVideoChapterSegments({
      videoPath: "C:\\videos\\b.mp4",
      segments: [{ start: 0, end: 1, title: "B-only", desc: "b" }],
      query: "x",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ title: "B-only" });
  });
});

describe("searchAllIndexedSegments", () => {
  beforeEach(() => {
    resetVideoChaptersIndexForTest();
    backingRows.length = 0;
    connectMock.mockReset();
    connectMock.mockResolvedValue({
      tableNames: vi.fn(async () => []),
      createTable: vi.fn(async (_name: string, _seed: Row[]) => createFakeTable(backingRows)),
      openTable: vi.fn(async (_name: string) => createFakeTable(backingRows)),
    });
    embedTextMock.mockReset();
    embedTextMock.mockImplementation(async (text: string) => [text.length, 0, 0, 0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns matches across every indexed video, tagged with which video matched", async () => {
    await searchVideoChapterSegments({
      videoPath: "C:\\videos\\a.mp4",
      segments: [{ start: 0, end: 1, title: "A-only", desc: "a" }],
      query: "x",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });
    await searchVideoChapterSegments({
      videoPath: "C:\\videos\\b.mp4",
      segments: [{ start: 0, end: 1, title: "B-only", desc: "b" }],
      query: "x",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    const matches = await searchAllIndexedSegments({
      query: "dunk",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.video).toSorted()).toEqual(
      ["C:\\videos\\a.mp4", "C:\\videos\\b.mp4"].toSorted(),
    );
    expect(matches.find((m) => m.video === "C:\\videos\\a.mp4")).toMatchObject({
      title: "A-only",
    });
  });

  it("does not index anything — it only searches what's already there", async () => {
    const matches = await searchAllIndexedSegments({
      query: "dunk",
      topK: 5,
      embeddings: EMBEDDINGS_CONFIG,
    });

    expect(matches).toEqual([]);
    // the only embedText call is for the query itself; no segment ever gets indexed.
    expect(embedTextMock).toHaveBeenCalledTimes(1);
    expect(embedTextMock).toHaveBeenCalledWith("dunk", EMBEDDINGS_CONFIG);
  });
});
