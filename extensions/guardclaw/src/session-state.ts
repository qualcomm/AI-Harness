// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * GuardClaw Session State Management
 *
 * Tracks privacy state for each session.
 */

import type { Checkpoint, SensitivityLevel, SessionPrivacyState } from "./types.js";

// In-memory session state storage
const sessionStates = new Map<string, SessionPrivacyState>();

/**
 * Mark a session as private (S2 or S3 detected)
 * Once marked private, the session stays private to protect sensitive history.
 */
export function markSessionAsPrivate(sessionKey: string, level: SensitivityLevel): void {
  const existing = sessionStates.get(sessionKey);

  // Mark as private for S2 or S3 (not S1)
  const shouldBePrivate = level === "S2" || level === "S3";

  if (existing) {
    // Once private, always private (don't downgrade)
    existing.isPrivate = existing.isPrivate || shouldBePrivate;
    existing.highestLevel = getHigherLevel(existing.highestLevel, level);
  } else {
    sessionStates.set(sessionKey, {
      sessionKey,
      isPrivate: shouldBePrivate,
      highestLevel: level,
      detectionHistory: [],
    });
  }
}

/**
 * Check if a session is marked as private
 */
export function isSessionMarkedPrivate(sessionKey: string): boolean {
  return sessionStates.get(sessionKey)?.isPrivate ?? false;
}

/**
 * Get the highest detected sensitivity level for a session
 */
export function getSessionHighestLevel(sessionKey: string): SensitivityLevel {
  return sessionStates.get(sessionKey)?.highestLevel ?? "S1";
}

/**
 * Get session sensitivity info including highest level
 */
export function getSessionSensitivity(
  sessionKey: string,
): { highestLevel: SensitivityLevel } | null {
  const state = sessionStates.get(sessionKey);
  if (!state) return null;
  return { highestLevel: state.highestLevel };
}

/**
 * Record a detection event in session history
 */
export function recordDetection(
  sessionKey: string,
  level: SensitivityLevel,
  checkpoint: Checkpoint,
  reason?: string,
): void {
  const state = sessionStates.get(sessionKey);

  if (state) {
    state.detectionHistory.push({
      timestamp: Date.now(),
      level,
      checkpoint,
      reason,
    });

    // Keep only the last 50 detections to avoid memory bloat
    if (state.detectionHistory.length > 50) {
      state.detectionHistory = state.detectionHistory.slice(-50);
    }
  }
}

/**
 * Get full session privacy state
 */
export function getSessionState(sessionKey: string): SessionPrivacyState | undefined {
  return sessionStates.get(sessionKey);
}

/**
 * Clear session state (e.g., when session ends)
 */
export function clearSessionState(sessionKey: string): void {
  sessionStates.delete(sessionKey);
  piiMappings.delete(sessionKey);
  clearDisplaySession(sessionKey);
}

/**
 * Reset session privacy state (allow user to switch back to cloud models)
 * WARNING: This will allow the conversation history to be sent to cloud models
 */
export function resetSessionPrivacy(sessionKey: string): boolean {
  const state = sessionStates.get(sessionKey);
  if (state) {
    state.isPrivate = false;
    state.highestLevel = "S1";
    state.detectionHistory = [];
    // Also clear the guard subsession
    sessionStates.delete(`${sessionKey}:guard`);
    piiMappings.delete(sessionKey);
    return true;
  }
  return false;
}

/**
 * Get all active session states (for debugging/monitoring)
 */
export function getAllSessionStates(): Map<string, SessionPrivacyState> {
  return new Map(sessionStates);
}

// ── Pre-read file tracking ──────────────────────────────────────────────
// Track file paths that were pre-read and desensitized in the S2 flow,
// so we can block tool calls that attempt to read them raw.
const preReadFiles = new Map<string, Set<string>>();

/**
 * Mark file paths as already pre-read for a session's S2 desensitization.
 * Extracts file paths from the message and stores them.
 */
