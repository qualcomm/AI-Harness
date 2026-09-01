/**
 * Dependency layering and layered execution.
 *
 * Concurrency boundary: every subtask within a layer runs in parallel, regardless
 * of which agent it was routed to. Dependencies are the ONLY thing that sequences
 * work — that is what a layer means.
 *
 * This used to be narrower: same-agent subtasks ran strictly serially, because they
 * shared one child session and the host queues per session (`resolveSessionLane`),
 * making concurrent writes to it unsafe. Child and verifier sessions are now derived
 * per subtask (see session-key.ts), so nothing is shared and nothing needs
 * serializing. The old behaviour made speedup depend on how routing happened to
 * distribute subtasks: a layer whose two subtasks both classified as `research` took
 * 5m45s where ~3m of concurrent work was available.
 */

import {
  describeArtifactDirForWorker,
  describeArtifactsForConsumer,
  detectUnresolvedFileClaims,
  ensureArtifactDir,
  listArtifacts,
} from "./artifacts.js";
import { DelegationFailedError, runDelegatedTask } from "./delegate.js";
import { clearDelegationMeta, setDelegationMeta } from "./delegation-meta.js";
import { logInfo } from "./log.js";
import { formatPriorResult, splitProcessingNotices } from "./notices.js";
import { emitSubtaskStatusEvent, type EmitEvent } from "./progress-event.js";
import { resolveAgentForSubtask } from "./resolve-agent.js";
import { childSessionKeyFor } from "./session-key.js";
import { runVerification } from "./verify.js";
import type { Logger, SubagentRuntime } from "./runtime-contract.js";
import type {
  DragonTaskOrchestratorConfig,
  SubtaskArtifact,
  SubtaskPlan,
  SubtaskResult,
} from "./types.js";

/** Plain error text for reporting. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Group subtasks into dependency layers. Subtasks in a layer do not depend on
 * each other and may run concurrently.
 *
 * Returns `unschedulable` rather than breaking silently. In theory the validation
 * step guarantees no unsatisfiable dependency reaches here; if some future change
 * bypasses that, the tasks must surface as errors instead of vanishing — the
 * silent-drop failure this design exists to prevent.
 */
export function layerByDependency(subtasks: SubtaskPlan[]): {
  layers: SubtaskPlan[][];
  unschedulable: SubtaskPlan[];
} {
  const done = new Set<number>();
  const remaining = [...subtasks];
  const layers: SubtaskPlan[][] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((s) =>
      (s.needsPriorResults ?? []).every((dep) => done.has(dep)),
    );
    if (ready.length === 0) {
      return { layers, unschedulable: remaining };
    }
    layers.push(ready);
    for (const s of ready) {
      done.add(s.id);
      remaining.splice(remaining.indexOf(s), 1);
    }
  }
  return { layers, unschedulable: [] };
}

/**
 * Build the prior-context block for a subtask from its dependencies' results.
 *
 * Each block carries the dependency's own child session key, so a consumer that needs
 * more than the summarized text can read the full transcript with `sessions_history`.
 * The keys are a SHA-256 of `root:agentId:subtask:N` (see session-key.ts) — derivable
 * here, unguessable from inside the agent, so passing it is the only way the consumer
 * can ever reach it.
 *
 * Whether that read is permitted is a HOST decision, not ours: it needs
 * `tools.sessions.visibility: "all"` and `tools.agentToAgent.enabled`. When either is off
 * the tool call is refused with an explanatory error and the worker still has the
 * summarized text, so advertising the key is safe either way.
 *
 * Artifacts are listed ahead of the transcript pointer because they are the cheaper and
 * more reliable route: an absolute path read with `read` needs no host capability at all,
 * while `sessions_history` needs two and returns a whole transcript to be waded through.
 * The list comes from scanning the dependency's directory, so every path offered here is
 * known to exist at the moment it is offered.
 */
function buildPriorContext(
  subtask: SubtaskPlan,
  results: SubtaskResult[],
  maxContextChars: number,
  rootSessionKey: string,
): string {
  return (subtask.needsPriorResults ?? [])
    .map((i) => results.find((r) => r.id === i))
    .filter((r): r is SubtaskResult => Boolean(r))
    .map((r) => {
      const body = formatPriorResult(r, maxContextChars);
      // Only for results that actually ran: a failed subtask's transcript holds the
      // failure, not content worth fetching, and pointing at it invites a pointless read.
      if (r.status !== "ok") return body;
      const artifactBlock = describeArtifactsForConsumer(r.id, r.artifacts ?? []);
      const depSessionKey = childSessionKeyFor(rootSessionKey, r.agentId, r.id);
      return [
        body,
        ...(artifactBlock ? [artifactBlock] : []),
        `（如需子任务${r.id}的完整过程与工具结果，可用 sessions_history 读取 sessionKey=${depSessionKey}；若该工具被拒绝，就以上面的正文为准）`,
      ].join("\n");
    })
    .join("\n\n");
}

