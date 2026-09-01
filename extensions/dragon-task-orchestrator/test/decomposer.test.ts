/**
 * Tests for plan validation and cleaning (tasks 3.6/3.7/3.8).
 *
 * Includes the dangling-dependency regression the review doc flagged as the
 * highest-severity defect, and the shape-drift cases that must degrade rather
 * than throw.
 */

import { describe, expect, test } from "vitest";
import { sanitizeDependencies, validateDecomposePlan } from "../src/decomposer.js";
import type { SubtaskPlan } from "../src/types.js";

const LIMITS = { maxSubtasks: 4, maxDescriptionChars: 2000, maxDepsPerSubtask: 3 };

function sub(id: number, description: string, deps?: number[]): SubtaskPlan {
  return { id, title: "", description, ...(deps !== undefined && { needsPriorResults: deps }) };
}

/** Every surviving dependency must point at a subtask that actually exists. */
function expectNoDanglingDeps(subtasks: SubtaskPlan[]): void {
  const existing = new Set(subtasks.map((s) => s.id));
  for (const s of subtasks) {
    for (const dep of s.needsPriorResults ?? []) {
      expect(existing.has(dep)).toBe(true);
      expect(dep).toBeLessThan(s.id);
    }
  }
}

describe("validateDecomposePlan — spec scenarios", () => {
  test("unparseable / malformed plan yields zero subtasks instead of throwing", () => {
    // The caller's 0-survivor branch then falls back to a single-hop delegation.
    expect(validateDecomposePlan(null, LIMITS).subtasks).toHaveLength(0);
    expect(validateDecomposePlan({}, LIMITS).subtasks).toHaveLength(0);
    expect(validateDecomposePlan({ subtasks: "nope" }, LIMITS).subtasks).toHaveLength(0);
  });

  test("empty description is dropped, indexes compact, deps rewritten", () => {
    const result = validateDecomposePlan(
      { subtasks: [sub(0, "keep me"), sub(1, "   "), sub(2, "also keep", [0])] },
      LIMITS,
    );
    expect(result.subtasks.map((s) => s.description)).toEqual(["keep me", "also keep"]);
    expect(result.subtasks.map((s) => s.id)).toEqual([0, 1]);
    expect(result.droppedEmptyDescriptions).toHaveLength(1);
    expectNoDanglingDeps(result.subtasks);
  });

  test("dependency on a nonexistent index is dropped, never sentinel-substituted", () => {
    const result = validateDecomposePlan(
      { subtasks: [sub(0, "first"), sub(1, "second", [99])] },
      LIMITS,
    );
    expect(result.subtasks[1]?.needsPriorResults).toEqual([]);
    // -1 would satisfy `dep < index` and survive, yet never be satisfiable.
    expect(result.subtasks[1]?.needsPriorResults).not.toContain(-1);
  });

  test("subtask count over the cap keeps the first N and reports the rest", () => {
    const result = validateDecomposePlan(
      { subtasks: [0, 1, 2, 3, 4, 5].map((i) => sub(i, `task ${i}`)) },
      LIMITS,
    );
    expect(result.subtasks).toHaveLength(4);
    expect(result.droppedSubtasks.map((s) => s.description)).toEqual(["task 4", "task 5"]);
  });

  test("over-long description is truncated but the subtask still runs", () => {
    const long = "x".repeat(3000);
    const result = validateDecomposePlan({ subtasks: [sub(0, long), sub(1, "b")] }, LIMITS);
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[0]!.description.length).toBeLessThanOrEqual(LIMITS.maxDescriptionChars);
    expect(result.truncatedDescriptions).toHaveLength(1);
  });

  test("an over-long title is truncated to MAX_TITLE_CHARS (60)", () => {
    const longTitle = "t".repeat(200);
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, title: longTitle, description: "a" }] },
      LIMITS,
    );
    expect(result.subtasks[0]!.title.length).toBeLessThanOrEqual(60);
  });

  test("an over-long acceptanceCriteria is truncated using maxDescriptionChars, like description", () => {
    const longCriteria = "c".repeat(3000);
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, description: "a", acceptanceCriteria: longCriteria }] },
      LIMITS,
    );
    expect(result.subtasks[0]!.acceptanceCriteria!.length).toBeLessThanOrEqual(
      LIMITS.maxDescriptionChars,
    );
  });

  test("dependencies over the per-subtask cap are truncated and reported", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          sub(0, "a"),
          sub(1, "b"),
          sub(2, "c"),
          sub(3, "d"),
          sub(4, "e", [0, 1, 2, 3]),
        ],
      },
      { ...LIMITS, maxSubtasks: 5 },
    );
    expect(result.subtasks[4]!.needsPriorResults).toHaveLength(3);
    expect(result.truncatedDeps).toHaveLength(1);
  });
});

