/**
 * Top-level orchestration for a decomposition request.
 *
 * Wires validation -> (pass through | confirm | pipeline) -> summarize, and
 * guarantees the mandatory notices reach the user on every orchestrated return
 * path.
 */

import { validateDecomposePlan } from "./decomposer.js";
import { logInfo } from "./log.js";
import { formatLayerProgressNotice, formatPrdNotice, formatSummarizingNotice } from "./notify.js";
import { layerByDependency, resolveAgentsFor, runPipeline } from "./pipeline.js";
import { createPendingApproval } from "./prd-approval.js";
import {
  emitLayerProgressEvent,
  emitPrdEvent,
  emitRedecomposingEvent,
  emitSummarizingEvent,
} from "./progress-event.js";
import { decomposeTask } from "./resolve-agent.js";
import { buildMandatoryNotices, summarize } from "./summarize.js";
import type { Logger, SubagentRuntime } from "./runtime-contract.js";
import type { DragonTaskOrchestratorConfig, SubtaskPlan, ValidatedPlan } from "./types.js";

const CANCELLED_REPLY = "已按你的选择取消，没有执行任何子任务。";

export type HandleRequestDeps = {
  subagent: SubagentRuntime | undefined;
  cfg: DragonTaskOrchestratorConfig;
  /** Top-level session of this request; the root of any delegation chain. */
  rootSessionKey: string;
  knownAgentIds: Set<string>;
  /** Per-agent description (borrowed from `systemPromptOverride`) fed to the classifier. */
  agentDescriptions: Map<string, string>;
  orchestratorAgentId: string;
  logger?: Logger;
  /**
   * Best-effort out-of-band notifier for PRD / progress notices (see notify.ts).
   * Absent or returning `false` means "not delivered", which keeps the existing
   * final-reply fallback behaviour intact.
   */
  notify?: (text: string) => Promise<boolean>;
  /**
   * Gateway event broadcast for the Control UI (see progress-event.ts). Separate
   * from `notify` on purpose: webchat is unreachable through the channel outbound
   * path, so covering both surfaces takes two calls, not one.
   */
  emitEvent?: (eventType: string, payload: Record<string, unknown>) => void;
};

/** Notice inputs shared by every return path. */
function noticeInputFor(validated: ValidatedPlan, promptTruncated: boolean) {
  return {
    droppedSubtasks: validated.droppedSubtasks,
    truncatedDescriptions: validated.truncatedDescriptions,
    droppedEmptyDescriptions: validated.droppedEmptyDescriptions,
    truncatedDeps: validated.truncatedDeps,
    promptTruncated,
  };
}

/**
 * Handle a decomposed request. Returns the final reply, or `null` when the
 * request turned out not to need decomposition and should fall through to the
 * ordinary reply path.
 *
 * `originalPrompt` must ALREADY be truncated by the caller, and `promptTruncated`
 * must reflect that. Truncating here would be too late: the call that actually
 * consumes the raw prompt (decompose) happens upstream in the hook, so a limit
 * applied at this point would protect only the summarizer.
 */