/** Ids that at least one other subtask declares a dependency on. */
export function idsWithDownstreamConsumers(subtasks: SubtaskPlan[]): Set<number> {
  const consumed = new Set<number>();
  for (const s of subtasks) {
    for (const dep of s.needsPriorResults ?? []) {
      consumed.add(dep);
    }
  }
  return consumed;
}

/**
 * Tell a worker that its final message is the hand-off, and how to get around the budget.
 *
 * Only added for subtasks something actually depends on: a leaf subtask's output goes to
 * the summarizer, which has its own budget, so the advice would be noise there.
 *
 * WHY THIS IS NEEDED
 * Only the worker's final assistant message crosses to a downstream subtask — tool
 * results and intermediate turns do not (see delegate.ts `extractAssistantText`, which
 * scans a 5-message window and keeps only `type: "text"` parts). Workers have no way to
 * know that. In the 2026-08-27 run one of them ended with a mid-progress note, so its 26
 * tool calls reached its consumer as nothing at all.
 *
 * The file escape hatch is what makes the budget survivable rather than just declared.
 * Passing a path costs tens of characters and lets the consumer read on demand instead of
 * paying for everything up front.
 *
 * Phrased as guidance, not a hard requirement. A worker without filesystem tools, or one
 * whose output already fits, must not be pushed into failing.
 *
 * NOTE ON THE FILE ROUTE: it used to say "写入工作区文件" without naming a path, on the
 * theory that a bare filename was safer than a guessed one. It was not — it was
 * unusable. Relative paths resolve against each agent's OWN workspace subdirectory, so a
 * bare filename written by `research` lands in `workspace/research/` while a consumer
 * resolves it under `workspace/writing/`. Measured in the 2026-08-31 00:48 run: ENOENT on
 * `...\workspace\writing\writing\hexicorridor_tourism.md`, 13 exec calls spent hunting
 * for the file, then a silent rewrite from the truncated summary — and the subtask still
 * reported ok. An earlier note here claimed the route was "already proven to work across
 * agents"; that observation was a VERIFIER reading a file, and a verifier is handed the
 * worker's own session, not a sibling agent's workspace. It never held between peers.
 *
 * `artifactDir` fixes it by naming a real directory the plugin creates, addressed
 * absolutely so it resolves from whatever cwd the agent happens to have (see
 * artifacts.ts). Omitted when the artifact channel is unavailable, in which case the file
 * route is not offered at all — better to have workers keep everything in the reply than
 * to hand out a handle that cannot be dereferenced.
 *
 * `handoffContract` turns the general advice into a specific checklist. It is the only
 * part of this that survives a downstream summarize or truncation reliably, because the
 * items name individual facts ("每段公里数") instead of describing a shape. The same list
 * goes to the verifier (see verify.ts), which is what makes it enforced rather than
 * merely requested — a worker is free to ignore prose guidance.
 */
function buildHandoffNotice(
  maxContextChars: number,
  handoffContract?: string[],
  artifactDir?: string | null,
): string {
  const lines = [
    "【关于你的输出如何被使用】",
    `后续子任务只能看到你这次回复的最终正文，看不到你的工具调用结果和中间步骤，且正文超过 ${maxContextChars} 字符的部分会被截断。`,
    "因此请把后续子任务需要的事实、数据、结论直接写在最终正文里，不要只描述你做了什么。",
  ];
  if (artifactDir) {
    lines.push(describeArtifactDirForWorker(artifactDir));
  }
  if (handoffContract && handoffContract.length > 0) {
    lines.push(
      "",
      "后续子任务明确需要以下内容，请确保每一项都出现在最终正文里（缺项会导致校验不通过）：",
      ...handoffContract.map((item) => `- ${item}`),
    );
  }
  return lines.join("\n");
}

export type RunSubtaskDeps = {
  subagent: SubagentRuntime | undefined;
  cfg: DragonTaskOrchestratorConfig;
  rootSessionKey: string;
  logger?: Logger;
};

