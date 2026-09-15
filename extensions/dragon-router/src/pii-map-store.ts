/**
 * Session-scoped PII placeholder ↔ original-value map.
 *
 * Lifecycle: written during S2 desensitization (before_model_resolve), read
 * during re-sensitization (proxy response / message_sending), then cleared.
 * Values are sensitive — never persist to disk, clear promptly.
 */

import type { PiiItem } from "./types.js";

type Entry = { items: PiiItem[]; ts: number };

const store = new Map<string, Entry>();

/**
 * Global placeholder → original lookup. Placeholders are globally unique
 * (sha256 of session+idx+value), so the HTTP proxy — which does NOT receive
 * the dragon-router sessionKey — can re-sensitize a response stream by looking
 * up any placeholder it encounters here, without knowing the session.
 */
const globalPlaceholders = new Map<string, { original: string; ts: number }>();

/**
 * Global original-value → placeholder lookup (reverse of globalPlaceholders).
 * The HTTP proxy uses this to desensitize OUTBOUND request messages — replacing
 * any raw PII value it finds with its placeholder — without knowing the session.
 * This is the safety net that guarantees raw PII never reaches the cloud even if
 * a message wasn't marker-wrapped (e.g. prior-turn history, tool results).
 */
const globalOriginals = new Map<string, { placeholder: string; ts: number }>();

const MAX_AGE_MS = 600_000; // 10 min hard cap
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now - v.ts > MAX_AGE_MS) store.delete(k);
    }
    for (const [k, v] of globalPlaceholders) {
      if (now - v.ts > MAX_AGE_MS) globalPlaceholders.delete(k);
    }
    for (const [k, v] of globalOriginals) {
      if (now - v.ts > MAX_AGE_MS) globalOriginals.delete(k);
    }
  }, 60_000);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
}

/** Longest placeholder length seen — used by the proxy to size its tail buffer. */
let maxPlaceholderLen = 0;

export function getMaxPlaceholderLen(): number {
  return maxPlaceholderLen;
}

/** Look up a single placeholder's original value (global). */
export function lookupPlaceholder(placeholder: string): string | undefined {
  return globalPlaceholders.get(placeholder)?.original;
}

/** Replace all known placeholders in `text` using the global registry. */
export function reSensitizeGlobal(text: string): string {
  if (globalPlaceholders.size === 0 || !text.includes("⟦PII_")) return text;
  let out = text;
  for (const [placeholder, v] of globalPlaceholders) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(v.original);
  }
  return out;
}

/**
 * Desensitize OUTBOUND text: replace any known raw PII value with its placeholder,
 * using the global registry (no sessionKey needed). This is the proxy's safety net
 * so raw PII in ANY message (not just marker-wrapped ones) never reaches the cloud.
 * Values are replaced longest-first so a shorter value can't corrupt a longer one.
 */
export function deSensitizeGlobal(text: string): string {
  if (globalOriginals.size === 0 || !text) return text;
  const originals = [...globalOriginals.entries()].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [original, v] of originals) {
    if (original && out.includes(original)) out = out.split(original).join(v.placeholder);
  }
  return out;
}

/** Store the PII items for a session (overwrites previous turn's map). */
export function setPiiMap(sessionKey: string, items: PiiItem[]): void {
  startCleanup();
  if (items.length === 0) {
    store.delete(sessionKey);
    return;
  }
  store.set(sessionKey, { items, ts: Date.now() });
  // Also register globally so the proxy can re-sensitize without a sessionKey.
  const now = Date.now();
  for (const it of items) {
    globalPlaceholders.set(it.placeholder, { original: it.original, ts: now });
    globalOriginals.set(it.original, { placeholder: it.placeholder, ts: now });
    if (it.placeholder.length > maxPlaceholderLen) maxPlaceholderLen = it.placeholder.length;
  }
}

/**
 * Append PII items to a session's map (and the global registry) WITHOUT
 * clobbering existing entries. Used for tool-result PII, which accumulates
 * across a turn on top of any S2 user-message PII.
 */
export function addPiiItems(sessionKey: string, items: PiiItem[]): void {
  startCleanup();
  if (items.length === 0) return;
  const existing = store.get(sessionKey)?.items ?? [];
  const merged = [...existing];
  const now = Date.now();
  for (const it of items) {
    if (!merged.some((p) => p.placeholder === it.placeholder)) merged.push(it);
    globalPlaceholders.set(it.placeholder, { original: it.original, ts: now });
    globalOriginals.set(it.original, { placeholder: it.placeholder, ts: now });
    if (it.placeholder.length > maxPlaceholderLen) maxPlaceholderLen = it.placeholder.length;
  }
  store.set(sessionKey, { items: merged, ts: now });
}

/** Get the PII items for a session, if any. */
export function getPiiMap(sessionKey: string): PiiItem[] | undefined {
  return store.get(sessionKey)?.items;
}

/** Clear a session's PII map (call after re-sensitizing the response). */
export function clearPiiMap(sessionKey: string): void {
  store.delete(sessionKey);
}

/**
 * Re-sensitize: replace every placeholder in `text` with its original value.
 * Returns the restored text (unchanged if no placeholders / no map).
 */
export function reSensitize(sessionKey: string, text: string): string {
  const items = store.get(sessionKey)?.items;
  if (!items || items.length === 0) return text;
  let out = text;
  for (const item of items) {
    if (out.includes(item.placeholder)) {
      out = out.split(item.placeholder).join(item.original);
    }
  }
  return out;
}
