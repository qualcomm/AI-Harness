/**
 * Hook wiring for `before_agent_reply`.
 *
 * ORDER IS THE SECURITY PROPERTY. The delegation-marker check must run BEFORE
 * decomposition. If decomposition ran first, a delegated subtask could be split
 * again, cascading without bound — putting the check later is equivalent to not
 * having it at all.
 *
 * Sequence:
 *   1. delegation marker / metadata lookup   <- recursion protection, first
 *   2. truncate the raw prompt               <- before any model sees it
 *   3. decomposeTask
 *   4. handleDecomposedRequest
 *
 * There is deliberately no "does this need splitting" gate ahead of step 3: the
 * decomposer returns a single subtask for a single-concern request, and
 * `handleDecomposedRequest` passes those straight through. A separate gate call
 * had to succeed before decomposition could even be attempted, making it the
 * single most load-bearing model call in the plugin for no added capability.
 */

import { handleDecomposedRequest } from "./orchestrator.js";
import { classifyDomainOnly, decomposeTask } from "./resolve-agent.js";
import { appendProcessingNotices } from "./notices.js";
import { clearDelegationMeta, getDelegationMeta, setDelegationMeta } from "./delegation-meta.js";
import { runDelegatedTask } from "./delegate.js";
import { logInfo } from "./log.js";
import { runFixedPipeline } from "./fixed-pipeline.js";
import { getSessionMode } from "./mission-mode.js";
import { childSessionKeyFor, isClassifierSessionKey, isSubtaskDelegationKey } from "./session-key.js";
import { truncate, truncateKeepTail } from "./sanitize.js";
import type { Logger, SubagentRuntime } from "./runtime-contract.js";
import type { DragonTaskOrchestratorConfig } from "./types.js";

const TRUNCATED_CONTEXT_NOTICE =
  "传递给你的前置参考内容过长已被截短（任务指令本身保持完整），如影响结果请尝试缩短依赖任务的输出";
const HOP_LIMIT_NOTICE = "本次请求经过多次转交后由当前处理方直接完成，结果可能不是最匹配的专业方向";

/** Internal/derived agent runs use a `temp:` session-key prefix (for example the
 * slug generator spawned when a session is archived). Those are housekeeping LLM
 * calls, not user turns, so they must not be classified or decomposed.
 */
function isInternalSession(sessionKey: string): boolean {
  return sessionKey.startsWith("temp:");
}

/**
 * Triggers that represent something other than a person typing a request.
 *
 * The host classifies every run with one of `"cron" | "heartbeat" | "manual" |
 * "memory" | "overflow" | "user"` (EmbeddedRunTrigger) and passes it through as
 * `ctx.trigger`. Only `"user"` and `"manual"` are actual requests; the rest are
 * machinery — heartbeat polls, cron payloads, memory maintenance, overflow
 * recovery — and decomposing them is wrong on three counts: it burns a decomposer
 * call on every poll, it can rewrite a precisely-worded internal prompt (the
 * heartbeat prompt demands an exact `HEARTBEAT_OK` reply), and with the
 * confirmation gate enabled a multi-subtask split would block an unattended
 * background run until it timed out.
 *
 * Checked against a deny list rather than an allow list so an unrecognised or
 * absent trigger still gets normal treatment — the alternative would silently
 * disable the plugin if the host ever renamed `"user"`.
 */
const NON_REQUEST_TRIGGERS = new Set(["heartbeat", "cron", "memory", "overflow"]);

function isNonRequestTrigger(trigger: string | undefined): boolean {
  return trigger !== undefined && NON_REQUEST_TRIGGERS.has(trigger);
}