export async function handleDecomposedRequest(
  deps: HandleRequestDeps,
  params: {
    originalPrompt: string;
    rawPlan: unknown;
    promptTruncated: boolean;
  },
): Promise<string | null> {
  const { cfg, logger } = deps;
  const { originalPrompt, rawPlan, promptTruncated } = params;

  const validated = validateDecomposePlan(rawPlan, {
    maxSubtasks: cfg.maxSubtasks,
    maxDescriptionChars: cfg.maxDescriptionChars,
    maxDepsPerSubtask: cfg.maxDepsPerSubtask,
  });
  const notices = noticeInputFor(validated, promptTruncated);
  const { subtasks } = validated;
  logInfo(
    cfg.logging,
    logger,
    `decomposition validated on ${deps.rootSessionKey}: ${subtasks.length} surviving subtask(s)` +
      (validated.droppedSubtasks.length || validated.droppedEmptyDescriptions.length
        ? ` (dropped ${validated.droppedSubtasks.length} over cap, ${validated.droppedEmptyDescriptions.length} empty)`
        : ""),
  );

  // Fewer than 2 survivors means this request has a single concern (or the plan
  // collapsed), so there is nothing to orchestrate — hand it back to the ordinary
  // reply path. Since decomposition now runs for EVERY eligible request rather than
  // only ones a gate flagged, this is the common case, and routing a single-concern
  // request belongs to the existing single-hop/fixed-pipeline modes, not here.
  //
  // The decision is made on the post-cleaning count: dropping empty descriptions
  // reduces survivors, so judging the model's raw output alone would let a
  // 1-survivor plan reach the pipeline.
  //
  // Dropping `notices` here is intentional. They describe damage to a PLAN that is
  // now discarded, and the main agent answers the untruncated original request, so
  // reporting them would describe work the user never receives.
  if (subtasks.length < 2) {
    logInfo(
      cfg.logging,
      logger,
      `${subtasks.length} surviving subtask(s) on ${deps.rootSessionKey}; passing through to the ordinary reply path`,
    );
    return null;
  }

  // Fire-and-forget: a notice that is slow or fails must not delay or abort the
  // pipeline. `sendChannelNotice` already swallows its own errors; the guards here
  // only cover an injected implementation that rejects or throws synchronously.
  const fireNotice = (text: string): void => {
    try {
      void deps.notify?.(text).catch(() => false);
    } catch {
      /* same rule: notices never break the pipeline */
    }
  };

  const gate = await runConfirmationGate(deps, { subtasks, originalPrompt, fireNotice });
  if (gate.cancelled) {
    return CANCELLED_REPLY + buildMandatoryNotices(notices, cfg);
  }
  // The plan actually confirmed, which after an adjustment is NOT the one this
  // function decomposed — everything downstream must use it, not `subtasks`.
  const { subtasks: finalSubtasks, agentIdOf } = gate;

  // Sent only once execution is actually committed: announcing a long wait before
  // the operator has confirmed (or while they are still adjusting) would describe
  // work that may never start.
  //
  // Awaited rather than fired, because its result decides `interimNoticeDelivered`
  // — when the out-of-band channel is unavailable, summarize falls back to stating
  // the wait in the final reply, exactly as before this notifier existed.
  let interimNoticeDelivered = false;
  try {
    interimNoticeDelivered = (await deps.notify?.("预计需要较长时间处理，请稍候")) ?? false;
  } catch {
    /* an undeliverable notice counts as undelivered, not as an error */
  }

  const { results } = await runPipeline(
    {
      ...deps,
      reportProgress: (done, total, layerResults) => {
        fireNotice(formatLayerProgressNotice(done, total, layerResults));
        emitLayerProgressEvent(
          deps.emitEvent,
          { rootSessionKey: deps.rootSessionKey, layer: done, totalLayers: total, layerResults },
          logger,
        );
      },
    },
    finalSubtasks,
    agentIdOf,
  );

  // Announce the summarizing step BEFORE starting it. This is the last stage and it
  // is slow — measured at 136s (17% of a 819s request) — while the card already shows
  // every subtask finished. Without this the operator stares at a "looks done but no
  // answer" view for over two minutes.
  //
  // Both surfaces, because they reach different audiences: the card event only helps
  // the Control UI, and `fireNotice` is the only thing a Feishu-style channel sees.
  emitSummarizingEvent(
    deps.emitEvent,
    {
      rootSessionKey: deps.rootSessionKey,
      okCount: results.filter((r) => r.status === "ok").length,
      totalCount: results.length,
    },
    logger,
  );
  fireNotice(formatSummarizingNotice(results));

  return await summarize(
    cfg,
    {
      ...notices,
      originalPrompt,
      results,
      allSubtasks: finalSubtasks,
      interimNoticeDelivered,
    },
    deps.subagent,
    deps.rootSessionKey,
    logger,
  );
}

type GateResult =
  | { cancelled: true }
  | { cancelled: false; subtasks: SubtaskPlan[]; agentIdOf: Map<number, string> };

/**
 * Routing + dependency layering for one candidate plan.
 *
 * `agentIdOf` is absent in the layering-only view published before routing
 * completes (see `layeringViewFor`).
 */
type PlanView = {
  agentIdOf?: Map<number, string>;
  layerOf: Map<number, number>;
  totalLayers: number;
};

/** A plan view whose routing has resolved, which is what the pipeline needs. */
type RoutedPlanView = PlanView & { agentIdOf: Map<number, string> };

/**
 * Dependency layering only — pure graph work over `needsPriorResults`, no model
 * calls, so it returns immediately.
 *
 * Split out from routing so the card can show the full plan structure while the
 * classifier is still running: that call costs tens of seconds, and it is the only
 * reason the card used to appear ~50s after decomposition finished.
 */
