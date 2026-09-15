// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type * as LanceDB from "@lancedb/lancedb";
import { connect } from "@lancedb/lancedb";
import type { VideoChaptersEmbeddingsConfig } from "./video-chapters-embeddings.js";
import { embedText } from "./video-chapters-embeddings.js";
import type { ChapterSegment } from "./video-chapters-exec.js";

export type SegmentMatch = ChapterSegment & { score: number };

/** Returned by a library-wide search, where the caller doesn't already know which video matched. */
export type LibrarySegmentMatch = SegmentMatch & { video: string };

type SegmentRow = {
  id: string;
  videoKey: string;
  /** Plain path, kept only for display in library-wide results — filtering always uses `videoKey`. */
  videoPath: string;
  contentHash: string;
  segmentIndex: number;
  start: number;
  end: number;
  title: string;
  desc: string;
  vector: number[];
};

const TABLE_NAME = "segments";
const DEFAULT_DB_PATH = path.join(homedir(), ".openclaw", "video-chapters", "lancedb");

/**
 * `videoKey`/`contentHash` are hex sha256 digests, never the raw video path or segment
 * text, specifically so they can go straight into a LanceDB `where` filter string without
 * escaping — a raw Windows path (backslashes, colons, drive letters, arbitrary user input)
 * would either break the filter syntax or open an injection path.
 */
function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class SegmentIndexDB {
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const db = await connect(this.dbPath);
    const tables = await db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await db.openTable(TABLE_NAME);
      return;
    }
    this.table = await db.createTable(TABLE_NAME, [
      {
        id: "__schema__",
        videoKey: "",
        videoPath: "",
        contentHash: "",
        segmentIndex: 0,
        start: 0,
        end: 0,
        title: "",
        desc: "",
        vector: Array.from({ length: this.vectorDim }).fill(0),
      },
    ]);
    await this.table.delete('id = "__schema__"');
  }

  /** Null when this video was never indexed. */
  async currentContentHash(videoKey: string): Promise<string | null> {
    await this.ensureInitialized();
    const rows = await this.table!.query().where(`videoKey = '${videoKey}'`).limit(1).toArray();
    return rows.length > 0 ? (rows[0].contentHash as string) : null;
  }

  async replaceVideoSegments(videoKey: string, rows: SegmentRow[]): Promise<void> {
    await this.ensureInitialized();
    await this.table!.delete(`videoKey = '${videoKey}'`);
    if (rows.length > 0) {
      await this.table!.add(rows);
    }
  }

  async search(videoKey: string, vector: number[], limit: number): Promise<SegmentMatch[]> {
    await this.ensureInitialized();
    const results = await this.table!
      .vectorSearch(vector)
      .where(`videoKey = '${videoKey}'`)
      .limit(limit)
      .toArray();
    return results.map(toSegmentMatch);
  }

  /** No `where` filter — searches every indexed video's segments in one pass. */
  async searchAll(vector: number[], limit: number): Promise<LibrarySegmentMatch[]> {
    await this.ensureInitialized();
    const results = await this.table!.vectorSearch(vector).limit(limit).toArray();
    return results.map((row) => ({
      ...toSegmentMatch(row),
      video: row.videoPath as string,
    }));
  }
}

function toSegmentMatch(row: Record<string, unknown>): SegmentMatch {
  const distance = (row._distance as number | undefined) ?? 0;
  return {
    start: row.start as number,
    end: row.end as number,
    title: row.title as string,
    desc: row.desc as string,
    score: 1 / (1 + distance),
  };
}

let db: SegmentIndexDB | null = null;

function getDb(vectorDim: number): SegmentIndexDB {
  if (!db) {
    db = new SegmentIndexDB(DEFAULT_DB_PATH, vectorDim);
  }
  return db;
}

/** Test-only: forget the cached db handle so the next call re-opens it. */
export function resetVideoChaptersIndexForTest(): void {
  db = null;
}

/**
 * (Re)index `segments` for `videoPath` if they changed since the last index.
 *
 * Re-embedding is skipped when `contentHash` (over the segments array) already matches
 * what's stored, so repeated calls for the same, unchanged video are cheap no-ops. Exported
 * standalone (not just via `searchVideoChapterSegments`) so the startup batch indexer can
 * index a freshly summarized video without needing a search query to do it.
 */
export async function ensureVideoIndexed(params: {
  videoPath: string;
  segments: ChapterSegment[];
  embeddings: VideoChaptersEmbeddingsConfig;
}): Promise<void> {
  const videoKey = hashString(params.videoPath);
  const contentHash = hashString(JSON.stringify(params.segments));
  const store = getDb(params.embeddings.dimensions);

  const existingHash = await store.currentContentHash(videoKey);
  if (existingHash === contentHash) {
    return;
  }
  const rows: SegmentRow[] = await Promise.all(
    params.segments.map(async (segment, segmentIndex) => ({
      id: randomUUID(),
      videoKey,
      videoPath: params.videoPath,
      contentHash,
      segmentIndex,
      start: segment.start,
      end: segment.end,
      title: segment.title,
      desc: segment.desc,
      vector: await embedText(`${segment.title}: ${segment.desc}`, params.embeddings),
    })),
  );
  await store.replaceVideoSegments(videoKey, rows);
}

/** Indexes `segments` for `videoPath` if needed, then runs `query` and returns the top matches. */
export async function searchVideoChapterSegments(params: {
  videoPath: string;
  segments: ChapterSegment[];
  query: string;
  topK: number;
  embeddings: VideoChaptersEmbeddingsConfig;
}): Promise<SegmentMatch[]> {
  await ensureVideoIndexed(params);
  const videoKey = hashString(params.videoPath);
  const queryVector = await embedText(params.query, params.embeddings);
  return getDb(params.embeddings.dimensions).search(videoKey, queryVector, params.topK);
}

/**
 * Searches every video already indexed in the shared LanceDB table — no `videoPath`
 * needed. Only ever reflects what's already there (via the startup batch indexer, or a
 * prior single-video search/index call); unlike `searchVideoChapterSegments`, there is no
 * video to run `ensureVideoIndexed` against, so nothing gets summarized or embedded here.
 */
export async function searchAllIndexedSegments(params: {
  query: string;
  topK: number;
  embeddings: VideoChaptersEmbeddingsConfig;
}): Promise<LibrarySegmentMatch[]> {
  const queryVector = await embedText(params.query, params.embeddings);
  return getDb(params.embeddings.dimensions).searchAll(queryVector, params.topK);
}
