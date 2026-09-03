// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for the fixed-pipeline store.
 *
 * The store holds user-authored data, so the properties that matter most are the ones
 * that protect it: an optimistic lock so one editor cannot silently overwrite another,
 * a serialized write path so concurrent writes cannot corrupt the file, and a corrupt
 * file being set aside rather than overwritten or crashing the plugin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deletePipeline,
  getPipeline,
  initPipelineStore,
  listPipelines,
  MAX_INSTRUCTION_CHARS,
  MAX_NAME_CHARS,
  MAX_STEPS,
  resetPipelineStoreForTest,
  runSerializedWrite,
  upsertPipeline,
} from "../src/pipeline-store.js";

const KNOWN = new Set(["research", "writing", "coding"]);
let dir: string;

function storeFile(): string {
  return path.join(dir, "pipelines.json");
}

function save(params: {
  baseRevision: number;
  id?: string;
  name?: string;
  steps?: Array<{ agentId: string; instruction: string }>;
}) {
  return upsertPipeline({
    baseRevision: params.baseRevision,
    ...(params.id ? { id: params.id } : {}),
    name: params.name ?? "文档生成",
    steps: params.steps ?? [{ agentId: "research", instruction: "查资料" }],
    knownAgentIds: KNOWN,
  });
}

beforeEach(() => {
  resetPipelineStoreForTest();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dto-pipelines-"));
  initPipelineStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("empty store", () => {
  test("starts at revision 0 with no pipelines", () => {
    expect(listPipelines()).toEqual({ revision: 0, pipelines: [] });
  });

  test("a missing file is a fresh install, not an error", () => {
    expect(fs.existsSync(storeFile())).toBe(false);
    expect(() => initPipelineStore(dir)).not.toThrow();
  });
});

describe("create and read", () => {
  test("creating assigns an id and bumps the revision", () => {
    const result = save({ baseRevision: 0 });
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.pipelines).toHaveLength(1);
    expect(result.pipelines[0]!.id).toMatch(/^pl_/);
  });

  test("the created pipeline is readable by id", () => {
    const created = save({ baseRevision: 0 });
    const id = created.pipelines[0]!.id;
    expect(getPipeline(id)).toMatchObject({ name: "文档生成" });
  });

  test("it survives a reload from disk", () => {
    save({ baseRevision: 0, name: "代码评审" });
    resetPipelineStoreForTest();
    initPipelineStore(dir);
    const { revision, pipelines } = listPipelines();
    expect(revision).toBe(1);
    expect(pipelines[0]).toMatchObject({ name: "代码评审" });
  });

  test("returned objects are copies, so callers cannot mutate the store", () => {
    save({ baseRevision: 0 });
    const snapshot = listPipelines();
    snapshot.pipelines[0]!.name = "tampered";
    snapshot.pipelines[0]!.steps[0]!.agentId = "tampered";
    expect(listPipelines().pipelines[0]!.name).toBe("文档生成");
    expect(listPipelines().pipelines[0]!.steps[0]!.agentId).toBe("research");
  });
});

describe("update and delete", () => {
  test("updating by id replaces steps wholesale and keeps createdAt", () => {
    const created = save({ baseRevision: 0 });
    const id = created.pipelines[0]!.id;
    const createdAt = created.pipelines[0]!.createdAt;

    const updated = save({
      baseRevision: 1,
      id,
      name: "改名了",
      steps: [
        { agentId: "research", instruction: "查" },
        { agentId: "writing", instruction: "写" },
      ],
    });
    expect(updated.ok).toBe(true);
    expect(updated.pipelines[0]).toMatchObject({ id, name: "改名了", createdAt });
    expect(updated.pipelines[0]!.steps).toHaveLength(2);
  });

  test("updating an unknown id reports not_found rather than creating one", () => {
    const result = save({ baseRevision: 0, id: "pl_nope" });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(listPipelines().pipelines).toHaveLength(0);
  });

  test("delete removes it and bumps the revision", () => {
    const id = save({ baseRevision: 0 }).pipelines[0]!.id;
    const result = deletePipeline({ baseRevision: 1, id });
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(2);
    expect(result.pipelines).toHaveLength(0);
  });

  test("deleting an unknown id reports not_found and does not bump the revision", () => {
    save({ baseRevision: 0 });
    const result = deletePipeline({ baseRevision: 1, id: "pl_nope" });
    expect(result).toMatchObject({ ok: false, code: "not_found", revision: 1 });
  });
});

describe("optimistic lock", () => {
  // Without this, two open editors would silently overwrite each other's work.
  test("a stale baseRevision is rejected and the caller gets current state back", () => {
    save({ baseRevision: 0 });
    const stale = save({ baseRevision: 0, name: "第二次" });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    // The rejection carries the authoritative state so the UI can refresh without a
    // second round-trip.
    expect(stale.revision).toBe(1);
    expect(stale.pipelines[0]!.name).toBe("文档生成");
  });

  test("delete is guarded too", () => {
    const id = save({ baseRevision: 0 }).pipelines[0]!.id;
    expect(deletePipeline({ baseRevision: 0, id })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });
});

describe("validation", () => {
  test("rejects an empty name and one over the cap", () => {
    expect(save({ baseRevision: 0, name: "  " })).toMatchObject({ ok: false, code: "invalid" });
    expect(save({ baseRevision: 0, name: "长".repeat(MAX_NAME_CHARS + 1) })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  test("rejects zero steps and more than the cap", () => {
    expect(save({ baseRevision: 0, steps: [] })).toMatchObject({ ok: false, code: "invalid" });
    const tooMany = Array.from({ length: MAX_STEPS + 1 }, () => ({
      agentId: "research",
      instruction: "x",
    }));
    expect(save({ baseRevision: 0, steps: tooMany })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  test("rejects an agent that does not exist", () => {
    const result = save({ baseRevision: 0, steps: [{ agentId: "ghost", instruction: "x" }] });
    expect(result).toMatchObject({
      ok: false,
      code: "invalid",
      message: expect.stringContaining("ghost"),
    });
  });

  // Internal identities carry `tools.deny: ["*"]`, so a step routed to one could never
  // do real work — accepting it would produce a pipeline that silently does nothing.
  test("rejects internal agent ids", () => {
    const result = save({
      baseRevision: 0,
      steps: [{ agentId: "dt-decomposer", instruction: "x" }],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "invalid",
      message: expect.stringContaining("dt-decomposer"),
    });
  });

  test("rejects an over-long instruction", () => {
    const result = save({
      baseRevision: 0,
      steps: [{ agentId: "research", instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1) }],
    });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
  });

  test("a rejected write leaves the store untouched", () => {
    save({ baseRevision: 0 });
    save({ baseRevision: 1, steps: [{ agentId: "ghost", instruction: "x" }] });
    expect(listPipelines().revision).toBe(1);
    expect(listPipelines().pipelines).toHaveLength(1);
  });

  test("trims name and instruction on save", () => {
    const result = save({
      baseRevision: 0,
      name: "  两边有空格  ",
      steps: [{ agentId: "  research  ", instruction: "  查资料  " }],
    });
    expect(result.pipelines[0]!.name).toBe("两边有空格");
    expect(result.pipelines[0]!.steps[0]).toEqual({ agentId: "research", instruction: "查资料" });
  });
});

describe("corrupt file handling", () => {
  // A broken file must not throw: that would fail plugin registration and take the
  // dynamic-decomposition half of the plugin down with it.
  test("unparsable JSON starts empty instead of throwing", () => {
    fs.writeFileSync(storeFile(), "{ this is not json", "utf8");
    resetPipelineStoreForTest();
    expect(() => initPipelineStore(dir)).not.toThrow();
    expect(listPipelines()).toEqual({ revision: 0, pipelines: [] });
  });

  test("the bad file is moved aside, never silently overwritten", () => {
    fs.writeFileSync(storeFile(), "{ broken", "utf8");
    resetPipelineStoreForTest();
    initPipelineStore(dir);
    const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]!), "utf8")).toBe("{ broken");
  });

  test("valid JSON of the wrong shape is treated the same way", () => {
    fs.writeFileSync(storeFile(), '{"nope": true}', "utf8");
    resetPipelineStoreForTest();
    initPipelineStore(dir);
    expect(listPipelines().pipelines).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  // One hand-broken entry must not take out the others.
  test("individually unusable pipelines are dropped, the rest survive", () => {
    fs.writeFileSync(
      storeFile(),
      JSON.stringify({
        version: 1,
        revision: 4,
        pipelines: [
          { id: "pl_ok", name: "good", steps: [{ agentId: "research", instruction: "x" }] },
          { id: "", name: "no id", steps: [{ agentId: "research", instruction: "x" }] },
          { id: "pl_nosteps", name: "empty", steps: [] },
          { id: "pl_badstep", name: "bad step", steps: [{ agentId: 42 }] },
        ],
      }),
      "utf8",
    );
    resetPipelineStoreForTest();
    initPipelineStore(dir);
    const { revision, pipelines } = listPipelines();
    expect(revision).toBe(4);
    expect(pipelines.map((p) => p.id)).toEqual(["pl_ok"]);
  });
});

describe("persistence", () => {
  test("writes are atomic — no leftover temp files", () => {
    save({ baseRevision: 0 });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(fs.existsSync(storeFile())).toBe(true);
  });

  test("an uninitialized store still works in memory", () => {
    // Tests and any path where the service never started must not crash on write.
    resetPipelineStoreForTest();
    const result = upsertPipeline({
      baseRevision: 0,
      name: "内存中",
      steps: [{ agentId: "research", instruction: "x" }],
      knownAgentIds: KNOWN,
    });
    expect(result.ok).toBe(true);
    expect(listPipelines().pipelines).toHaveLength(1);
  });
});

describe("runSerializedWrite", () => {
  // The revision check alone is not enough: two callers can both read the same revision
  // and both pass it before either writes. Serialization is what makes the second one
  // see the first one's revision.
  test("concurrent writes do not both succeed against the same base revision", async () => {
    const [a, b] = await Promise.all([
      runSerializedWrite(() => save({ baseRevision: 0, name: "A" })),
      runSerializedWrite(() => save({ baseRevision: 0, name: "B" })),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(listPipelines().revision).toBe(1);
    expect(listPipelines().pipelines).toHaveLength(1);
  });

  test("sequential writes through the chain all apply", async () => {
    await runSerializedWrite(() => save({ baseRevision: 0, name: "一" }));
    await runSerializedWrite(() => save({ baseRevision: 1, name: "二" }));
    expect(listPipelines().revision).toBe(2);
    expect(listPipelines().pipelines).toHaveLength(2);
  });

  test("a throwing mutation does not wedge the chain", async () => {
    await expect(
      runSerializedWrite(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The next write must still go through.
    const result = await runSerializedWrite(() => save({ baseRevision: 0 }));
    expect(result.ok).toBe(true);
  });
});
