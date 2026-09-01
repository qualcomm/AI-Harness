/* @vitest-environment jsdom */

/**
 * Reordering through the actual DOM, both routes.
 *
 * `controllers/pipelines.test.ts` covers `moveStep` in isolation, and that was not
 * enough: the primitive was correct while the drop handler passed it the destination
 * index as BOTH endpoints, so every drag was a silent no-op. The bug lived entirely in
 * the wiring, which only a test that goes through the rendered handlers can see.
 *
 * jsdom implements no drag-and-drop, but these handlers only call `preventDefault()` and
 * an optional `dataTransfer?.setData`, so plain synthetic events exercise them faithfully.
 */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderPipelines, type PipelinesProps } from "./pipelines.ts";
import { type DraftStep, type PipelineDraft } from "../controllers/pipelines.ts";

function stepsOf(...agentIds: string[]): DraftStep[] {
  return agentIds.map((agentId, i) => ({ agentId, instruction: `do ${agentId}`, uid: `u${i}` }));
}

/**
 * Render, then drive events against the result. `draft` is mutated by `onDraftChange`
 * the way the controller would, so the assertions read the post-edit order.
 */
function harness(agentIds: string[], drag: { dragging: number | null; drop: number | null } = {
  dragging: null,
  drop: null,
}) {
  let draft: PipelineDraft = { id: "pl_a", name: "docs", steps: stepsOf(...agentIds) };
  const dragState: { dragging: number | null; drop: number | null } = { ...drag };
  const host = document.createElement("div");

  const draw = () => {
    const props: PipelinesProps = {
      pipelines: [],
      available: true,
      loading: false,
      saving: false,
      error: null,
      notice: null,
      selectedId: "pl_a",
      draft,
      dirty: false,
      agentIds,
      draggingIndex: dragState.dragging,
      dropTargetIndex: dragState.drop,
      onSelect: () => undefined,
      onNew: () => undefined,
      onSave: () => undefined,
      onDelete: () => undefined,
      onDraftChange: (mutate) => {
        draft = mutate(draft);
        draw();
      },
      onDragState: (dragging, dropTarget) => {
        dragState.dragging = dragging;
        dragState.drop = dropTarget;
        draw();
      },
    };
    render(renderPipelines(props), host);
  };
  draw();

  const rows = () => [...host.querySelectorAll<HTMLElement>(".pl-step")];
  const fire = (el: Element, type: string) =>
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

  return {
    host,
    rows,
    fire,
    order: () => draft.steps.map((s) => s.agentId),
    uids: () => draft.steps.map((s) => s.uid),
    dragState,
  };
}

