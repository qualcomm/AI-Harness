// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderTaskOrchestratorCard,
  type TaskOrchestratorDecision,
  type TaskOrchestratorProgress,
} from "./task-orchestrator-card.ts";

function draw(
  progress: TaskOrchestratorProgress | undefined,
  opts?: {
    expanded?: boolean;
    onToggleExpanded?: () => void;
    onDecision?: (decision: TaskOrchestratorDecision, adjustment?: string) => void;
    busy?: boolean;
    error?: string | null;
    replyLanded?: boolean;
  },
): HTMLElement {
  const host = document.createElement("div");
  render(
    renderTaskOrchestratorCard(progress, {
      expanded: opts?.expanded ?? true,
      onToggleExpanded: opts?.onToggleExpanded ?? (() => undefined),
      onDecision: opts?.onDecision ?? (() => undefined),
      busy: opts?.busy,
      error: opts?.error,
      replyLanded: opts?.replyLanded,
    }),
    host,
  );
  return host;
}

const PROGRESS: TaskOrchestratorProgress = {
  updatedAt: 1,
  startedAt: 1,
  plannedTotalLayers: 2,
  approvalId: null,
  awaitingConfirmation: false,
  subtasks: [
    {
      id: 0,
      title: "查资料",
      description: "查资料",
      agentId: "research",
      acceptanceCriteria: null,
      needsPriorResults: [],
      layer: 1,
    },
    {
      id: 1,
      title: "写代码",
      description: "写代码",
      agentId: "coding",
      acceptanceCriteria: "review",
      needsPriorResults: [0],
      layer: 2,
    },
  ],
  layers: [
    {
      layer: 1,
      totalLayers: 2,
      results: [{ id: 0, agentId: "research", status: "ok", verifyAttempts: 1, error: null }],
    },
  ],
};