export function markPreReadFiles(sessionKey: string, message: string): void {
  const pattern = /(?:[\w./-]+\/)?[\w\u4e00-\u9fff._-]+\.(?:xlsx|xls|csv|txt|docx|json|md)/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(message)) !== null) {
    matches.push(m[0]);
  }
  if (matches.length > 0) {
    const existing = preReadFiles.get(sessionKey) ?? new Set();
    for (const f of matches) existing.add(f);
    preReadFiles.set(sessionKey, existing);
  }
}

/**
 * Check if a file path was already pre-read for this session.
 */
export function isFilePreRead(sessionKey: string, filePath: string): boolean {
  const files = preReadFiles.get(sessionKey);
  if (!files) return false;
  // Check if any pre-read path is a suffix of (or equals) the target
  for (const f of files) {
    if (filePath === f || filePath.endsWith("/" + f) || filePath.endsWith("\\" + f)) {
      return true;
    }
  }
  return false;
}

// ── Pending S3 escalation (one-shot, from after_tool_call) ─────────────
// When after_tool_call detects S3 content in a tool result (e.g. a file
// containing sensitive keywords), it sets this flag. The NEXT resolve_model
// call consumes and clears it to route that single LLM turn to the local
// guard model. Subsequent messages are evaluated fresh — no sticky routing.
const pendingS3Escalations = new Set<string>();

/**
 * Mark a session as having a pending S3 escalation from a tool result.
 * This is a one-shot flag: it is consumed and cleared by the next resolve_model call.
 */
export function markPendingS3Escalation(sessionKey: string): void {
  pendingS3Escalations.add(sessionKey);
}

/**
 * Consume the pending S3 escalation flag for a session.
 * Returns true (and clears the flag) if a pending escalation exists.
 * Returns false if no escalation is pending.
 */
export function consumePendingS3Escalation(sessionKey: string): boolean {
  if (pendingS3Escalations.has(sessionKey)) {
    pendingS3Escalations.delete(sessionKey);
    return true;
  }
  return false;
}

// ── PII mapping storage (for S2 re-sensitization) ──────────────────────
// Maps sessionKey → Map<redactedTag, originalValue>
// e.g. "[REDACTED:SECRET:1]" → "123456"
//
// When S2 desensitization replaces PII with [REDACTED:xxx:N] tags, the
// original values are stored here. Before any tool call is executed,
// the before_tool_call hook looks up this map and restores original values
// in the tool params, so sensitive data is written/used locally as intended.
const piiMappings = new Map<string, Map<string, string>>();

/**
 * Store PII tag→original mappings for a session.
 * Merges new entries into any existing mapping for the session.
 */
export function storePiiMapping(sessionKey: string, map: Map<string, string>): void {
  if (map.size === 0) return;
  const existing = piiMappings.get(sessionKey) ?? new Map<string, string>();
  for (const [tag, value] of map) {
    existing.set(tag, value);
  }
  piiMappings.set(sessionKey, existing);
}

/**
 * Get the PII mapping for a session (tag → original value).
 */
export function getPiiMapping(sessionKey: string): Map<string, string> | undefined {
  return piiMappings.get(sessionKey);
}

/**
 * Re-sensitize a string by replacing all [REDACTED:xxx:N] tags with their
 * original values from the session's PII mapping.
 */
export function resensitizeText(sessionKey: string, text: string): string {
  const map = piiMappings.get(sessionKey);
  if (!map || map.size === 0) return text;

  let result = text;
  // Sort by tag length descending to avoid partial replacements
  const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [tag, original] of entries) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), original);
  }
  return result;
}

/**
 * Recursively re-sensitize all string values in a tool params object.
 * Replaces [REDACTED:xxx:N] tags with original values from the session's PII mapping.
 */
export function resensitizeParams(
  sessionKey: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const map = piiMappings.get(sessionKey);
  if (!map || map.size === 0) return params;
  return deepResensitize(params, map) as Record<string, unknown>;
}

