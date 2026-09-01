/**
 * dragon-task-orchestrator shared types.
 *
 * Delegation mode C (dynamic decomposition): a composite user request is split
 * into subtasks at runtime, each matched to a target agent, executed in
 * dependency layers, then summarized into a single reply.
 */

/** One subtask produced by the decomposition model (no target agent — see resolve-agent.ts). */
export type SubtaskPlan = {
  id: number;
  /** Short human-readable label for this subtask. */
  title: string;
  /** Instruction text sent as the delegation message. */
  description: string;
  /** Acceptance criteria handed to the verifier as the judging standard. Empty/absent = no verify step. */
  acceptanceCriteria?: string;
  /**
   * Named items this subtask's final message must carry for its consumers.
   *
   * Only meaningful when something declares a dependency on this subtask. Deliberately a
   * list of names rather than a JSON schema: workers legitimately produce prose and
   * documents (one wrote a 38KB HTML file), so forcing JSON output would fight the task.
   * What the downstream actually loses to summarizing or truncation is specific facts —
   * ticket prices, per-leg distances, source URLs — and a checklist pins exactly those
   * without dictating a format.
   *
   * Fed to the worker as part of the hand-off notice AND to the verifier, so it is
   * enforced rather than merely requested.
   */
  handoffContract?: string[];
  /** Indexes of preceding subtasks whose output this one needs to read. */
  needsPriorResults?: number[];
};

export type DecomposePlan = { subtasks: SubtaskPlan[] };

/**
 * Discriminated union so the status/error coupling is a compile-time constraint:
 * the type system cannot express `{status:"error"}` without `error`, nor
 * `{status:"ok"}` carrying one.
 */
export type SubtaskResult =
  | {
      id: number;
      agentId: string;
      text: string;
      status: "ok";
      /** Orchestration-level notices split out of the delegated text (see notices.ts). */
      processingNotices: string[];
      /** Number of verify attempts taken before this result passed, when a verifier was configured. */
      verifyAttempts?: number;
    }
  | { id: number; agentId: string; text: ""; status: "error"; error: string };

/** Parsed output of a Verifier's judgment on a worker's result. */
export type VerifyOutcome = { passed: boolean; feedback: string };

/** Result of validating + cleaning a raw decomposition plan. */
export type ValidatedPlan = {
  subtasks: SubtaskPlan[];
  /** Dropped because the subtask count exceeded maxSubtasks. */
  droppedSubtasks: SubtaskPlan[];
  /** Dropped because the description was empty. */
  droppedEmptyDescriptions: SubtaskPlan[];
  /** Kept, but the description was truncated. */
  truncatedDescriptions: SubtaskPlan[];
  /** Kept, but some dependencies were dropped past the per-subtask cap. */
  truncatedDeps: SubtaskPlan[];
};

/**
 * Delegation metadata for recursion protection.
 *
 * NOTE: this never travels through model-visible text. `SubagentRunParams` has
 * no custom field, so the delegation marker is encoded in the childSessionKey
 * itself (host-assigned, model-unreachable) and these values are held in a
 * process-local map keyed by that session key. See design.md D1.
 */
export type DelegationMeta = {
  /** Number of forwarding hops taken so far. 0 = first delegation. */
  hopCount: number;
  /** Top-level session of the originating request; never overwritten per hop. */
  rootSessionKey: string;
  /** Target the orchestrator already resolved, so the receiver need not reclassify. */
  hintedAgentId: string;
  /**
   * Which subtask this child session is currently serving, and in what capacity.
   *
   * Exists so the tool-activity hooks can attribute a child session's tool calls
   * back to a row in the PRD card (see progress-event.ts). Reversing the child
   * session key is impossible — it is a hash — so the mapping has to be recorded
   * here, where it is already being written just before each delegated run.
   *
   * Same-agent subtasks SHARE one child session key and run strictly serially, so
   * "currently serving" is well defined: whichever run last wrote this entry.
   */
  subtaskId?: number;
  /** Distinguishes worker execution from a verifier's judgment on the same subtask. */
  role?: "work" | "verify";
};

/** Local model endpoint used by runLocally's target-agent voice approximation. */
export type LocalModelConfig = {
  api: string;
  endpoint: string;
  model: string;
};

/** Fully resolved plugin config (defaults applied). */
export type DragonTaskOrchestratorConfig = {
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
  /**
   * Per-agent responsibility summary for the routing classifier, keyed by agent
   * id. Takes precedence over the `systemPromptOverride` this used to borrow:
   * an override is a full persona/behavior instruction whose first
   * MAX_DOMAIN_DESCRIPTION_CHARS are often generic boilerplate carrying no
   * domain signal, which pushed the classifier back to guessing from the id.
   * Agents absent from this map still fall back to that borrowed text.
   */
  agentDescriptions: Record<string, string>;
  /** Max re-delegations to a worker after a failed verify. Default 2 (3 attempts total). */
  maxVerifyRetries: number;
  /**
   * Per-block budget for text handed to a verifier.
   *
   * Separate from `maxContextChars` on purpose: that one sizes prior context passed
   * between subtasks. Reusing it here made verifiers judge a truncated copy of the
   * worker's result and then fail the subtask *for being truncated* — a loop no
   * retry could escape, since each retry produced more text to cut.
   */
  maxVerifyChars: number;
  localModel: LocalModelConfig;
  /**
   * Provider/model override forwarded to `subagent.run` for the
   * classify/decompose/summarize calls. Left unset, those calls use whatever
   * default model the host resolves for a fresh session. Requires
   * `plugins.entries.dragon-task-orchestrator.subagent.allowModelOverride` on the
   * host side, or the calls throw — see README "Classifier model".
   */
  classifierProvider?: string;
  classifierModel?: string;
  /**
   * Operator confirmation gate for a proposed decomposition. Answerable only from
   * the Control UI card, so `enabled` defaults to false — see config-schema.ts.
   */
  prdConfirmation: {
    enabled: boolean;
    timeoutMs: number;
    /** What an unanswered gate does once `timeoutMs` elapses. */
    onTimeout: "proceed" | "cancel";
    /** How many "adjust and re-decompose" rounds are allowed before executing. */
    maxAdjustRounds: number;
  };
  logging: boolean;
};
