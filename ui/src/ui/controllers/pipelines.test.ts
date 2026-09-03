// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  initialPipelinesState,
  isDirty,
  moveStep,
  savePipeline,
  selectPipeline,
  startNewPipeline,
  updateDraft,
  type Pipeline,
  type PipelineDraft,
  type PipelinesHost,
} from "./pipelines.ts";

/**
 * `moveStep` is the single reordering primitive behind BOTH drag-and-drop and the
 * up/down buttons. Testing it directly is what keeps those two input methods from
 * drifting apart — and it needs no DOM, unlike the drag events themselves.
 */
describe("moveStep", () => {
  const list = ["a", "b", "c", "d"];

  it("moves an item down", () => {
    expect(moveStep(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up", () => {
    expect(moveStep(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("handles adjacent swaps, which is what the arrow buttons do", () => {
    expect(moveStep(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(moveStep(list, 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moving to the same index is a no-op", () => {
    expect(moveStep(list, 2, 2)).toEqual(list);
  });

  it("returns a new array rather than mutating in place", () => {
    const result = moveStep(list, 0, 1);
    expect(result).not.toBe(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  // Dropping past the last row is a normal gesture, so it clamps instead of failing.
  it("clamps an out-of-range target", () => {
    expect(moveStep(list, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveStep(list, 3, -5)).toEqual(["d", "a", "b", "c"]);
  });

  it("ignores an out-of-range source", () => {
    expect(moveStep(list, 9, 0)).toEqual(list);
    expect(moveStep(list, -1, 0)).toEqual(list);
  });

  it("handles a single-item list", () => {
    expect(moveStep(["only"], 0, 0)).toEqual(["only"]);
    expect(moveStep(["only"], 0, 3)).toEqual(["only"]);
  });

  it("handles an empty list", () => {
    expect(moveStep([], 0, 1)).toEqual([]);
  });

  it("round-trips: moving back restores the original order", () => {
    expect(moveStep(moveStep(list, 0, 3), 3, 0)).toEqual(list);
  });
});

/**
 * `isDirty` drives the unsaved-changes marker. Editing is staged rather than
 * auto-saved, so this is the only signal that leaving the page would lose work.
 */
describe("isDirty", () => {
  const stored: Pipeline = {
    id: "pl_a",
    name: "文档生成",
    steps: [
      { agentId: "research", instruction: "查" },
      { agentId: "writing", instruction: "写" },
    ],
    createdAt: 1,
    updatedAt: 1,
  };

  function draftOf(overrides: Partial<PipelineDraft> = {}): PipelineDraft {
    return {
      id: "pl_a",
      name: "文档生成",
      steps: stored.steps.map((s, i) => ({ ...s, uid: `u${i}` })),
      ...overrides,
    };
  }

  it("an untouched draft is clean", () => {
    expect(isDirty(draftOf(), [stored])).toBe(false);
  });

  it("no draft is clean", () => {
    expect(isDirty(null, [stored])).toBe(false);
  });

  // A pipeline that has never been saved is unsaved by definition.
  it("a draft with no id is always dirty", () => {
    expect(isDirty(draftOf({ id: undefined }), [stored])).toBe(true);
  });

  it("detects a renamed pipeline", () => {
    expect(isDirty(draftOf({ name: "改了" }), [stored])).toBe(true);
  });

  it("detects an added or removed step", () => {
    const added = draftOf({
      steps: [...draftOf().steps, { agentId: "coding", instruction: "x", uid: "u2" }],
    });
    expect(isDirty(added, [stored])).toBe(true);
    expect(isDirty(draftOf({ steps: [draftOf().steps[0]!] }), [stored])).toBe(true);
  });

  it("detects a changed agent or instruction", () => {
    const agentChanged = draftOf();
    agentChanged.steps[0] = { ...agentChanged.steps[0]!, agentId: "coding" };
    expect(isDirty(agentChanged, [stored])).toBe(true);

    const textChanged = draftOf();
    textChanged.steps[1] = { ...textChanged.steps[1]!, instruction: "写得更好" };
    expect(isDirty(textChanged, [stored])).toBe(true);
  });

  // Reordering changes nothing about the individual steps, so a naive per-step
  // comparison that ignored position would miss it entirely.
  it("detects a reorder", () => {
    const reordered = draftOf({ steps: moveStep(draftOf().steps, 0, 1) });
    expect(isDirty(reordered, [stored])).toBe(true);
  });

  // The uid is browser-only; it must not make a draft look changed.
  it("ignores the browser-only uid", () => {
    const rekeyed = draftOf({ steps: draftOf().steps.map((s) => ({ ...s, uid: "different" })) });
    expect(isDirty(rekeyed, [stored])).toBe(false);
  });

  // Someone else deleting it while we edit means our copy is unsaved work.
  it("a draft whose stored pipeline vanished is dirty", () => {
    expect(isDirty(draftOf(), [])).toBe(true);
  });
});

/**
 * Saving is the one action with no other visible effect: the list already showed the
 * pipeline, so without an explicit confirmation a successful save and a silently
 * swallowed one look identical.
 */
describe("save confirmation", () => {
  const stored: Pipeline = {
    id: "pl_a",
    name: "docs",
    steps: [{ agentId: "research", instruction: "look it up" }],
    createdAt: 1,
    updatedAt: 1,
  };

  function hostWith(response: unknown): PipelinesHost & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      client: {
        request: async (method: string) => {
          calls.push(method);
          return response as never;
        },
      },
      pipelinesState: { ...initialPipelinesState(), pipelines: [stored], revision: 1 },
    };
  }

  it("records a confirmation after a successful save", async () => {
    const host = hostWith({ ok: true, revision: 2, pipelines: [stored] });
    selectPipeline(host, "pl_a");
    updateDraft(host, (d) => ({ ...d, name: "docs v2" }));
    expect(await savePipeline(host)).toBe(true);
    expect(host.pipelinesState.notice).toBe("saved");
    expect(host.pipelinesState.error).toBeNull();
  });

  // The confirmation must not outlive the state it describes.
  it("clears the confirmation on the next edit", async () => {
    const host = hostWith({ ok: true, revision: 2, pipelines: [stored] });
    selectPipeline(host, "pl_a");
    updateDraft(host, (d) => ({ ...d, name: "docs v2" }));
    await savePipeline(host);
    updateDraft(host, (d) => ({ ...d, name: "docs v3" }));
    expect(host.pipelinesState.notice).toBeNull();
  });

  it("clears the confirmation when another pipeline is selected", async () => {
    const host = hostWith({ ok: true, revision: 2, pipelines: [stored] });
    startNewPipeline(host);
    updateDraft(host, (d) => ({ ...d, name: "new one" }));
    await savePipeline(host);
    expect(host.pipelinesState.notice).toBe("saved");
    selectPipeline(host, "pl_a");
    expect(host.pipelinesState.notice).toBeNull();
  });

  it("reports a rejection instead of a confirmation", async () => {
    const host = hostWith({
      ok: false,
      code: "invalid",
      message: "Step 1 has no agent selected",
      reason: { code: "step_no_agent", step: 1 },
      revision: 1,
      pipelines: [stored],
    });
    selectPipeline(host, "pl_a");
    updateDraft(host, (d) => ({ ...d, name: "" }));
    expect(await savePipeline(host)).toBe(false);
    expect(host.pipelinesState.notice).toBeNull();
    // Localized from `reason`, not the server's English prose.
    expect(host.pipelinesState.error).toBe("Step 1 has no agent selected.");
  });

  // A code this build has no string for must still say something useful.
  it("falls back to the server's message for an unknown reason code", async () => {
    const host = hostWith({
      ok: false,
      code: "invalid",
      message: "something new went wrong",
      reason: { code: "invented_later" },
      revision: 1,
      pipelines: [stored],
    });
    selectPipeline(host, "pl_a");
    updateDraft(host, (d) => ({ ...d, name: "x" }));
    await savePipeline(host);
    expect(host.pipelinesState.error).toBe("something new went wrong");
  });

  it("localizes a revision conflict by code", async () => {
    const host = hostWith({
      ok: false,
      code: "conflict",
      message: "Pipelines changed elsewhere; refreshed to the latest content",
      revision: 9,
      pipelines: [stored],
    });
    selectPipeline(host, "pl_a");
    updateDraft(host, (d) => ({ ...d, name: "x" }));
    await savePipeline(host);
    expect(host.pipelinesState.error).toContain("changed elsewhere");
    expect(host.pipelinesState.revision).toBe(9);
  });
});
