/**
 * Shared normalization for local-model JSON-ish outputs.
 *
 * Small local models wrap their answer in ways that break naive parsing:
 *   - markdown code fences: ```json\n{...}\n```
 *   - double-escaped quotes: {\"level\":\"S2\"} (the model re-encoded JSON as a
 *     string, so the transport-decoded content still carries literal backslashes)
 *
 * These helpers strip that noise so the privacy/complexity/PII parsers can match
 * reliably instead of relying on lenient fallbacks.
 */

/** Remove leading/trailing markdown code fences (```json … ``` or ``` … ```). */
export function stripCodeFences(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\s*/g, "") // opening fence with optional lang tag
    .replace(/```/g, "") // any remaining fence
    .trim();
}

/**
 * Unescape sequences a model may emit when it double-encodes JSON as a string
 * before wrapping it in markdown (\" → ", \\ → \, and literal \n / \r / \t →
 * real whitespace). The \n/\r/\t case matters because double-encoded arrays
 * like `[\n  {\"type\": ...}\n]` have literal backslash-n between structural
 * tokens — leaving it as two literal chars breaks JSON.parse even after quotes
 * are fixed, since a bare backslash outside a string is invalid JSON syntax.
 * Cheap and safe for the tiny classifier outputs we parse (tier/level tokens);
 * for full JSON parsing use `unescapeQuotes` only as a fallback when a first
 * parse attempt fails, to avoid corrupting quoted values.
 */
const UNESCAPE_MAP: Record<string, string> = {
  '"': '"',
  "'": "'",
  "\\": "\\",
  n: "\n",
  r: "\r",
  t: "\t",
};

export function unescapeQuotes(text: string): string {
  return text.replace(/\\(["'\\nrt])/g, (_match, ch: string) => UNESCAPE_MAP[ch] ?? ch);
}

/** Strip fences AND unescape — the standard pre-match cleanup for regex parsers. */
export function normalizeModelText(text: string): string {
  return unescapeQuotes(stripCodeFences(text));
}