/** Plain error text for logging. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type HookDeps = {
  cfg: DragonTaskOrchestratorConfig;
  /** Resolve the currently configured agent ids at request time (design D4). */
  getKnownAgentIds: () => Set<string>;
  /** Per-agent description (borrowed from `systemPromptOverride`) fed to the classifier. */
  getAgentDescriptions: () => Map<string, string>;
  getSubagent: () => SubagentRuntime | undefined;
  /**
   * Plain model answer with NO classification and NO delegation decision, for
   * `agentId`.
   *
   * `before_agent_reply` can only pass through or short-circuit with a synthetic
   * reply — there is no host API to "run agentId's real pipeline (persona/tools/
   * system prompt) and hand back the text". Short-circuiting is required here so
   * the mandatory processing notices (truncation, hop-limit) can be appended, so
   * this inherently answers via a bare local-model call rather than the host
   * agent's actual tools. The caller looks up `agentId`'s configured
   * `systemPromptOverride` (from `cfg.agents.list`, the host's own per-agent
   * system prompt config) to approximate that agent's voice; agents with no
   * override get no system prompt.
   *
   * Must never re-enter the `before_agent_reply` top level: doing so after the
   * delegation marker was consumed would re-trigger this same branch and loop
   * forever.
   */
  runLocally: (prompt: string, agentId: string) => Promise<string>;
  /** Look up a stored fixed pipeline by id; absent when it was deleted. */
  getPipeline: (id: string) => import("./pipeline-store.js").Pipeline | undefined;
  /**
   * Best-effort out-of-band notice sender for PRD / progress messages, injected by
   * index.ts (see notify.ts). Omitted in tests and whenever the host offers no
   * usable outbound channel — the final reply remains the only delivery guarantee.
   */
  notify?: (sessionKey: string, agentId: string, text: string) => Promise<boolean>;
  /**
   * Gateway event broadcast, injected by index.ts as `api.emitEvent`. Covers the
   * Control UI, which `notify` cannot reach (see progress-event.ts).
   */
  emitEvent?: (eventType: string, payload: Record<string, unknown>) => void;
  logger?: Logger;
};

export type HookEvent = { cleanedBody?: string };
export type HookContext = {
  sessionKey?: string;
  agentId?: string;
  /** Host's run classification (`EmbeddedRunTrigger`); see isNonRequestTrigger. */
  trigger?: string;
};
export type HookResult = { handled: boolean; reply?: { text: string }; reason?: string } | void;

/**
 * Handle a request that arrived as a subtask delegation.
 *
 * Skips the decomposition decision entirely — that is the recursion protection.
 * Metadata comes from the process-local store; when the lookup misses (different
 * process) we still recognized the marker, so we execute in place and do not
 * forward. Forwarding is lost, protection is not.
 */