function layeringViewFor(subtasks: SubtaskPlan[]): PlanView {
  const { layers } = layerByDependency(subtasks);
  const layerOf = new Map<number, number>();
  layers.forEach((layer, i) => {
    for (const s of layer) layerOf.set(s.id, i + 1);
  });
  return { layerOf, totalLayers: layers.length };
}

/**
 * Resolve routing and dependency layering for `subtasks`.
 *
 * Routing runs real classifier model calls, so this is computed once per candidate
 * plan and the result is handed to `runPipeline` rather than recomputed there.
 */
async function planViewFor(
  deps: HandleRequestDeps,
  subtasks: SubtaskPlan[],
): Promise<RoutedPlanView> {
  const agentIdOf = await resolveAgentsFor(deps, subtasks);
  return { ...layeringViewFor(subtasks), agentIdOf };
}

/**
 * Broadcast a plan to the Control UI card.
 *
 * Passing `approvalId` is what puts the card into its awaiting-confirmation state.
 * Emitting without one serves two other purposes:
 * - telling the card the gate has CLOSED — nothing else clears the controls until
 *   the first layer finishes, which can be minutes later, and a stale confirm
 *   button produces an "unknown or already-answered confirmation" error on click;
 * - publishing the pre-routing view, where `view.agentIdOf` is absent and the card
 *   shows routing as pending.
 */
function emitPlan(
  deps: HandleRequestDeps,
  subtasks: SubtaskPlan[],
  view: PlanView,
  approvalId?: string,
): void {
  emitPrdEvent(
    deps.emitEvent,
    {
      rootSessionKey: deps.rootSessionKey,
      subtasks,
      agentIdOf: view.agentIdOf,
      defaultAgentId: deps.cfg.defaultAgentId,
      layerOf: view.layerOf,
      totalLayers: view.totalLayers,
      approvalId: approvalId ?? null,
      awaitingConfirmation: approvalId !== undefined,
    },
    deps.logger,
  );
}

/**
 * Publish a plan to both surfaces: the chat text notice and the Control UI card.
 *
 * Used for every plan the operator is being shown for the first time — including a
 * plan revised on the last allowed round, so the card never shows one plan while a
 * different one executes. Re-publishing an UNCHANGED plan goes through `emitPlan`
 * instead, to avoid sending the same PRD text to chat twice.
 */
function publishPlan(
  deps: HandleRequestDeps,
  subtasks: SubtaskPlan[],
  // Routed, not PlanView: the chat notice names the agent per subtask, so this
  // surface cannot render the pre-routing view.
  view: RoutedPlanView,
  fireNotice: (text: string) => void,
  approvalId?: string,
): void {
  fireNotice(formatPrdNotice(subtasks, view.agentIdOf, deps.cfg.defaultAgentId));
  emitPlan(deps, subtasks, view, approvalId);
}

/**
 * Resolve routing, publish the PRD, and — when the confirmation gate is enabled —
 * wait for the operator to confirm, cancel, or ask for changes.
 *
 * On "adjust" the plan is re-decomposed with the operator's wording and the loop
 * repeats. The round cap is what makes this terminate: without it an operator who
 * keeps adjusting would hold the turn open indefinitely.
 */
