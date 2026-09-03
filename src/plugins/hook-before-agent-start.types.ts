// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// before_model_resolve hook
export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "ollama" */
  providerOverride?: string;
};

// resolve_model hook - allows plugins to override model selection
export type PluginHookResolveModelContext = {
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

export type PluginHookResolveModelEvent = {
  /** The message that triggered this agent turn */
  message?: string;
  /** Current provider selection */
  provider: string;
  /** Current model selection */
  model: string;
  /** Whether this is a default selection (not user-overridden) */
  isDefault: boolean;
};

export type PluginHookResolveModelResult = {
  /** Override provider (e.g., "ollama") */
  provider?: string;
  /** Override model (e.g., "llama3.2:3b") */
  model?: string;
  /** Reason for override (for logging) */
  reason?: string;
  /**
   * Override session key for subsession isolation.
   * When provided, the message will be processed in the specified session
   * instead of the original session. This is useful for privacy isolation
   * where sensitive content should be handled in a separate session.
   */
  sessionKey?: string;
  /**
   * If true, the response from the redirected session should be delivered
   * back to the original session's chat context.
   */
  deliverToOriginal?: boolean;
  /**
   * Extra system prompt to inject for this request.
   */
  extraSystemPrompt?: string;
  /**
   * Override the user prompt sent to the agent.
   */
  userPromptOverride?: string;
  /**
   * If set, skip the normal agent run entirely and deliver this text as the response.
   */
  directResponse?: string;
};

// before_prompt_build hook
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};

export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
  "systemPrompt",
  "prependContext",
  "prependSystemContext",
  "appendSystemContext",
] as const satisfies readonly (keyof PluginHookBeforePromptBuildResult)[];

type MissingPluginPromptMutationResultFields = Exclude<
  keyof PluginHookBeforePromptBuildResult,
  (typeof PLUGIN_PROMPT_MUTATION_RESULT_FIELDS)[number]
>;
type AssertAllPluginPromptMutationResultFieldsListed =
  MissingPluginPromptMutationResultFields extends never ? true : never;
const assertAllPluginPromptMutationResultFieldsListed: AssertAllPluginPromptMutationResultFieldsListed = true;
void assertAllPluginPromptMutationResultFieldsListed;

// before_agent_start hook (legacy compatibility: combines both phases)
export type PluginHookBeforeAgentStartEvent = {
  prompt: string;
  /** Optional because legacy hook can run in pre-session phase. */
  messages?: unknown[];
};

export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult &
  PluginHookBeforeModelResolveResult;

export type PluginHookBeforeAgentStartOverrideResult = Omit<
  PluginHookBeforeAgentStartResult,
  keyof PluginHookBeforePromptBuildResult
>;

export const stripPromptMutationFieldsFromLegacyHookResult = (
  result: PluginHookBeforeAgentStartResult | void,
): PluginHookBeforeAgentStartOverrideResult | void => {
  if (!result || typeof result !== "object") {
    return result;
  }
  const remaining: Partial<PluginHookBeforeAgentStartResult> = { ...result };
  for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) {
    delete remaining[field];
  }
  return Object.keys(remaining).length > 0
    ? (remaining as PluginHookBeforeAgentStartOverrideResult)
    : undefined;
};