async function handleSubtaskDelegation(
  deps: HookDeps,
  params: { sessionKey: string; currentAgentId: string; rawPrompt: string },
): Promise<string> {
  const { cfg, logger } = deps;
  const { sessionKey, currentAgentId, rawPrompt } = params;

  // The received text is `priorContext + "\n\n---\n\n" + description`: the real
  // instruction is at the TAIL. Head-keeping truncation would delete the
  // instruction and leave only reference material.
  const prompt = truncateKeepTail(rawPrompt, cfg.maxPromptChars);
  const promptTruncated = prompt.length < rawPrompt.length;
  const contextNotice = promptTruncated ? [TRUNCATED_CONTEXT_NOTICE] : [];

  const meta = getDelegationMeta(sessionKey);
  if (!meta) {
    // Marker recognized but metadata unavailable — execute in place (fail-safe).
    logger?.warn(
      "[dragon-task-orchestrator] delegation metadata unavailable; executing in place without forwarding",
    );
    return appendProcessingNotices(await deps.runLocally(prompt, currentAgentId), contextNotice);
  }

  // The orchestrator already resolved the correct target using the CLEAN
  // description. Reclassifying here would run on different input (prior context
  // mixed in, then truncated) and could disagree — and would be a model round-trip
  // that buys nothing when the answer is already known.
  if (meta.hintedAgentId === currentAgentId) {
    logInfo(cfg.logging, logger, `subtask executed in place on ${currentAgentId} (hop ${meta.hopCount})`);
    return appendProcessingNotices(await deps.runLocally(prompt, currentAgentId), contextNotice);
  }

  if (meta.hopCount >= cfg.maxDelegationHops) {
    // Hop limit reached: stop forwarding and answer here. Told to the user, since
    // this is not the best-matched specialization.
    logInfo(
      cfg.logging,
      logger,
      `hop limit reached on ${currentAgentId} (hop ${meta.hopCount} >= ${cfg.maxDelegationHops}); answering in place`,
    );
    return appendProcessingNotices(await deps.runLocally(prompt, currentAgentId), [
      HOP_LIMIT_NOTICE,
      ...contextNotice,
    ]);
  }

  const knownAgentIds = deps.getKnownAgentIds();
  let targetAgentId: string;
  try {
    const domain = await classifyDomainOnly(
      cfg,
      prompt,
      [...knownAgentIds],
      deps.getAgentDescriptions(),
      deps.getSubagent(),
      meta.rootSessionKey,
    );
    targetAgentId = knownAgentIds.has(domain) ? domain : cfg.defaultAgentId;
  } catch {
    targetAgentId = cfg.defaultAgentId;
  }

  // Target is this agent: execute directly. Not a hand-off, so no hop is spent.
  if (targetAgentId === currentAgentId) {
    return appendProcessingNotices(await deps.runLocally(prompt, currentAgentId), contextNotice);
  }

  // Forward one hop, derived from the CHAIN ROOT rather than this session, so the
  // child-session set stays converged.
  logInfo(
    cfg.logging,
    logger,
    `re-routing subtask from ${currentAgentId} to ${targetAgentId} (hop ${meta.hopCount + 1})`,
  );
  const nextSessionKey = childSessionKeyFor(meta.rootSessionKey, targetAgentId);
  setDelegationMeta(nextSessionKey, {
    hopCount: meta.hopCount + 1,
    rootSessionKey: meta.rootSessionKey,
    hintedAgentId: targetAgentId,
    // Carried across the hop so a re-routed subtask's tool activity still reports
    // against the same card row; dropping them would silently blank the display
    // for exactly the subtasks that took the most work to place.
    ...(meta.subtaskId !== undefined && { subtaskId: meta.subtaskId }),
    ...(meta.role && { role: meta.role }),
  });
  try {
    const { text } = await runDelegatedTask({
      subagent: deps.getSubagent(),
      childSessionKey: nextSessionKey,
      message: prompt,
      timeoutMs: cfg.subtaskTimeoutMs,
    });
    return appendProcessingNotices(text, contextNotice);
  } catch (e) {
    // A failed forward degrades to answering here rather than propagating and
    // breaking the whole chain.
    logger?.warn(`[dragon-task-orchestrator] forward failed: ${errorMessage(e)}`);
    return appendProcessingNotices(await deps.runLocally(prompt, currentAgentId), contextNotice);
  } finally {
    clearDelegationMeta(nextSessionKey);
  }
}