async function runConfirmationGate(
  deps: HandleRequestDeps,
  params: {
    subtasks: SubtaskPlan[];
    originalPrompt: string;
    fireNotice: (text: string) => void;
  },
): Promise<GateResult> {
  const { cfg, logger } = deps;
  const { originalPrompt, fireNotice } = params;
  const confirmation = cfg.prdConfirmation;

  let subtasks = params.subtasks;

  // `<=` so maxAdjustRounds:0 still runs one gate — it caps ADJUSTMENTS, not the
  // confirmation itself.
  for (let round = 0; round <= confirmation.maxAdjustRounds; round++) {
    // First of two broadcasts: the card renders titles, criteria, dependencies and
    // layers immediately, with routing shown as pending. Without this the card only
    // appeared once the classifier finished — measured at ~50s after decomposition.
    // Card-only (no chat notice), so the PRD text is not sent to chat twice.
    emitPlan(deps, subtasks, layeringViewFor(subtasks));

    // Resolved BEFORE the pending entry is created, so the timeout clock does not
    // start ticking during the classifier round-trip.
    const view = await planViewFor(deps, subtasks);
    const settled: GateResult = { cancelled: false, subtasks, agentIdOf: view.agentIdOf };

    if (!confirmation.enabled) {
      publishPlan(deps, subtasks, view, fireNotice);
      return settled;
    }

    // Registered before publishing, so an answer arriving the instant the card
    // renders can never find the id missing.
    const pending = createPendingApproval(deps.rootSessionKey, confirmation.timeoutMs);
    publishPlan(deps, subtasks, view, fireNotice, pending.approvalId);
    logInfo(
      cfg.logging,
      logger,
      `awaiting PRD confirmation on ${deps.rootSessionKey} (round ${round + 1}/${confirmation.maxAdjustRounds + 1})`,
    );

    const outcome = await pending.promise;

    // Whatever the answer, the gate is now closed — tell the card immediately so the
    // controls disappear. Without this the confirm button stays live and clickable
    // for as long as the first layer takes, and clicking it fails with "unknown or
    // already-answered confirmation".
    const closeGate = () => emitPlan(deps, subtasks, view);

    // null means the timer fired, deliberately distinct from a user "cancel" so
    // the configured policy decides rather than being guessed.
    if (outcome === null) {
      logInfo(
        cfg.logging,
        logger,
        `PRD confirmation timed out on ${deps.rootSessionKey}; onTimeout=${confirmation.onTimeout}`,
      );
      closeGate();
      return confirmation.onTimeout === "cancel" ? { cancelled: true } : settled;
    }
    if (outcome.decision === "cancel") {
      logInfo(cfg.logging, logger, `PRD cancelled by operator on ${deps.rootSessionKey}`);
      closeGate();
      return { cancelled: true };
    }
    if (outcome.decision === "confirm") {
      logInfo(cfg.logging, logger, `PRD confirmed by operator on ${deps.rootSessionKey}`);
      closeGate();
      return settled;
    }

    // "adjust" — re-decompose with the operator's wording. An empty adjustment or a
    // failed re-decomposition runs the plan already on screen rather than
    // discarding the work: the operator has seen it and it is known-valid.
    const adjustment = outcome.adjustment?.trim();
    if (!adjustment) {
      closeGate();
      return settled;
    }
    // Announced BEFORE decomposeTask, which takes ~62s. The RPC carrying this answer
    // already returned, so without this the card would sit on the superseded plan —
    // controls still live — for the whole minute. This event is also what settles the
    // gate on the adjust path (the reducer clears approvalId), so no closeGate() here:
    // it must not broadcast the OLD plan as non-awaiting, since the next iteration
    // replaces the card wholesale with the revised one.
    emitRedecomposingEvent(
      deps.emitEvent,
      { rootSessionKey: deps.rootSessionKey, adjustment },
      logger,
    );
    logInfo(cfg.logging, logger, `re-decomposing on ${deps.rootSessionKey} per operator adjustment`);
    let revised: ValidatedPlan;
    try {
      const rawPlan = await decomposeTask(
        cfg,
        originalPrompt,
        deps.subagent,
        deps.rootSessionKey,
        adjustment,
      );
      revised = validateDecomposePlan(rawPlan, {
        maxSubtasks: cfg.maxSubtasks,
        maxDescriptionChars: cfg.maxDescriptionChars,
        maxDepsPerSubtask: cfg.maxDepsPerSubtask,
      });
    } catch (e) {
      logger?.warn(
        `[dragon-task-orchestrator] re-decomposition failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      closeGate();
      return settled;
    }
    // A collapsed revision (< 2 survivors) cannot be orchestrated, and silently
    // running the superseded plan would contradict what the operator just asked
    // for, so it is reported as a cancellation instead.
    if (revised.subtasks.length < 2) {
      logInfo(
        cfg.logging,
        logger,
        `adjusted plan on ${deps.rootSessionKey} left ${revised.subtasks.length} subtask(s); cancelling`,
      );
      closeGate();
      return { cancelled: true };
    }
    subtasks = revised.subtasks;
    // No closeGate() here: the next iteration immediately publishes the revised plan
    // with a fresh approvalId, which replaces the card state wholesale.
  }

  // Rounds exhausted on an "adjust": run the revised plan rather than dropping the
  // turn, and publish it so the card matches what actually executes.
  logInfo(
    cfg.logging,
    logger,
    `adjust rounds exhausted on ${deps.rootSessionKey}; executing the latest plan`,
  );
  // This plan came from the last round's adjustment, so it has never been shown;
  // it needs the same pre-routing broadcast as one published inside the loop.
  emitPlan(deps, subtasks, layeringViewFor(subtasks));
  const view = await planViewFor(deps, subtasks);
  publishPlan(deps, subtasks, view, fireNotice);
  return { cancelled: false, subtasks, agentIdOf: view.agentIdOf };
}
