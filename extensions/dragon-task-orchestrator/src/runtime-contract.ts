// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Narrow structural contract for the slice of the host subagent runtime this
 * plugin uses. Mirrors `SubagentRunParams`/`SubagentWaitResult` etc. from the
 * host SDK, but declared structurally so tests can supply fakes without
 * constructing a full PluginRuntime.
 *
 * Note the field list: sessionKey / message / provider / model /
 * extraSystemPrompt / lane / deliver / idempotencyKey. There is no slot for
 * custom delegation metadata — which is precisely why recursion protection
 * encodes its marker in the session key instead (see design.md D1).
 */

export type SubagentRuntime = {
  run: (params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    provider?: string;
    model?: string;
    extraSystemPrompt?: string;
    lane?: string;
    idempotencyKey?: string;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
};

/**
 * Text produced by a delegated run, plus any local image files a tool it called wrote to
 * disk (e.g. a video-frame screenshot) — see `extractToolResultImageFiles` in delegate.ts.
 */
export type DelegationOutcome = { text: string; mediaUrls?: string[] };

/** Minimal logger surface (matches the host plugin logger). */
export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};
