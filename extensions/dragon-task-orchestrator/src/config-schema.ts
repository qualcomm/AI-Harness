/**
 * dragon-task-orchestrator config schema + defaults.
 *
 * Every threshold is configurable rather than hardcoded. The planning docs
 * repeatedly note these are *suggested initial values* that must be calibrated
 * against the real local-model context window — see design.md D5 and the
 * README's calibration checklist.
 */

import { Type } from "@sinclair/typebox";
import type { DragonTaskOrchestratorConfig } from "./types.js";

export const dragonTaskOrchestratorConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  /**
   * Max subtasks actually executed. Default 4 (the docs' conservative value).
   * Unlike the docs, this is NOT derived from "the agent pool has 4 entries" —
   * the pool comes from cfg.agents.list and is user-configurable, so any
   * pigeonhole collision is reported at runtime instead (see design.md D4).
   */
  maxSubtasks: Type.Optional(Type.Integer({ minimum: 2, maximum: 16 })),
  maxPromptChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 100000 })),
  maxDescriptionChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 50000 })),
  maxContextChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 50000 })),
  maxFinalReplyChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 100000 })),
  maxTotalSummaryChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 100000 })),
  maxDepsPerSubtask: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  maxNoticeItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  maxDelegationHops: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  /** Per-subtask delegation timeout. No documented initial value — needs measurement. */
  subtaskTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
  defaultAgentId: Type.Optional(Type.String()),
  /**
   * Routing-classifier responsibility summaries, keyed by agent id. Exists
   * because the host's `agents.list` has no description field, and borrowing
   * `systemPromptOverride` surfaces persona boilerplate rather than domain.
   */
  agentDescriptions: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Max re-delegations to a worker after a failed verify. */
  maxVerifyRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  /**
   * Per-block budget for the text handed to a verifier. Deliberately separate from
   * maxContextChars: that one sizes prior-context passed BETWEEN subtasks, and reusing
   * it made verifiers judge a truncated copy and fail subtasks for being truncated.
   */
  maxVerifyChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 200000 })),
  localModel: Type.Optional(
    Type.Object({
      api: Type.Optional(Type.String()),
      endpoint: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
  ),
  /**
   * Provider/model override used for the classify/decompose/summarize calls,
   * forwarded to `subagent.run`. Requires the host to grant
   * `plugins.entries.dragon-task-orchestrator.subagent.allowModelOverride`.
   */
  classifierProvider: Type.Optional(Type.String()),
  classifierModel: Type.Optional(Type.String()),
  /**
   * Gate execution on operator confirmation of the decomposition (Control UI
   * only — see README). Off by default: chat channels have no way to answer the
   * prompt, so enabling it there would stall every request until `timeoutMs`.
   */
  prdConfirmation: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
      onTimeout: Type.Optional(Type.Union([Type.Literal("proceed"), Type.Literal("cancel")])),
      maxAdjustRounds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    }),
  ),
  logging: Type.Optional(Type.Boolean()),
});

export const DEFAULTS: DragonTaskOrchestratorConfig = {
  // Opt-in: without an explicit enable the hook is never registered, so existing
  // mode A/B delegation paths are untouched.
  enabled: false,
  maxSubtasks: 4,
  maxPromptChars: 4000,
  maxDescriptionChars: 2000,
  /**
   * Prior-context budget per dependency, matched to maxVerifyChars.
   *
   * Was 2000, which threw away most of an upstream result: `truncate` keeps the HEAD,
   * so a research subtask that produced ~30KB handed its consumer roughly the first 7%.
   * Measured consequence — subtask 2 of the 2026-08-27 run depended on two research
   * subtasks and still issued 5 web_search calls of its own, i.e. it re-did work whose
   * output it was supposed to have received.
   *
   * The asymmetry this fixes was already documented one line below: a verifier, which
   * only has to JUDGE a result, was given 16000 after truncation made it report the
   * truncation itself as the defect. The consumer, which has to BUILD ON the result,
   * was left at 2000 — 1/8 of what the judge sees. There is no reason for that ordering.
   */
  maxContextChars: 16000,
  maxFinalReplyChars: 6000,
  maxTotalSummaryChars: 8000,
  maxDepsPerSubtask: 3,
  maxNoticeItems: 10,
  maxDelegationHops: 3,
  // TODO(calibrate): 5 minutes is a placeholder. The docs advise keeping this
  // within ~2-3x the observed single-subtask latency, which must be measured
  // per target agent before this value can be considered tuned.
  subtaskTimeoutMs: 300_000,
  defaultAgentId: "default",
  agentDescriptions: {},
  maxVerifyRetries: 2,
  // Must comfortably hold a real worker result: a verifier judging a truncated copy
  // reported the truncation itself as the defect. Now equal to maxContextChars rather
  // than 8x it — that gap existed because the consumer budget was too small, not
  // because a judge needs more than a consumer. Keep them in step when tuning.
  maxVerifyChars: 16000,
  localModel: {
    api: "openai-compatible",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen3:8b",
  },
  classifierProvider: undefined,
  classifierModel: undefined,
  prdConfirmation: {
    // Opt-in for the same reason `enabled` is: the confirmation can only be
    // answered from the Control UI, so a chat-only deployment must not inherit a
    // gate it cannot clear.
    enabled: false,
    timeoutMs: 120_000,
    // Proceed rather than cancel, so an unanswered gate costs a delay instead of
    // discarding a decomposition that already spent model calls.
    onTimeout: "proceed",
    maxAdjustRounds: 3,
  },
  logging: false,
};