describe("renderTaskOrchestratorCard", () => {
  it("renders nothing without progress, so no empty card appears in the flow", () => {
    expect(draw(undefined).querySelector(".dto-card")).toBeNull();
    expect(
      draw({
        subtasks: [],
        layers: [],
        updatedAt: 1,
        startedAt: 1,
        plannedTotalLayers: null,
        approvalId: null,
        awaitingConfirmation: false,
      }).querySelector(
        ".dto-card",
      ),
    ).toBeNull();
  });

  it("lists every subtask with its agent and acceptance criteria", () => {
    const host = draw(PROGRESS);
    const text = host.textContent ?? "";
    expect(text).toContain("查资料");
    expect(text).toContain("research");
    expect(text).toContain("Checks");
    expect(text).toContain("review");
    // A subtask with no criteria says so rather than leaving the slot blank.
    expect(host.querySelector(".dto-criteria--none")?.textContent).toContain("No checks");
    expect(text).toContain("← depends on #0");
  });

  it("shows routing as pending when the agent is not resolved yet", () => {
    // The plugin publishes the plan before the classifier runs, so the card renders
    // with agentId null for a few seconds. It must not look assigned, and must not
    // print "null".
    const host = draw({
      ...PROGRESS,
      subtasks: PROGRESS.subtasks.map((s) => ({ ...s, agentId: null })),
    });
    const pending = host.querySelectorAll(".dto-agent--pending");
    expect(pending).toHaveLength(2);
    expect(pending[0]!.textContent).toContain("Assigning");
    const text = host.textContent ?? "";
    expect(text).not.toContain("null");
    // The rest of the plan is shown, which is the reason for publishing early.
    expect(text).toContain("查资料");
    expect(text).toContain("← depends on #0");
  });

  it("renders criteria as a wrapping block, not a nowrap badge that would overflow", () => {
    // Regression: criteria used to reuse `.dto-agent` (white-space: nowrap, sized for
    // short agent ids), so a sentence-long criterion pushed the card sideways.
    const host = draw({
      ...PROGRESS,
      subtasks: [
        {
          ...PROGRESS.subtasks[0]!,
          acceptanceCriteria: "结果必须列出至少两条官方来源链接，并说明每条结论的依据".repeat(3),
        },
      ],
    });
    expect(host.querySelector(".dto-agent--verifier")).toBeNull();
    const textEl = host.querySelector(".dto-criteria__text");
    expect(textEl).not.toBeNull();
    expect(textEl!.textContent).toContain("官方来源链接");
  });

  it("groups subtasks under their dependency layer", () => {
    const host = draw(PROGRESS);
    const groups = host.querySelectorAll(".dto-layer-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain("Layer 1");
    expect(groups[0]!.textContent).toContain("查资料");
    expect(groups[1]!.textContent).toContain("Layer 2");
    expect(groups[1]!.textContent).toContain("写代码");
  });

  it("shows the finished layer and marks the next one as still running", () => {
    const host = draw(PROGRESS);
    expect(host.textContent).toContain("Layer 1/2 finished");
    expect(host.textContent).toContain("Layer 2/2");
    expect(host.querySelector(".dto-tl__dot--run")).not.toBeNull();
    expect(host.querySelector(".dto-tl__dot--ok")).not.toBeNull();
  });

  it("stops showing a running marker once the last layer reports", () => {
    const finished: TaskOrchestratorProgress = {
      ...PROGRESS,
      layers: [
        ...PROGRESS.layers,
        {
          layer: 2,
          totalLayers: 2,
          results: [
            { id: 1, agentId: "coding", status: "error", verifyAttempts: null, error: "未通过" },
          ],
        },
      ],
    };
    const host = draw(finished);
    expect(host.querySelector(".dto-tl__dot--run")).toBeNull();
    expect(host.textContent).toContain("all 2 layers finished");
    expect(host.textContent).toContain("1 failed");
    expect(host.querySelector(".dto-chip--err")).not.toBeNull();
  });

  it("keeps every layer visible, not just the newest", () => {
    const host = draw({
      ...PROGRESS,
      layers: [
        PROGRESS.layers[0]!,
        { layer: 2, totalLayers: 3, results: [] },
        { layer: 3, totalLayers: 3, results: [] },
      ],
    });
    expect(host.querySelectorAll(".dto-tl")).toHaveLength(3);
  });

  it("collapses to just the summary row and toggles on click", () => {
    const onToggleExpanded = vi.fn();
    const host = draw(PROGRESS, { expanded: false, onToggleExpanded });
    expect(host.querySelector(".dto-card__body")).toBeNull();
    expect(host.querySelector(".dto-card--open")).toBeNull();
    host.querySelector<HTMLButtonElement>(".dto-card__summary")!.click();
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("reports the verify attempt count only when it took more than one", () => {
    const host = draw({
      ...PROGRESS,
      layers: [
        {
          layer: 1,
          totalLayers: 2,
          results: [
            { id: 0, agentId: "research", status: "ok", verifyAttempts: 2, error: null },
          ],
        },
      ],
    });
    expect(host.textContent).toContain("verified on attempt 2");
    expect(draw(PROGRESS).textContent).not.toContain("verified on attempt 1");
  });
});

describe("re-decomposing state", () => {
  const AWAITING: TaskOrchestratorProgress = {
    ...PROGRESS,
    layers: [],
    approvalId: "abc-123",
    awaitingConfirmation: true,
  };
  const REDECOMPOSING: TaskOrchestratorProgress = {
    ...PROGRESS,
    layers: [],
    approvalId: null,
    awaitingConfirmation: false,
    redecomposing: { adjustment: "把 2 和 3 合并" },
  };

  it("is absent until the plugin reports it", () => {
    expect(draw(AWAITING).querySelector(".dto-redecomposing")).toBeNull();
  });

  it("shows a spinner, the wait hint, and echoes the operator's wording", () => {
    const host = draw(REDECOMPOSING);
    const row = host.querySelector(".dto-redecomposing");
    expect(row).not.toBeNull();
    expect(row!.querySelector(".dto-spinner")).not.toBeNull();
    expect(row!.textContent).toContain("Re-planning with your feedback");
    // The echo is the point: it confirms the typed text was received.
    expect(row!.querySelector(".dto-redecomposing__quote")!.textContent).toContain(
      "把 2 和 3 合并",
    );
    expect(row!.textContent).toContain("30-60");
  });

  // The superseded approvalId was already consumed, so a live button here fails with
  // "unknown or already-answered confirmation".
  it("replaces the confirm bar rather than sitting alongside it", () => {
    const host = draw(REDECOMPOSING);
    expect(host.querySelector(".dto-redecomposing")).not.toBeNull();
    expect(host.querySelector(".dto-confirm")).toBeNull();
  });

  it("labels the superseded rows as pending replacement, not queued to run", () => {
    const host = draw(REDECOMPOSING);
    const text = host.textContent ?? "";
    expect(text).toContain("To be replaced");
    expect(text).not.toContain("Queued");
  });

  // Nothing has executed yet, so a timeline would render an empty section — the same
  // reason it is suppressed while awaiting confirmation.
  it("does not render the timeline", () => {
    expect(draw(REDECOMPOSING).querySelector(".dto-tl")).toBeNull();
  });

  it("overrides the header label and shows the state collapsed too", () => {
    const summary = draw(REDECOMPOSING).querySelector(".dto-card__summary")!;
    // The spinner chip carries the state; the label says which plan is on screen. Both
    // saying "Re-planning" would be redundant, so the label must not repeat it.
    expect(summary.textContent).toContain("Re-planning");
    expect(summary.querySelector(".dto-card__count")!.textContent).toContain("previous plan");
    expect(summary.querySelector(".dto-card__count")!.textContent).not.toContain("Re-planning");

    // A card left collapsed through a 60s wait must still show something is happening.
    const collapsed = draw(REDECOMPOSING, { expanded: false });
    expect(collapsed.querySelector(".dto-card__body")).toBeNull();
    expect(collapsed.textContent).toContain("Re-planning");
    expect(collapsed.querySelector(".dto-spinner")).not.toBeNull();
  });

  it("keeps the superseded plan visible as context for what is being changed", () => {
    const host = draw(REDECOMPOSING);
    expect(host.textContent).toContain("查资料");
    expect(host.textContent).toContain("写代码");
  });

  it("omits the quote when no wording came through", () => {
    const host = draw({ ...REDECOMPOSING, redecomposing: { adjustment: "" } });
    expect(host.querySelector(".dto-redecomposing")).not.toBeNull();
    expect(host.querySelector(".dto-redecomposing__quote")).toBeNull();
  });
});

describe("summarizing state", () => {
  const FINISHED: TaskOrchestratorProgress = {
    ...PROGRESS,
    layers: [
      ...PROGRESS.layers,
      {
        layer: 2,
        totalLayers: 2,
        results: [{ id: 1, agentId: "coding", status: "ok", verifyAttempts: 1, error: null }],
      },
    ],
  };
  const SUMMARIZING: TaskOrchestratorProgress = {
    ...FINISHED,
    summarizing: { okCount: 2, totalCount: 2 },
  };

  it("is absent when the plugin has not reported summarizing", () => {
    expect(draw(FINISHED).querySelector(".dto-summarizing")).toBeNull();
  });

  it("shows a spinner and a wait message while summarizing", () => {
    const host = draw(SUMMARIZING);
    const row = host.querySelector(".dto-summarizing");
    expect(row).not.toBeNull();
    expect(row!.querySelector(".dto-spinner")).not.toBeNull();
    expect(row!.textContent).toContain("Composing");
    expect(row!.textContent).toMatch(/Composing the final reply/);
  });

  // The summary IS the reply, so the plugin sends no "done" event — the reply landing
  // in the flow is the only stop condition. Without this the spinner never clears.
  it("disappears once this plan's reply has landed", () => {
    const host = draw(SUMMARIZING, { replyLanded: true });
    expect(host.querySelector(".dto-summarizing")).toBeNull();
  });

  it("mentions partial failure rather than implying a clean sweep", () => {
    const host = draw({ ...SUMMARIZING, summarizing: { okCount: 1, totalCount: 2 } });
    expect(host.querySelector(".dto-summarizing")!.textContent).toContain("1/2");
  });

  // Every layer has reported by the time summarizing starts, so the header would
  // otherwise claim completion while the answer is still minutes away.
  it("overrides the finished header instead of claiming completion", () => {
    const host = draw(SUMMARIZING);
    const summary = host.querySelector(".dto-card__summary")!;
    expect(summary.textContent).toContain("Summarizing");
    expect(summary.textContent).not.toContain("all 2 layers finished");
  });

  it("shows the integrating state even when the card is collapsed", () => {
    const host = draw(SUMMARIZING, { expanded: false });
    expect(host.querySelector(".dto-card__body")).toBeNull();
    expect(host.textContent).toContain("Summarizing");
  });

  it("returns to the finished header after the reply lands", () => {
    const host = draw(SUMMARIZING, { replyLanded: true });
    expect(host.querySelector(".dto-card__summary")!.textContent).toContain("all 2 layers finished");
  });
});

describe("confirmation bar", () => {
  const AWAITING: TaskOrchestratorProgress = {
    ...PROGRESS,
    layers: [],
    approvalId: "abc-123",
    awaitingConfirmation: true,
  };

  it("is absent when not awaiting confirmation", () => {
    const host = draw(PROGRESS);
    expect(host.querySelector(".dto-confirm")).toBeNull();
  });

  it("is absent when awaiting but no approvalId was supplied, so no button is dead", () => {
    const host = draw({ ...AWAITING, approvalId: null });
    expect(host.querySelector(".dto-confirm")).toBeNull();
  });

  it("renders while awaiting, and labels the card as pending", () => {
    const host = draw(AWAITING);
    expect(host.querySelector(".dto-confirm")).not.toBeNull();
    expect(host.textContent).toContain("Awaiting confirmation");
  });

  it("hides the timeline while awaiting, since nothing has run yet", () => {
    const host = draw(AWAITING);
    expect(host.querySelector(".dto-timeline")).toBeNull();
    // The plan being asked about is still shown.
    expect(host.textContent).toContain("查资料");
  });

  it("confirm reports the decision with no adjustment", () => {
    const onDecision = vi.fn();
    const host = draw(AWAITING, { onDecision });
    host.querySelector<HTMLButtonElement>(".dto-confirm__btn--primary")!.click();
    expect(onDecision).toHaveBeenCalledWith("confirm");
  });

  it("cancel reports the decision", () => {
    const onDecision = vi.fn();
    const host = draw(AWAITING, { onDecision });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".dto-confirm__btn")];
    buttons.find((b) => b.textContent?.includes("Cancel"))!.click();
    expect(onDecision).toHaveBeenCalledWith("cancel");
  });

  it("adjust sends the text typed into the field", () => {
    const onDecision = vi.fn();
    const host = draw(AWAITING, { onDecision });
    host.querySelector<HTMLTextAreaElement>(".dto-confirm__input")!.value = "  把 2 和 3 合并  ";
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".dto-confirm__btn")];
    buttons.find((b) => b.textContent?.includes("Re-plan"))!.click();
    expect(onDecision).toHaveBeenCalledWith("adjust", "把 2 和 3 合并");
  });

  it("an empty adjustment is not sent, since it would re-run the decomposer for nothing", () => {
    const onDecision = vi.fn();
    const host = draw(AWAITING, { onDecision });
    host.querySelector<HTMLTextAreaElement>(".dto-confirm__input")!.value = "   ";
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".dto-confirm__btn")];
    buttons.find((b) => b.textContent?.includes("Re-plan"))!.click();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("busy disables every control so a decision cannot be sent twice", () => {
    const host = draw(AWAITING, { busy: true });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".dto-confirm__btn")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>(".dto-confirm__input")!.disabled).toBe(true);
  });

  it("shows an error when one is supplied", () => {
    const host = draw(AWAITING, { error: "submit failed: boom" });
    expect(host.querySelector(".dto-confirm__error")!.textContent).toContain("submit failed");
  });
});