/** Core hook body, exported for tests. Returns reply text, or null to pass through. */
export async function runBeforeAgentReply(
  deps: HookDeps,
  event: HookEvent,
  ctx: HookContext,
): Promise<string | null> {
  const { cfg, logger } = deps;
  const sessionKey = ctx.sessionKey ?? "";
  const rawPrompt = typeof event.cleanedBody === "string" ? event.cleanedBody : "";
  if (!rawPrompt.trim()) return null;
  if (isInternalSession(sessionKey)) return null;
  // Background machinery (heartbeat polls, cron, memory upkeep) is not a request to
  // decompose. Checked before anything else so these runs cost nothing at all.
  if (isNonRequestTrigger(ctx.trigger)) return null;
  // The orchestrator's own one-shot sessions (decompose/classify/summarize — see
  // session-key.ts) must never be decomposed themselves; that would recurse into
  // another decompose call on the orchestrator's own output.
  if (isClassifierSessionKey(sessionKey)) return null;

  const currentAgentId = ctx.agentId ?? cfg.defaultAgentId;

  // STEP 1 — recursion protection, ahead of any decomposition.
  if (isSubtaskDelegationKey(sessionKey)) {
    return await handleSubtaskDelegation(deps, { sessionKey, currentAgentId, rawPrompt });
  }

  // STEP 1.5 — mode dispatch, AFTER delegation handling on purpose.
  //
  // Subtask delegations above are handled unconditionally so that changing the mode
  // mid-run cannot strand work already in flight: those hops belong to work the
  // operator already authorised. From here on the turn is a NEW request, and `off`
  // means this plugin does nothing at all — no decomposer call, no classifier calls,
  // no card.
  const mode = getSessionMode(sessionKey);
  if (mode.kind === "off") return null;

  if (mode.kind === "pipeline") {
    const pipeline = deps.getPipeline(mode.pipelineId);
    if (!pipeline) {
      // The selected pipeline is gone. Deliberately NOT falling back to dynamic
      // decomposition: the operator chose this specific pipeline, and substituting a
      // different orchestration strategy is not something they agreed to. Pass the turn
      // through to the ordinary reply path instead.
      logger?.warn(
        `[dragon-task-orchestrator] pipeline ${mode.pipelineId} not found; passing the turn through`,
      );
      return null;
    }
    // Truncated here for the same reason as STEP 2 below — this is the only place the
    // prompt is bounded, so the limit cannot be bypassed by reordering downstream calls.
    return await runFixedPipeline(
      {
        subagent: deps.getSubagent(),
        cfg,
        rootSessionKey: sessionKey,
        knownAgentIds: deps.getKnownAgentIds(),
        emitEvent: deps.emitEvent,
        logger,
      },
      { pipeline, originalPrompt: truncate(rawPrompt, cfg.maxPromptChars) },
    );
  }

  // mode.kind === "dynamic" — the original decomposition flow, unchanged below.

  // STEP 2 — truncate before the prompt reaches any model. This is the only place
  // it happens, so the limit cannot be bypassed by reordering downstream calls.
  const originalPrompt = truncate(rawPrompt, cfg.maxPromptChars);
  const promptTruncated = originalPrompt.length < rawPrompt.length;

  // STEP 3 — decompose. Domain routing is resolved later, per subtask, so it
  // plays no part here. A failure leaves the existing A/B paths in charge.
  let rawPlan: unknown;
  try {
    rawPlan = await decomposeTask(cfg, originalPrompt, deps.getSubagent(), sessionKey);
  } catch (e) {
    logger?.warn(`[dragon-task-orchestrator] decomposition failed: ${errorMessage(e)}`);
    return null;
  }

  // STEP 4 — orchestrate.
  return await handleDecomposedRequest(
    {
      subagent: deps.getSubagent(),
      cfg,
      rootSessionKey: sessionKey,
      knownAgentIds: deps.getKnownAgentIds(),
      agentDescriptions: deps.getAgentDescriptions(),
      orchestratorAgentId: currentAgentId,
      logger,
      // Notices travel out of band (notify.ts), NOT through this hook's return
      // value — `before_agent_reply` returns exactly one reply. When no notifier is
      // injected, the notice degrades to a line in the final reply as before.
      notify: deps.notify
        ? (text: string) => deps.notify!(sessionKey, currentAgentId, text)
        : undefined,
      emitEvent: deps.emitEvent,
    },
    { originalPrompt, rawPlan, promptTruncated },
  );
}

/**
 * Register the hook. Only called when the plugin is enabled.
 *
 * The `api` parameter is structural rather than the full `OpenClawPluginApi` so
 * this module stays independent of the SDK surface. It must still be assignable
 * FROM the host's generic `on<K extends PluginHookName>(...)`, which under
 * strictFunctionTypes means two things: the hook name has to be the literal (a
 * plain `string` is not assignable to `PluginHookName`), and the handler's return
 * type has to be the concrete result union (`unknown` is not assignable to what
 * the host expects back).
 */
export function registerHooks(
  api: {
    on: (
      name: "before_agent_reply",
      handler: (event: HookEvent, ctx: HookContext) => Promise<HookResult>,
    ) => void;
  },
  deps: HookDeps,
): void {
  api.on("before_agent_reply", async (event: HookEvent, ctx: HookContext): Promise<HookResult> => {
    try {
      const text = await runBeforeAgentReply(deps, event, ctx);
      // If the hook returns null, the main agent pipeline continues as normal.
      if (text === null) return;
      return { handled: true, reply: { text }, reason: "dragon-task-orchestrator" };
    } catch (e) {
      // Never let this plugin break the ordinary reply path.
      deps.logger?.warn(`[dragon-task-orchestrator] hook error: ${errorMessage(e)}`);
      return;
    }
  });
}