type RawConfig = Partial<{
  enabled: boolean;
  maxSubtasks: number;
  maxPromptChars: number;
  maxDescriptionChars: number;
  maxContextChars: number;
  maxFinalReplyChars: number;
  maxTotalSummaryChars: number;
  maxDepsPerSubtask: number;
  maxNoticeItems: number;
  maxDelegationHops: number;
  subtaskTimeoutMs: number;
  defaultAgentId: string;
  agentDescriptions: Record<string, unknown>;
  maxVerifyRetries: number;
  maxVerifyChars: number;
  localModel: Partial<{ api: string; endpoint: string; model: string }>;
  classifierProvider: string;
  classifierModel: string;
  prdConfirmation: Partial<{
    enabled: boolean;
    timeoutMs: number;
    onTimeout: string;
    maxAdjustRounds: number;
  }>;
  logging: boolean;
}>;

/**
 * Clean a hand-written string->string record: both the container and each
 * entry are checked rather than trusted (see the field-level comments this
 * replaces for `agentDescriptions`). Object.entries on a string would split it
 * per character, and a value-only filter would pass every one of those, so the
 * container guard is not redundant.
 */
function cleanStringRecord(raw: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}

/** Apply defaults to a raw (possibly partial/absent) config object. */
export function resolveConfig(raw: unknown): DragonTaskOrchestratorConfig {
  const c = (raw ?? {}) as RawConfig;
  const num = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    enabled: c.enabled ?? DEFAULTS.enabled,
    maxSubtasks: num(c.maxSubtasks, DEFAULTS.maxSubtasks),
    maxPromptChars: num(c.maxPromptChars, DEFAULTS.maxPromptChars),
    maxDescriptionChars: num(c.maxDescriptionChars, DEFAULTS.maxDescriptionChars),
    maxContextChars: num(c.maxContextChars, DEFAULTS.maxContextChars),
    maxFinalReplyChars: num(c.maxFinalReplyChars, DEFAULTS.maxFinalReplyChars),
    maxTotalSummaryChars: num(c.maxTotalSummaryChars, DEFAULTS.maxTotalSummaryChars),
    maxDepsPerSubtask: num(c.maxDepsPerSubtask, DEFAULTS.maxDepsPerSubtask),
    maxNoticeItems: num(c.maxNoticeItems, DEFAULTS.maxNoticeItems),
    maxDelegationHops: num(c.maxDelegationHops, DEFAULTS.maxDelegationHops),
    subtaskTimeoutMs: num(c.subtaskTimeoutMs, DEFAULTS.subtaskTimeoutMs),
    defaultAgentId: c.defaultAgentId ?? DEFAULTS.defaultAgentId,
    // Hand-written config, so both the container and its entries are checked
    // rather than trusted. The container guard is not redundant: Object.entries
    // on a string splits it per character ("abc" -> a/b/c), and every one of
    // those passes a value-only filter, so a stray scalar would become a map of
    // junk agent ids instead of nothing. Blank or non-string values are dropped
    // too — they would render a useless `- id: ` line in the classifier prompt,
    // which is worse than the bare-id fallback.
    agentDescriptions: cleanStringRecord(c.agentDescriptions),
    maxVerifyRetries: num(c.maxVerifyRetries, DEFAULTS.maxVerifyRetries),
    maxVerifyChars: num(c.maxVerifyChars, DEFAULTS.maxVerifyChars),
    localModel: {
      api: c.localModel?.api ?? DEFAULTS.localModel.api,
      endpoint: c.localModel?.endpoint ?? DEFAULTS.localModel.endpoint,
      model: c.localModel?.model ?? DEFAULTS.localModel.model,
    },
    classifierProvider: c.classifierProvider ?? DEFAULTS.classifierProvider,
    classifierModel: c.classifierModel ?? DEFAULTS.classifierModel,
    prdConfirmation: {
      enabled: c.prdConfirmation?.enabled ?? DEFAULTS.prdConfirmation.enabled,
      timeoutMs: num(c.prdConfirmation?.timeoutMs, DEFAULTS.prdConfirmation.timeoutMs),
      // Any unrecognized value falls back to the default rather than being kept:
      // this drives a branch, so an unknown string must not reach it.
      onTimeout:
        c.prdConfirmation?.onTimeout === "cancel" || c.prdConfirmation?.onTimeout === "proceed"
          ? c.prdConfirmation.onTimeout
          : DEFAULTS.prdConfirmation.onTimeout,
      maxAdjustRounds: num(
        c.prdConfirmation?.maxAdjustRounds,
        DEFAULTS.prdConfirmation.maxAdjustRounds,
      ),
    },
    logging: c.logging ?? DEFAULTS.logging,
  };
}