describe("per-subtask state while awaiting confirmation", () => {
  const AWAITING: TaskOrchestratorProgress = {
    ...PROGRESS,
    layers: [],
    approvalId: "abc-123",
    awaitingConfirmation: true,
  };

  it("shows \"Awaiting confirmation\" rather than \"Queued\", which would imply the plan was accepted", () => {
    const host = draw(AWAITING);
    const states = [...host.querySelectorAll(".dto-state")].map((n) => n.textContent?.trim());
    expect(states).toContain("Awaiting confirmation");
    expect(states).not.toContain("Queued");
  });

  it("reverts to \"Queued\" once execution has started", () => {
    const host = draw({ ...AWAITING, approvalId: null, awaitingConfirmation: false });
    const states = [...host.querySelectorAll(".dto-state")].map((n) => n.textContent?.trim());
    expect(states).toContain("Queued");
    expect(states).not.toContain("Awaiting confirmation");
  });
});

describe("subtask tool activity", () => {
  const WITH_ACTIVITY: TaskOrchestratorProgress = {
    ...PROGRESS,
    toolCalls: [
      {
        subtaskId: 0,
        toolName: "web_fetch",
        phase: "result",
        role: "work",
        summary: "url=https://x.dev",
        error: null,
      },
      {
        subtaskId: 0,
        toolName: "write",
        phase: "start",
        role: "work",
        summary: "file_path=/tmp/a.ts",
        error: null,
      },
    ],
  };

  it("renders nothing when there is no activity", () => {
    expect(draw(PROGRESS).querySelector(".dto-activity")).toBeNull();
  });

  it("lists the tool name and its condensed detail", () => {
    const host = draw(WITH_ACTIVITY);
    const text = host.textContent ?? "";
    expect(text).toContain("web_fetch");
    expect(text).toContain("url=https://x.dev");
    expect(text).toContain("write");
    expect(text).toContain("file_path=/tmp/a.ts");
  });

  it("marks a finished call differently from a running one", () => {
    const host = draw(WITH_ACTIVITY);
    expect(host.querySelector(".dto-activity__dot--ok")).not.toBeNull();
    expect(host.querySelector(".dto-activity__dot--run")).not.toBeNull();
  });

  it("shows the error instead of the summary when a call failed", () => {
    const host = draw({
      ...PROGRESS,
      toolCalls: [
        {
          subtaskId: 0,
          toolName: "web_fetch",
          phase: "result",
          role: "work",
          summary: "url=https://x.dev",
          error: "404",
        },
      ],
    });
    expect(host.querySelector(".dto-activity__dot--err")).not.toBeNull();
    expect(host.querySelector(".dto-activity__detail")!.textContent).toContain("404");
  });

  it("labels a verifier's calls", () => {
    const host = draw({
      ...PROGRESS,
      toolCalls: [
        {
          subtaskId: 0,
          toolName: "read",
          phase: "result",
          role: "verify",
          summary: null,
          error: null,
        },
      ],
    });
    expect(host.querySelector(".dto-activity__role")!.textContent).toContain("verify");
  });

  it("attaches each call under its own subtask only", () => {
    const host = draw({
      ...PROGRESS,
      toolCalls: [
        {
          subtaskId: 1,
          toolName: "only_for_one",
          phase: "start",
          role: "work",
          summary: null,
          error: null,
        },
      ],
    });
    // One activity block total, since only subtask 1 has any calls.
    expect(host.querySelectorAll(".dto-activity")).toHaveLength(1);
    expect(host.textContent).toContain("only_for_one");
  });
});