describe("dangling dependency regression (task 3.7)", () => {
  test("dropping a dependency target cleans references to its old index", () => {
    // Subtask 2 depends on 1. Subtask 1 is dropped (empty description). After
    // compaction the old index 1 is reused by a DIFFERENT subtask, so a stale
    // numeric reference would silently point at the wrong task while still
    // satisfying `dep < index`.
    const result = validateDecomposePlan(
      {
        subtasks: [
          sub(0, "alpha"),
          sub(1, ""), // dropped — was the dependency target
          sub(2, "gamma", [1]), // referenced the dropped task
        ],
      },
      LIMITS,
    );
    expect(result.subtasks.map((s) => s.description)).toEqual(["alpha", "gamma"]);
    expect(result.subtasks[1]!.needsPriorResults).toEqual([]);
    expectNoDanglingDeps(result.subtasks);
  });

  test("surviving dependencies are remapped, not merely filtered", () => {
    // Subtask 2 depends on 0. After 1 is dropped, 2 becomes index 1 and its
    // dependency must still resolve to alpha's new index (0).
    const result = validateDecomposePlan(
      { subtasks: [sub(0, "alpha"), sub(1, ""), sub(2, "gamma", [0])] },
      LIMITS,
    );
    expect(result.subtasks[1]!.needsPriorResults).toEqual([0]);
    expectNoDanglingDeps(result.subtasks);
  });

  test("no subtask is left permanently unsatisfiable after multiple drops", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          sub(0, ""),
          sub(1, "b", [0]),
          sub(2, ""),
          sub(3, "d", [1, 2]),
          sub(4, "e", [0, 2, 3]),
        ],
      },
      LIMITS,
    );
    expectNoDanglingDeps(result.subtasks);
    expect(result.subtasks.map((s) => s.description)).toEqual(["b", "d", "e"]);
  });

  test("duplicate model indexes resolve to the first occurrence", () => {
    const result = validateDecomposePlan(
      { subtasks: [sub(5, "first"), sub(5, "second"), sub(9, "third", [5])] },
      LIMITS,
    );
    expect(result.subtasks.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(result.subtasks[2]!.needsPriorResults).toEqual([0]);
    expectNoDanglingDeps(result.subtasks);
  });

  test("self and forward references are removed", () => {
    const result = validateDecomposePlan(
      { subtasks: [sub(0, "a", [0]), sub(1, "b", [1, 0])] },
      LIMITS,
    );
    expect(result.subtasks[0]!.needsPriorResults).toEqual([]);
    expect(result.subtasks[1]!.needsPriorResults).toEqual([0]);
    expectNoDanglingDeps(result.subtasks);
  });

  test("capping the count does not create new dangling references", () => {
    const result = validateDecomposePlan(
      { subtasks: [0, 1, 2, 3, 4, 5].map((i) => sub(i, `t${i}`, i > 0 ? [i - 1] : [])) },
      LIMITS,
    );
    expect(result.subtasks).toHaveLength(4);
    expectNoDanglingDeps(result.subtasks);
  });
});

describe("shape drift (task 3.8)", () => {
  test("subtasks null degrades to empty", () => {
    expect(() => validateDecomposePlan({ subtasks: null }, LIMITS)).not.toThrow();
    expect(validateDecomposePlan({ subtasks: null }, LIMITS).subtasks).toHaveLength(0);
  });

  test("numeric description entries are discarded without throwing", () => {
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, description: 42 }, sub(1, "valid")] },
      LIMITS,
    );
    expect(result.subtasks.map((s) => s.description)).toEqual(["valid"]);
    // A malformed entry counts in no statistic — it never qualified as valid.
    expect(result.droppedEmptyDescriptions).toHaveLength(0);
    expect(result.droppedSubtasks).toHaveLength(0);
  });

  test("string-typed needsPriorResults is discarded", () => {
    const result = validateDecomposePlan(
      { subtasks: [sub(0, "a"), { id: 1, description: "b", needsPriorResults: "0" }] },
      LIMITS,
    );
    expect(result.subtasks.map((s) => s.description)).toEqual(["a"]);
  });

  test("string-typed members inside needsPriorResults are filtered", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          sub(0, "a"),
          { id: 1, description: "b", needsPriorResults: ["0", 0, null, 0.5] },
        ],
      },
      LIMITS,
    );
    expect(result.subtasks[1]!.needsPriorResults).toEqual([0]);
  });

  test("non-integer and non-object entries are discarded", () => {
    const result = validateDecomposePlan(
      { subtasks: [null, 7, "x", [], { id: 1.5, description: "frac" }, sub(0, "ok")] },
      LIMITS,
    );
    expect(result.subtasks.map((s) => s.description)).toEqual(["ok"]);
  });

  test("missing needsPriorResults is treated as no dependencies", () => {
    const result = validateDecomposePlan({ subtasks: [{ id: 0, description: "a" }] }, LIMITS);
    expect(result.subtasks[0]!.needsPriorResults).toEqual([]);
  });

  test("missing title defaults to an empty string", () => {
    const result = validateDecomposePlan({ subtasks: [{ id: 0, description: "a" }] }, LIMITS);
    expect(result.subtasks[0]!.title).toBe("");
  });

  test("a non-string title is discarded in favor of the empty-string default", () => {
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, title: 42, description: "a" }] },
      LIMITS,
    );
    expect(result.subtasks[0]!.title).toBe("");
  });

  test("missing acceptanceCriteria defaults to an empty string", () => {
    const result = validateDecomposePlan({ subtasks: [{ id: 0, description: "a" }] }, LIMITS);
    expect(result.subtasks[0]!.acceptanceCriteria).toBe("");
  });

  test("a non-string acceptanceCriteria is discarded in favor of the empty-string default", () => {
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, description: "a", acceptanceCriteria: 42 }] },
      LIMITS,
    );
    expect(result.subtasks[0]!.acceptanceCriteria).toBe("");
  });

  test("string title and acceptanceCriteria pass through unchanged when within limits", () => {
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, title: "标题", description: "a", acceptanceCriteria: "必须通过测试" }] },
      LIMITS,
    );
    expect(result.subtasks[0]!.title).toBe("标题");
    expect(result.subtasks[0]!.acceptanceCriteria).toBe("必须通过测试");
  });
});