/**
 * Execute one subtask via delegation.
 *
 * Writes delegation metadata keyed by the derived child session key just before
 * the call, so the receiving side can read hopCount / rootSessionKey /
 * hintedAgentId without any of it passing through model-visible text.
 *
 * `hopCount: 0` and `rootSessionKey` are set explicitly rather than left to a
 * receiver-side default: defaulting would let the receiver treat the child
 * session it was handed as the chain root, and any later forward would then
 * re-derive from that, producing the "hash of a hash" divergence.
 *
 * Returns `timedOut` alongside the result so the caller can degrade the rest of
 * the group. This is reported structurally rather than by matching the error
 * string, which is sanitized and localized and would be a fragile signal.
 */
export async function runSubtask(
  deps: RunSubtaskDeps,
  subtask: SubtaskPlan,
  agentId: string,
  results: SubtaskResult[],
  hasDownstreamConsumers = false,
): Promise<{ result: SubtaskResult; timedOut: boolean }> {
  const { subagent, cfg, rootSessionKey, logger } = deps;
  const priorContext = buildPriorContext(subtask, results, cfg.maxContextChars, rootSessionKey);
  // Created only for subtasks something depends on: a leaf's output goes to the
  // summarizer, which reads text and would never dereference a path, so an empty
  // directory there would be pure litter.
  const artifactDir = hasDownstreamConsumers
    ? ensureArtifactDir(rootSessionKey, subtask.id, logger)
    : null;
  // Hand-off guidance goes LAST, after the description. Two reasons: it is a constraint
  // on the output rather than part of the task, and the tail is the protected position
  // under `truncateKeepTail` (see sanitize.ts) if anything upstream ever caps this.
  const handoff = hasDownstreamConsumers
    ? `\n\n---\n\n${buildHandoffNotice(cfg.maxContextChars, subtask.handoffContract, artifactDir)}`
    : "";
  const initialMessage = priorContext
    ? `${priorContext}\n\n---\n\n${subtask.description}${handoff}`
    : `${subtask.description}${handoff}`;

  // Per-subtask session: same-agent subtasks must not share one, or the host's
  // per-session queue serializes them (see session-key.ts).
  const childSessionKey = childSessionKeyFor(rootSessionKey, agentId, subtask.id);
  setDelegationMeta(childSessionKey, {
    hopCount: 0,
    rootSessionKey,
    hintedAgentId: agentId,
    subtaskId: subtask.id,
    role: "work",
  });

  // A hand-off contract also warrants verification, not just acceptance criteria: the
  // contract is only enforced by the verifier (see verify.ts), so gating on criteria alone
  // would leave a subtask that declares a contract but no criteria unenforced — the case
  // where the worker is most free to drop items.
  //
  // Requires `hasDownstreamConsumers`, matching the condition that decided whether the
  // worker was told about the contract. A leaf is not verified for a contract it was never
  // shown, and a leaf's contract has no consumer to serve in the first place.
  const enforceContract =
    hasDownstreamConsumers && (subtask.handoffContract ?? []).some((i) => i.trim().length > 0);
  const verifierAgentId =
    subtask.acceptanceCriteria?.trim() || enforceContract ? cfg.defaultAgentId : undefined;

  /**
   * What the worker actually left behind, plus a notice when its reply names files that
   * are not there.
   *
   * The notice is the point of step 2. A dead handle used to cost the consumer a hunt and
   * then a silent rewrite while the subtask reported a clean ok; now it is stated in the
   * result. It is a NOTICE rather than an error on purpose — the reply text may well be
   * complete on its own, and failing a subtask over a stray filename in prose would be a
   * worse trade than reporting it.
   */
  const collectArtifacts = (
    text: string,
  ): { artifacts: SubtaskArtifact[]; notices: string[] } => {
    if (!artifactDir) return { artifacts: [], notices: [] };
    const artifacts = listArtifacts(artifactDir);
    const unresolved = detectUnresolvedFileClaims(text, artifacts);
    if (unresolved.length === 0) return { artifacts, notices: [] };
    logger?.warn(
      `[dragon-task-orchestrator] subtask ${subtask.id} on ${agentId} names ` +
        `${unresolved.length} file(s) with no matching artifact: ${unresolved.join(", ")}` +
        `${artifacts.length === 0 ? " (artifact dir is empty)" : ""}`,
    );
    return {
      artifacts,
      notices: [
        `子任务${subtask.id}的回复提到了 ${unresolved.join("、")}，但共享产物目录里没有对应文件，下游无法读取；请以正文内容为准`,
      ],
    };
  };

  try {
    let message = initialMessage;
    let lastFeedback = "";
    for (let attempt = 0; ; attempt++) {
      let raw: { text: string };
      try {
        raw = await runDelegatedTask({
          subagent,
          childSessionKey,
          message,
          timeoutMs: cfg.subtaskTimeoutMs,
        });
      } catch (e) {
        // A failed execution has nothing to verify — return the error directly,
        // same as before verify was introduced.
        return {
          result: {
            id: subtask.id,
            agentId,
            text: "",
            status: "error",
            error: errorMessage(e),
          },
          timedOut: isTimeout(e),
        };
      }
      // Separate orchestration commentary from real output so it cannot leak into
      // downstream prior-context as if it were task content.
      const { text, notices } = splitProcessingNotices(raw.text);

      const collected = collectArtifacts(text);

      if (!verifierAgentId) {
        // No acceptance criteria declared for this subtask — unchanged pre-verify behavior.
        return {
          result: {
            id: subtask.id,
            agentId,
            text,
            status: "ok",
            processingNotices: [...notices, ...collected.notices],
            artifacts: collected.artifacts,
          },
          timedOut: false,
        };
      }

      const outcome = await runVerification(
        { subagent, cfg, rootSessionKey, logger },
        subtask,
        text,
        verifierAgentId,
        // Same flag that decided whether the worker was told about the contract, so the
        // two can never disagree about whether it applies.
        hasDownstreamConsumers,
        // Ground truth about the file route, so the verifier judges claims against what
        // exists rather than taking the worker's word (see verify.ts). Null — not an empty
        // list — when no directory was offered, which means "not applicable" rather than
        // "wrote nothing".
        artifactDir ? collected.artifacts : null,
      );
      if (outcome.passed) {
        return {
          result: {
            id: subtask.id,
            agentId,
            text,
            status: "ok",
            processingNotices: [
              ...notices,
              ...collected.notices,
              `经过 ${attempt + 1} 次校验通过`,
            ],
            verifyAttempts: attempt + 1,
            artifacts: collected.artifacts,
          },
          timedOut: false,
        };
      }

      lastFeedback = outcome.feedback;
      logInfo(
        cfg.logging,
        logger,
        `subtask ${subtask.id} on ${agentId}: verify failed (attempt ${attempt + 1}): ${lastFeedback}`,
      );
      if (attempt >= cfg.maxVerifyRetries) {
        return {
          result: {
            id: subtask.id,
            agentId,
            text: "",
            status: "error",
            error: `经 Verifier 校验 ${attempt + 1} 次未通过：${lastFeedback}`,
          },
          timedOut: false,
        };
      }

      // Retry against the SAME worker child session, so the worker can see its own
      // prior output and the verifier's feedback in its own session history.
      message = `Verifier 校验未通过，反馈：${lastFeedback}\n请根据反馈修正你上一次的结果。`;
    }
  } finally {
    clearDelegationMeta(childSessionKey);
  }
}