describe("running indicator", () => {
  it("shows a spinner and \"Running\" for a running subtask", () => {
    const host = draw({ ...PROGRESS, layers: [], runningSubtaskIds: [0] });
    expect(host.querySelector(".dto-spinner")).not.toBeNull();
    expect(host.textContent).toContain("Running");
  });

  it("queued subtasks keep \"Queued\" without a spinner", () => {
    const host = draw({ ...PROGRESS, layers: [], runningSubtaskIds: [] });
    expect(host.querySelector(".dto-spinner")).toBeNull();
    expect(host.textContent).toContain("Queued");
  });

  it("only the running subtask gets the spinner", () => {
    const host = draw({ ...PROGRESS, layers: [], runningSubtaskIds: [1] });
    expect(host.querySelectorAll(".dto-spinner")).toHaveLength(1);
  });

  it("awaiting confirmation wins over running, since nothing should have started", () => {
    const host = draw({
      ...PROGRESS,
      layers: [],
      approvalId: "abc",
      awaitingConfirmation: true,
      runningSubtaskIds: [0],
    });
    expect(host.querySelector(".dto-spinner")).toBeNull();
    expect(host.textContent).toContain("Awaiting confirmation");
  });

  it("a completed subtask shows its result, not a spinner", () => {
    // PROGRESS already carries a layer result for subtask 0.
    const host = draw({ ...PROGRESS, runningSubtaskIds: [0] });
    expect(host.querySelector(".dto-spinner")).toBeNull();
  });
});

