// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tests for the shared artifact directory (the second hand-off channel).
 *
 * The behaviours worth pinning are the ones that made the 2026-08-31 run fail silently:
 * paths must be absolute, the listing must come from the disk rather than the worker's
 * word, and a claimed-but-absent file must be reported instead of believed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  artifactChannelReady,
  artifactDirFor,
  describeArtifactDirForWorker,
  describeArtifactsForConsumer,
  detectUnresolvedFileClaims,
  ensureArtifactDir,
  initArtifactRoot,
  listArtifacts,
  resetArtifactRoot,
} from "../src/artifacts.js";

const ROOT_SESSION = "agent:main:dashboard:abc123";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-artifacts-test-"));
  initArtifactRoot(stateDir);
});

afterEach(() => {
  resetArtifactRoot();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("initialization and degradation", () => {
  test("reports ready once initialized", () => {
    expect(artifactChannelReady()).toBe(true);
  });

  /**
   * The service that supplies `stateDir` may never have started. Every entry point has to
   * degrade to "no file route" rather than throwing, because the alternative is failing a
   * subtask over a missing convenience.
   */
  test("degrades to no channel when uninitialized", () => {
    resetArtifactRoot();
    expect(artifactChannelReady()).toBe(false);
    expect(artifactDirFor(ROOT_SESSION, 0)).toBeNull();
    expect(ensureArtifactDir(ROOT_SESSION, 0)).toBeNull();
    expect(listArtifacts(null)).toEqual([]);
  });
});

describe("artifactDirFor", () => {
  // The whole reason this module exists: a relative path resolves against each agent's own
  // workspace, so only an absolute one can be handed across agents.
  test("returns an absolute path", () => {
    const dir = artifactDirFor(ROOT_SESSION, 0)!;
    expect(path.isAbsolute(dir)).toBe(true);
  });

  // Siblings in a layer run concurrently. Sharing one directory would make them race over
  // filenames; one writer per directory removes that outright.
  test("gives each subtask its own directory", () => {
    expect(artifactDirFor(ROOT_SESSION, 0)).not.toBe(artifactDirFor(ROOT_SESSION, 1));
  });

  test("separates concurrent requests", () => {
    const other = artifactDirFor("agent:main:dashboard:different", 0);
    expect(artifactDirFor(ROOT_SESSION, 0)).not.toBe(other);
  });

  test("is stable for the same inputs", () => {
    expect(artifactDirFor(ROOT_SESSION, 2)).toBe(artifactDirFor(ROOT_SESSION, 2));
  });
});

describe("ensureArtifactDir", () => {
  test("creates the directory and returns it", () => {
    const dir = ensureArtifactDir(ROOT_SESSION, 0)!;
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  test("is idempotent", () => {
    const first = ensureArtifactDir(ROOT_SESSION, 0);
    expect(ensureArtifactDir(ROOT_SESSION, 0)).toBe(first);
  });
});

describe("listArtifacts", () => {
  test("reports nothing for a directory the worker never wrote to", () => {
    const dir = ensureArtifactDir(ROOT_SESSION, 0)!;
    expect(listArtifacts(dir)).toEqual([]);
  });

  test("reports files with absolute uris and real sizes", () => {
    const dir = ensureArtifactDir(ROOT_SESSION, 0)!;
    fs.writeFileSync(path.join(dir, "report.md"), "hello");

    const found = listArtifacts(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("report.md");
    expect(found[0]!.uri).toBe(path.join(dir, "report.md"));
    expect(found[0]!.bytes).toBe(5);
    expect(path.isAbsolute(found[0]!.uri)).toBe(true);
  });

  // readdir order is not guaranteed, and an unstable listing would make the hand-off
  // notice differ run to run for no reason.
  test("sorts by name", () => {
    const dir = ensureArtifactDir(ROOT_SESSION, 0)!;
    for (const name of ["c.md", "a.md", "b.md"]) fs.writeFileSync(path.join(dir, name), "x");
    expect(listArtifacts(dir).map((a) => a.name)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("descends into a subdirectory the worker created", () => {
    const dir = ensureArtifactDir(ROOT_SESSION, 0)!;
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "data", "rows.csv"), "a,b");

    const found = listArtifacts(dir);
    expect(found).toHaveLength(1);
    // Relative for display, absolute for use.
    expect(found[0]!.name).toBe(path.join("data", "rows.csv"));
    expect(path.isAbsolute(found[0]!.uri)).toBe(true);
  });

  test("caps a runaway worker's output", () => {
    const dir = ensureArtifactDir(ROOT_SESSION, 0)!;
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}.md`), "x");
    }
    expect(listArtifacts(dir)).toHaveLength(20);
  });
});

describe("detectUnresolvedFileClaims", () => {
  /**
   * The exact 2026-08-31 failure: `research` wrote nothing reachable, its reply named
   * `hexicorridor_tourism.md`, and the subtask reported ok. This is the assertion that the
   * claim is now noticed.
   */
  test("flags a file the reply names but never wrote", () => {
    const claims = detectUnresolvedFileClaims("详见 hexicorridor_tourism.md 的表格版。", []);
    expect(claims).toEqual(["hexicorridor_tourism.md"]);
  });

  test("accepts a claim backed by a real file", () => {
    const artifacts = [{ uri: "C:\\a\\b\\report.md", name: "report.md", bytes: 10 }];
    expect(detectUnresolvedFileClaims("完整内容见 report.md。", artifacts)).toEqual([]);
  });

  /**
   * The consumer is handed an absolute path regardless, so a wrong prefix on the producer's
   * side costs nothing and must not be reported. Matching on basename is what makes the
   * check tolerant of exactly the mistake the model kept making.
   */
  test("matches on basename, ignoring a wrong directory prefix", () => {
    const artifacts = [{ uri: "C:\\a\\b\\report.md", name: "report.md", bytes: 10 }];
    expect(detectUnresolvedFileClaims("见 writing/report.md", artifacts)).toEqual([]);
    expect(detectUnresolvedFileClaims("见 writing\\report.md", artifacts)).toEqual([]);
  });

  // A broad pattern would report a problem on every subtask that says the word "markdown",
  // and a check that cries wolf gets ignored.
  test("does not flag prose that merely mentions a format", () => {
    expect(detectUnresolvedFileClaims("我把结果整理成了 markdown 表格。", [])).toEqual([]);
    expect(detectUnresolvedFileClaims("没有产出任何文件。", [])).toEqual([]);
  });

  /**
   * Research subtasks cite sources constantly, and plenty of URLs end in `.html`. Reading
   * those as claimed local files would fire this check on ordinary output — which is how a
   * warning stops being read.
   */
  test("does not flag cited URLs", () => {
    const text =
      "来源：https://gansu.gscn.com.cn/system/2025/03/28/013302500.shtml 和 http://lz.bendibao.com/tour/62305.html";
    expect(detectUnresolvedFileClaims(text, [])).toEqual([]);
  });

  test("still flags a real claim sitting next to a URL", () => {
    const text = "参考 https://example.com/a.html ，完整表格见 report.md。";
    expect(detectUnresolvedFileClaims(text, [])).toEqual(["report.md"]);
  });

  test("reports each missing name once", () => {
    const claims = detectUnresolvedFileClaims("见 a.md 和 a.md，以及 b.csv。", []);
    expect(claims).toHaveLength(2);
    expect(new Set(claims)).toEqual(new Set(["a.md", "b.csv"]));
  });

  test("handles a Chinese filename", () => {
    const artifacts = [{ uri: "C:\\a\\攻略.md", name: "攻略.md", bytes: 10 }];
    expect(detectUnresolvedFileClaims("见 攻略.md", artifacts)).toEqual([]);
    expect(detectUnresolvedFileClaims("见 另一份.md", artifacts)).toEqual(["另一份.md"]);
  });
});

describe("prompt rendering", () => {
  test("says nothing when there is nothing to hand over", () => {
    expect(describeArtifactsForConsumer(0, [])).toBe("");
  });

  /**
   * Both halves matter. The path has to be absolute, and the consumer has to be told not
   * to prefix it — the 2026-08-31 read failed because the model helpfully added a
   * `writing/` prefix to a path that was already complete.
   */
  test("gives the consumer absolute paths and tells it not to prefix them", () => {
    const block = describeArtifactsForConsumer(1, [
      { uri: "C:\\state\\artifacts\\h\\subtask-1\\report.md", name: "report.md", bytes: 2707 },
    ]);
    expect(block).toContain("C:\\state\\artifacts\\h\\subtask-1\\report.md");
    expect(block).toContain("不要在前面拼接任何目录名");
    expect(block).toContain("3 KB");
  });

  test("tells the worker the directory to write into", () => {
    const notice = describeArtifactDirForWorker("C:\\state\\artifacts\\h\\subtask-0");
    expect(notice).toContain("C:\\state\\artifacts\\h\\subtask-0");
    expect(notice).toContain("共享产物目录");
    expect(notice).toContain("绝对路径");
  });
});