/** True when the failure was a delegation timeout (drives group degradation). */
function isTimeout(e: unknown): boolean {
  return e instanceof DelegationFailedError && e.status === "timeout";
}

export type PipelineDeps = RunSubtaskDeps & {
  knownAgentIds: Set<string>;
  agentDescriptions: Map<string, string>;
  orchestratorAgentId: string;
  /** Called after each layer finishes, with the results produced by that layer only. */
  reportProgress?: (done: number, total: number, layerResults: SubtaskResult[]) => void;
  /**
   * Gateway broadcast, used here only for the per-subtask running signal (see
   * emitSubtaskStatusEvent). Layer results travel via `reportProgress`.
   */
  emitEvent?: EmitEvent;
};

/**
 * Resolve the target agent for every subtask, concurrently (each match is
 * independent of the others).
 *
 * Split out of `runPipeline` because the confirmation gate has to show "who got
 * what" BEFORE execution starts, and these are real classifier model calls — the
 * caller resolves once, shows the plan, and passes the result back into
 * `runPipeline` rather than paying for them twice.
 */
export async function resolveAgentsFor(
  deps: Pick<
    PipelineDeps,
    | "cfg"
    | "knownAgentIds"
    | "agentDescriptions"
    | "orchestratorAgentId"
    | "subagent"
    | "rootSessionKey"
  >,
  subtasks: SubtaskPlan[],
): Promise<Map<number, string>> {
  const { cfg, knownAgentIds, agentDescriptions, orchestratorAgentId, subagent, rootSessionKey } =
    deps;
  const resolved = await Promise.all(
    subtasks.map(
      async (s) =>
        [
          s.id,
          await resolveAgentForSubtask(
            cfg,
            s,
            knownAgentIds,
            orchestratorAgentId,
            agentDescriptions,
            subagent,
            rootSessionKey,
          ),
        ] as const,
    ),
  );
  return new Map<number, string>(resolved);
}