describe("startedAt is exposed for turn-aware placement", () => {
  // views/chat.ts compares it against the trailing assistant group's timestamp so a
  // new request's card cannot land above the PREVIOUS request's reply.
  it("is carried on the progress entry", () => {
    expect(PROGRESS.startedAt).toBe(1);
  });

  it("renders regardless of its value — placement is the caller's concern", () => {
    expect(draw({ ...PROGRESS, startedAt: 999 }).querySelector(".dto-card")).not.toBeNull();
  });
});

/**
 * Pipeline mode.
 *
 * The card is shared with the dynamic path deliberately — a fixed pipeline is a strictly
 * sequential dependency chain, so step N maps onto layer N faithfully. What must NOT be
 * shared is the vocabulary and the sections that do not apply, which is what these cover.
 */
const PIPELINE: TaskOrchestratorProgress = {
  updatedAt: 1,
  startedAt: 1,
  plannedTotalLayers: 2,
  approvalId: null,
  awaitingConfirmation: false,
  mode: "pipeline",
  pipelineName: "文档生成",
  subtasks: [
    {
      id: 0,
      title: "查资料",
      description: "",
      agentId: "research",
      acceptanceCriteria: null,
      needsPriorResults: [],
      layer: 1,
    },
    {
      id: 1,
      title: "写文档",
      description: "",
      agentId: "writing",
      acceptanceCriteria: null,
      needsPriorResults: [],
      layer: 2,
    },
  ],
  layers: [],
};