/**
 * `handoffContract` normalization (方案 D).
 *
 * The field is model-supplied, so it gets the same treatment as every other model-supplied
 * field: cleaned or dropped, never trusted, never thrown on. It is repeated into two
 * prompts (worker and verifier), so an unbounded list would be paid for twice.
 */
describe("handoffContract normalization", () => {
  test("keeps a well-formed contract", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          { id: 0, title: "t", description: "a", handoffContract: ["每段公里数", "来源 URL"] },
        ],
      },
      LIMITS,
    );
    expect(result.subtasks[0]!.handoffContract).toEqual(["每段公里数", "来源 URL"]);
  });

  // Absent and `[]` mean the same thing to every consumer; keeping one representation
  // means each of them needs one check instead of two.
  test("omits the field entirely rather than leaving an empty array", () => {
    for (const handoffContract of [[], ["", "   "], "not an array", 42, null]) {
      const result = validateDecomposePlan(
        { subtasks: [{ id: 0, title: "t", description: "a", handoffContract }] },
        LIMITS,
      );
      expect(result.subtasks[0]!.handoffContract, JSON.stringify(handoffContract)).toBeUndefined();
    }
  });

  test("drops non-string members but keeps the usable ones", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          { id: 0, title: "t", description: "a", handoffContract: ["保留", 7, null, { a: 1 }, "也保留"] },
        ],
      },
      LIMITS,
    );
    expect(result.subtasks[0]!.handoffContract).toEqual(["保留", "也保留"]);
  });

  test("trims surrounding whitespace", () => {
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, title: "t", description: "a", handoffContract: ["  每段公里数  "] }] },
      LIMITS,
    );
    expect(result.subtasks[0]!.handoffContract).toEqual(["每段公里数"]);
  });

  // Past ~8 items a model stops treating each entry as individually required, so the cap
  // is about the checklist staying a checklist, not only about size.
  test("caps the item count at 8", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          {
            id: 0,
            title: "t",
            description: "a",
            handoffContract: Array.from({ length: 20 }, (_, i) => `item-${i}`),
          },
        ],
      },
      LIMITS,
    );
    expect(result.subtasks[0]!.handoffContract).toHaveLength(8);
    expect(result.subtasks[0]!.handoffContract![0]).toBe("item-0");
  });

  test("truncates an over-long item", () => {
    const result = validateDecomposePlan(
      { subtasks: [{ id: 0, title: "t", description: "a", handoffContract: ["x".repeat(500)] }] },
      LIMITS,
    );
    const item = result.subtasks[0]!.handoffContract![0]!;
    expect(item.length).toBeLessThanOrEqual(120);
    expect(item).toContain("已截断");
  });

  // Renumbering and dropping rewrite dependency references; the contract must ride along
  // with its own subtask rather than being lost or reattached to a different one.
  test("survives renumbering when an earlier subtask is dropped", () => {
    const result = validateDecomposePlan(
      {
        subtasks: [
          { id: 0, title: "t", description: "", handoffContract: ["会被丢弃"] },
          { id: 1, title: "t", description: "留下", handoffContract: ["会保留"] },
        ],
      },
      LIMITS,
    );
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]!.description).toBe("留下");
    expect(result.subtasks[0]!.handoffContract).toEqual(["会保留"]);
  });
});

describe("sanitizeDependencies", () => {
  test("filters illegal, dedupes, then caps", () => {
    const { cleaned, truncatedDeps } = sanitizeDependencies(
      [sub(3, "d", [0, 0, 1, 1, 2, 5, 3])],
      2,
    );
    // 5 and 3 are illegal (>= index); duplicates collapse; cap keeps 2.
    expect(cleaned[0]!.needsPriorResults).toEqual([0, 1]);
    expect(truncatedDeps).toHaveLength(1);
  });

  test("does not report truncation when the cap is not exceeded", () => {
    const { truncatedDeps } = sanitizeDependencies([sub(2, "c", [0, 1])], 3);
    expect(truncatedDeps).toHaveLength(0);
  });

  test("dedupe prevents repeated-value growth", () => {
    const spam = Array.from({ length: 200 }, () => 0);
    const { cleaned } = sanitizeDependencies([sub(1, "b", spam)], 3);
    expect(cleaned[0]!.needsPriorResults).toEqual([0]);
  });
});