/**
 * Execute a validated subtask list against an already-resolved routing map.
 *
 * Timeout handling (see design.md R1): `waitForRun` returning "timeout" does not
 * prove the underlying run stopped. Since a group shares one child session,
 * immediately issuing the next call on that same key could collide with a run
 * still in flight — the very hazard in-group serialization exists to avoid. So a
 * timeout marks the REST of that group as failed and skipped rather than
 * continuing. One timeout costs the rest of its group; that is preferable to
 * corrupting session history, and the skipped tasks are reported honestly.
 */
export async function runPipeline(
  deps: PipelineDeps,
  subtasks: SubtaskPlan[],
  agentIdOf: Map<number, string>,
): Promise<{ results: SubtaskResult[] }> {
  const { cfg, reportProgress, logger, subagent, rootSessionKey } = deps;

  const { layers, unschedulable } = layerByDependency(subtasks);
  logInfo(
    cfg.logging,
    logger,
    `pipeline on ${rootSessionKey}: ${subtasks.length} subtask(s) resolved to [${[...agentIdOf]
      .map(([id, agentId]) => `${id}:${agentId}`)
      .join(", ")}], ${layers.length} layer(s)`,
  );
  if (unschedulable.length > 0) {
    logger?.warn(
      `[dragon-task-orchestrator] unschedulable subtasks marked as errors: ${unschedulable
        .map((s) => s.id)
        .join(", ")}`,
    );
  }

  const results: SubtaskResult[] = [];
  // Computed once from the whole plan, not per layer: a subtask in layer 1 can be
  // depended on by layer 3, so "does anything consume me" is not a layer-local question.
  const consumedIds = idsWithDownstreamConsumers(subtasks);

  for (const [layerIndex, layer] of layers.entries()) {
    logInfo(
      cfg.logging,
      logger,
      `layer ${layerIndex + 1}/${layers.length} on ${rootSessionKey}: ${layer.length} subtask(s) in parallel`,
    );

    // Every subtask in a layer runs concurrently, including ones routed to the SAME
    // agent. That used to be forbidden: same-agent subtasks shared one child session
    // and the host queues per session (`resolveSessionLane`), so they were serialized
    // to avoid concurrent writes to it. Child sessions are now per-subtask (see
    // session-key.ts), so the shared session — and with it the reason to serialize —
    // is gone. A layer with two `research` subtasks measured 5m45s serialized where
    // ~3m of concurrent work was available.
    const layerResults = await Promise.all(
      layer.map(async (s) => {
        const agentId = agentIdOf.get(s.id) ?? cfg.defaultAgentId;
        emitSubtaskStatusEvent(
          deps.emitEvent,
          { rootSessionKey, subtaskId: s.id, agentId, phase: "start" },
          logger,
        );
        const result = await runSubtask(deps, s, agentId, results, consumedIds.has(s.id));
        // Always emitted, including on failure/timeout — otherwise the card would
        // spin forever on a dead subtask.
        emitSubtaskStatusEvent(
          deps.emitEvent,
          { rootSessionKey, subtaskId: s.id, agentId, phase: "end" },
          logger,
        );
        logInfo(
          cfg.logging,
          logger,
          `subtask ${s.id} on ${agentId}: ${result.result.status}${result.timedOut ? " (timeout)" : ""}`,
        );
        return result.result;
      }),
    );
    results.push(...layerResults);

    // Progress reporting is an experience nicety, not a prerequisite — a throwing
    // hook must not abort the pipeline.
    try {
      reportProgress?.(layerIndex + 1, layers.length, layerResults);
    } catch {
      /* feedback hook failure must not block the pipeline */
    }
  }

  // Unschedulable tasks become explicit errors rather than disappearing.
  for (const s of unschedulable) {
    results.push({
      id: s.id,
      agentId: agentIdOf.get(s.id) ?? cfg.defaultAgentId,
      text: "",
      status: "error",
      error: "依赖无法满足，未被调度执行",
    });
  }

  return { results };
}