function pipelineWith(layers: TaskOrchestratorProgress["layers"]): TaskOrchestratorProgress {
  return { ...PIPELINE, layers };
}

describe("pipeline mode", () => {
  it("names the pipeline in the title and counts steps, not subtasks", () => {
    const host = draw(PIPELINE);
    expect(host.querySelector(".dto-card__title")!.textContent).toContain("文档生成");
    const count = host.querySelector(".dto-card__count")!.textContent!;
    expect(count).toContain("2 steps");
    expect(count).not.toContain("subtasks");
  });

  it("labels the timeline in steps rather than layers", () => {
    const host = draw(
      pipelineWith([
        {
          layer: 1,
          totalLayers: 2,
          results: [
            { id: 0, agentId: "research", status: "ok", verifyAttempts: null, error: null },
          ],
        },
      ]),
    );
    const text = host.textContent!;
    expect(text).toContain("Step 1/2 finished");
    expect(text).toContain("Workflow steps (in order)");
    expect(text).toContain("Progress by step");
    // The dynamic path's noun must not leak through anywhere.
    expect(text.toLowerCase()).not.toContain("layer");
    expect(text.toLowerCase()).not.toContain("subtask");
  });

  // Every group holds exactly one step, so a heading per group would double the list's
  // height and repeat the number the row already carries.
  it("numbers rows from 1 and shows no per-group headings", () => {
    const host = draw(PIPELINE);
    expect(host.querySelectorAll(".dto-layer-group__title")).toHaveLength(0);
    expect(
      [...host.querySelectorAll(".dto-subtask")].map(
        (row) => row.querySelector(".dto-subtask__idx")!.textContent!.trim(),
      ),
    ).toEqual(["1", "2"]);
  });

  // Fixed pipelines have no acceptance criteria, so the shared row would read "no checks"
  // under every single step — pure noise on a list whose whole point is the order.
  it("omits the acceptance-criteria row entirely", () => {
    const host = draw(PIPELINE);
    expect(host.querySelector(".dto-criteria")).toBeNull();
    expect(host.textContent).not.toContain("No checks");
  });

  it("shows no confirmation controls", () => {
    const host = draw(PIPELINE);
    expect(host.querySelector(".dto-confirm")).toBeNull();
  });

  it("still shows tool activity for a step", () => {
    const host = draw({
      ...PIPELINE,
      toolCalls: [
        {
          subtaskId: 1,
          toolName: "web_search",
          phase: "result",
          role: "work",
          summary: "query=arm64",
          error: null,
        },
      ],
    });
    expect(host.querySelector(".dto-activity__tool")!.textContent).toContain("web_search");
    expect(host.querySelector(".dto-activity__detail")!.textContent).toContain("arm64");
  });

  // A step never reached is not a failure of that step, so it must not be coloured or
  // counted as one — that would point the reader at the wrong step.
  it("renders a skipped step as not-run rather than failed", () => {
    const host = draw(
      pipelineWith([
        {
          layer: 1,
          totalLayers: 2,
          results: [
            { id: 0, agentId: "research", status: "error", verifyAttempts: null, error: "超时" },
          ],
        },
        {
          layer: 2,
          totalLayers: 2,
          results: [
            { id: 1, agentId: "writing", status: "skipped", verifyAttempts: null, error: null },
          ],
        },
      ]),
    );
    expect(host.querySelectorAll(".dto-state--skip").length).toBeGreaterThan(0);
    expect(host.querySelector(".dto-chip--skip")).not.toBeNull();
    // The skipped layer must not report "all passed".
    expect(host.textContent).not.toContain("All passed");
  });

  it("reads as finished once every step has reported", () => {
    const host = draw(
      pipelineWith([
        {
          layer: 1,
          totalLayers: 2,
          results: [
            { id: 0, agentId: "research", status: "ok", verifyAttempts: null, error: null },
          ],
        },
        {
          layer: 2,
          totalLayers: 2,
          results: [{ id: 1, agentId: "writing", status: "ok", verifyAttempts: null, error: null }],
        },
      ]),
    );
    const summary = host.querySelector(".dto-card__summary")!;
    expect(summary.textContent).toContain("all 2 steps finished");
    expect(summary.querySelector(".dto-state--run")).toBeNull();
  });
});

/**
 * A run that dies between two steps never sends the remaining `end` events, so the
 * layer count never reaches the total. The reply landing is the only other signal that
 * the turn is over.
 */
describe("a landed reply settles the card", () => {
  it("stops claiming progress even with steps unaccounted for", () => {
    const stillRunning = draw(PIPELINE);
    expect(stillRunning.querySelector(".dto-state--run")).not.toBeNull();

    const settled = draw(PIPELINE, { replyLanded: true });
    expect(settled.querySelector(".dto-card__summary")!.querySelector(".dto-state--run")).toBeNull();
  });
});