/**
 * Check if a string contains any [REDACTED:...] tags.
 */
export function hasRedactedTags(text: string): boolean {
  return /\[REDACTED:[^\]]+\]/.test(text);
}

/**
 * Desensitize a string by replacing all original PII values with their
 * [REDACTED:xxx:N] tags from the session's PII mapping.
 *
 * This is the reverse of resensitizeText — used to ensure session history
 * stores desensitized content rather than raw PII values, even after
 * before_tool_call has re-sensitized tool params for local execution.
 *
 * Returns the original string unchanged if no PII map exists for the session
 * or the map is empty.
 */
export function desensitizeWithPiiMap(sessionKey: string, text: string): string {
  const map = piiMappings.get(sessionKey);
  if (!map || map.size === 0) return text;

  let result = text;
  // Sort by original value length descending to avoid partial replacements
  // (e.g. "192.168.1.100" before "192.168.1" if both were somehow mapped)
  const entries = [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [tag, original] of entries) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), tag);
  }
  return result;
}

/**
 * Recursively walk a value and replace all [REDACTED:xxx:N] tags.
 */
function deepResensitize(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") {
    let result = value;
    // Sort by tag length descending to avoid partial replacements
    const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [tag, original] of entries) {
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "g"), original);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepResensitize(item, map));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepResensitize(v, map);
    }
    return result;
  }
  return value;
}

// ── Display session management ──────────────────────────────────────────
// Maintains a parallel "display" session file with real (non-desensitized)
// content for WebUI rendering. The main session stores desensitized content
// for cloud model consumption; the display session stores original content
// for user-facing display.
//
// File path: <baseDir>/sessions/<sessionId>.display.jsonl
// Format: same JSONL format as main session, readable by WebUI directly.
const displaySessionPaths = new Map<string, string>();
// Track message IDs already written by tool_result_persist to avoid double-writing
// in before_message_write.
const displaySessionWrittenIds = new Map<string, Set<string>>();

/**
 * Register the display session file path for a session.
 * Called from session_start hook when a new session begins.
 */
export function registerDisplaySession(sessionKey: string, filePath: string): void {
  displaySessionPaths.set(sessionKey, filePath);
  displaySessionWrittenIds.set(sessionKey, new Set());
}

/**
 * Append a message to the display session file (synchronous write).
 * Tracks the message ID to prevent double-writing across hooks.
 * Fails silently — display session write failure must not block main session.
 */
export function appendToDisplaySession(sessionKey: string, message: unknown): void {
  const filePath = displaySessionPaths.get(sessionKey);
  if (!filePath) return;

  try {
    // oxlint-disable-next-line typescript/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const line = JSON.stringify(message) + "\n";
    fs.appendFileSync(filePath, line, "utf8");

    // Track message ID so before_message_write can skip already-written messages
    const msgId = (message as any)?.id;
    if (msgId) {
      displaySessionWrittenIds.get(sessionKey)?.add(String(msgId));
    }
  } catch (err) {
    console.error(`[GuardClaw] appendToDisplaySession failed: ${String(err)}`);
  }
}

/**
 * Check if a message (by ID) has already been written to the display session.
 * Used in before_message_write to skip tool result messages already handled
 * by tool_result_persist.
 */
export function isMessageWrittenToDisplaySession(sessionKey: string, messageId: string): boolean {
  return displaySessionWrittenIds.get(sessionKey)?.has(messageId) ?? false;
}

/**
 * Clear display session state for a session (called on session_end / clearSessionState).
 */
export function clearDisplaySession(sessionKey: string): void {
  displaySessionPaths.delete(sessionKey);
  displaySessionWrittenIds.delete(sessionKey);
}

/**
 * Helper to compare and return higher level
 */
function getHigherLevel(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
  const order = { S1: 1, S2: 2, S3: 3 };
  return order[a] >= order[b] ? a : b;
}