describe("drag to reorder", () => {
  it("moves the dragged row to the row it is dropped on", () => {
    const h = harness(["research", "writing", "coding"]);
    const rows = h.rows();
    h.fire(rows[0]!.querySelector(".pl-step__handle")!, "dragstart");
    expect(h.dragState.dragging).toBe(0);
    // Re-queried: the rows were re-rendered when the drag state changed.
    h.fire(h.rows()[2]!, "dragover");
    h.fire(h.rows()[2]!, "drop");
    expect(h.order()).toEqual(["writing", "coding", "research"]);
  });

  it("moves a later row up", () => {
    const h = harness(["research", "writing", "coding"]);
    h.fire(h.rows()[2]!.querySelector(".pl-step__handle")!, "dragstart");
    h.fire(h.rows()[0]!, "dragover");
    h.fire(h.rows()[0]!, "drop");
    expect(h.order()).toEqual(["coding", "research", "writing"]);
  });

  it("dropping a row on itself changes nothing", () => {
    const h = harness(["research", "writing"]);
    h.fire(h.rows()[1]!.querySelector(".pl-step__handle")!, "dragstart");
    h.fire(h.rows()[1]!, "drop");
    expect(h.order()).toEqual(["research", "writing"]);
  });

  // Without a drag in progress there is no source index, so a stray drop — from the
  // desktop, another window — must not reorder anything.
  it("ignores a drop with no drag in progress", () => {
    const h = harness(["research", "writing"]);
    h.fire(h.rows()[0]!, "drop");
    expect(h.order()).toEqual(["research", "writing"]);
  });

  it("clears the drag state on drop", () => {
    const h = harness(["research", "writing"]);
    h.fire(h.rows()[0]!.querySelector(".pl-step__handle")!, "dragstart");
    h.fire(h.rows()[1]!, "drop");
    expect(h.dragState.dragging).toBeNull();
    expect(h.dragState.drop).toBeNull();
  });

  // Releasing outside the window fires dragend but never drop.
  it("clears the drag state on dragend without a drop", () => {
    const h = harness(["research", "writing"]);
    h.fire(h.rows()[0]!.querySelector(".pl-step__handle")!, "dragstart");
    h.fire(h.rows()[0]!.querySelector(".pl-step__handle")!, "dragend");
    expect(h.dragState.dragging).toBeNull();
    expect(h.order()).toEqual(["research", "writing"]);
  });

  // Cancelling dragover is what makes the row a drop target at all; an uncancelled
  // dragover means the browser never fires drop.
  it("cancels dragover so the browser will deliver a drop", () => {
    const h = harness(["research", "writing"]);
    h.fire(h.rows()[0]!.querySelector(".pl-step__handle")!, "dragstart");
    const evt = new Event("dragover", { bubbles: true, cancelable: true });
    h.rows()[1]!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(h.dragState.drop).toBe(1);
  });

  // Dragging from inside the instruction field would fight text selection, so the
  // handle is the only draggable element.
  it("makes only the handle draggable", () => {
    const h = harness(["research", "writing"]);
    const row = h.rows()[0]!;
    expect(row.getAttribute("draggable")).toBeNull();
    expect(row.querySelector(".pl-step__handle")!.getAttribute("draggable")).toBe("true");
    expect(row.querySelector(".pl-textarea")!.getAttribute("draggable")).toBeNull();
  });

  // A drop over the textarea still bubbles to the row, and the row cancels the event —
  // otherwise the browser would also paste the drag payload into the field.
  it("handles a drop landing on the instruction field", () => {
    const h = harness(["research", "writing", "coding"]);
    h.fire(h.rows()[0]!.querySelector(".pl-step__handle")!, "dragstart");
    const evt = new Event("drop", { bubbles: true, cancelable: true });
    h.rows()[2]!.querySelector(".pl-textarea")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(h.order()).toEqual(["writing", "coding", "research"]);
  });
});

describe("arrow buttons", () => {
  const up = (row: HTMLElement) => row.querySelectorAll<HTMLButtonElement>(".pl-icon-btn")[0]!;
  const down = (row: HTMLElement) => row.querySelectorAll<HTMLButtonElement>(".pl-icon-btn")[1]!;

  it("moves a row down", () => {
    const h = harness(["research", "writing", "coding"]);
    down(h.rows()[0]!).click();
    expect(h.order()).toEqual(["writing", "research", "coding"]);
  });

  it("moves a row up", () => {
    const h = harness(["research", "writing", "coding"]);
    up(h.rows()[2]!).click();
    expect(h.order()).toEqual(["research", "coding", "writing"]);
  });

  it("disables up on the first row and down on the last", () => {
    const h = harness(["research", "writing"]);
    expect(up(h.rows()[0]!).disabled).toBe(true);
    expect(down(h.rows()[0]!).disabled).toBe(false);
    expect(down(h.rows()[1]!).disabled).toBe(true);
  });

  // The two routes must agree: a down-arrow and a drag onto the next row are the same
  // edit, and were not before the drop handler's endpoints were fixed.
  it("agrees with an equivalent drag", () => {
    const byButton = harness(["research", "writing", "coding"]);
    down(byButton.rows()[0]!).click();

    const byDrag = harness(["research", "writing", "coding"]);
    byDrag.fire(byDrag.rows()[0]!.querySelector(".pl-step__handle")!, "dragstart");
    byDrag.fire(byDrag.rows()[1]!, "drop");

    expect(byDrag.order()).toEqual(byButton.order());
    // The browser-only keys travel with their rows; reusing them by position is what
    // made instruction fields appear to swap contents.
    expect(byDrag.uids()).toEqual(byButton.uids());
  });
});
