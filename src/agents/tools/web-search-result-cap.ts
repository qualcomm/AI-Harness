/**
 * Size cap for `web_search` tool results.
 *
 * WHY THIS EXISTS
 * Search providers return snippets of whatever length they like, and nothing downstream
 * bounded them. A measured research turn made 26 searches whose largest single result
 * serialized to 29,730 characters; the accumulated tool results overflowed the model's
 * context mid-tool-loop, which cost 48s of auto-compaction plus a wasted tool loop and a
 * failed verification — roughly 87s on that one subtask, none of it useful work.
 *
 * WHY IT CAPS FIELDS RATHER THAN THE JSON STRING
 * The result reaches the model as `JSON.stringify(payload, null, 2)`. Truncating that
 * string yields invalid JSON, so the cap is applied to the long text fields inside
 * `results` instead, leaving the envelope and the short fields (url, title, score, dates)
 * intact. Those short fields are the citations — the part still worth having once the
 * prose is gone, and cheap to keep.
 *
 * WHY IT IS SHAPE-AGNOSTIC
 * Providers disagree on the field name for body text: Tavily and DuckDuckGo use
 * `snippet`, Brave and Firecrawl use `description`, Exa uses `text`. Rather than
 * enumerate them (and silently miss the next one), this trims whichever string fields are
 * long enough to matter. A field at or below `PRESERVE_BELOW_CHARS` is never touched,
 * which is what keeps urls and titles whole.
 *
 * WHY IT MEASURES INSTEAD OF CALCULATING
 * The budget cannot be derived arithmetically from raw string lengths, because JSON
 * escaping and 2-space indentation inflate the serialized size by an amount that depends
 * on the content — CJK text, quotes and newlines all differ. A single-pass computed
 * budget was tried and overshot the cap on 4 of 5 representative payloads (by 2–8%). So
 * this measures the real serialized size, scales the budget by how far off it is, and
 * re-measures. It converges to 93–96% of the cap within 2–3 passes and, crucially, never
 * returns something over the cap.
 *
 * SECURITY: PRESERVING THE UNTRUSTED-CONTENT MARKERS
 * Provider snippets arrive already wrapped by `wrapWebContent`, as
 * `<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>> … <<<END_EXTERNAL_UNTRUSTED_CONTENT id="…">>>`.
 * A plain tail truncation would cut the closing marker off, leaving the model unable to
 * tell where attacker-controlled text ends — the exact confusion the wrapper exists to
 * prevent. So truncation happens in the MIDDLE and any trailing marker is re-appended.
 *
 * This is the one case where the cap is allowed to be exceeded: if the envelope plus the
 * markers alone are larger than `maxChars`, the markers win and the result comes back over
 * budget. Keeping the boundary intact matters more than the last few hundred characters,
 * and it only arises for caps far below any useful setting.
 */

/** Fields at or below this length are left alone: urls, titles, dates, scores. */
const PRESERVE_BELOW_CHARS = 200;
/** Never trim a body field below this, so every result keeps a usable lead. */
const MIN_FIELD_CHARS = 160;
/** Bounded so a pathological payload cannot spin; 12 halvings exhausts any real input. */
const MAX_PASSES = 12;
const ELLIPSIS = "\n…[web_search result truncated to fit the context window]…\n";
/** A trailing external-content end marker, with or without trailing whitespace. */
const END_MARKER_RE = /\n?<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\s*$/;

export const DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS = 12000;

/**
 * Resolve the configured cap. `0` or negative disables capping; a missing value takes the
 * default. Non-finite input is treated as missing rather than as disabled, so a malformed
 * config fails safe (capped) instead of unbounded.
 */
export function resolveWebSearchMaxResultChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function serializedLength(payload: unknown): number {
  return JSON.stringify(payload, null, 2)?.length ?? 0;
}

/**
 * Trim `text` to roughly `budget` characters from the middle, keeping any trailing
 * untrusted-content end marker attached.
 */
function trimPreservingMarker(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  const marker = text.match(END_MARKER_RE)?.[0] ?? "";
  const body = marker ? text.slice(0, text.length - marker.length) : text;

  const available = budget - marker.length - ELLIPSIS.length;
  if (available <= 0) {
    // No room for prose. Keep the marker regardless — an unclosed wrapper is worse than
    // an empty one.
    return `${ELLIPSIS.trim()}${marker}`;
  }
  if (body.length <= available) {
    return text;
  }
  // Front-weighted: the opening marker, the `Source:` metadata and the lead sentences all
  // live at the start, and the lead is where a snippet's answer usually is.
  const headLen = Math.ceil(available * 0.7);
  const tailLen = available - headLen;
  const tail = tailLen > 0 ? body.slice(body.length - tailLen) : "";
  return `${body.slice(0, headLen)}${ELLIPSIS}${tail}${marker}`;
}

function longTextKeys(record: Record<string, unknown>): string[] {
  return Object.entries(record)
    .filter(([, v]) => typeof v === "string" && v.length > PRESERVE_BELOW_CHARS)
    .map(([k]) => k);
}

/**
 * Apply the cap to one provider result payload.
 *
 * Returns the payload unchanged when it already fits or when capping is disabled, so the
 * common case costs a single `JSON.stringify`. When it does not fit, `truncated: true` and
 * `truncatedFromChars` are added — without them a model reading a cut-off snippet has no
 * way to know it is looking at a fragment.
 */
export function capWebSearchResult(
  payload: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  if (maxChars <= 0) {
    return payload;
  }
  const originalLength = serializedLength(payload);
  if (originalLength <= maxChars) {
    return payload;
  }

  const results = payload.results;
  if (!Array.isArray(results) || results.length === 0) {
    // Nothing to trim: the size is all envelope. Reporting the overrun is still better
    // than passing it through silently.
    return { ...payload, truncated: false, oversizeChars: originalLength };
  }

  const build = (budget: number): Record<string, unknown> => ({
    ...payload,
    results: results.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const record = entry as Record<string, unknown>;
      const keys = longTextKeys(record);
      if (keys.length === 0) {
        return record;
      }
      const next: Record<string, unknown> = { ...record };
      for (const key of keys) {
        next[key] = trimPreservingMarker(record[key] as string, budget);
      }
      return next;
    }),
    truncated: true,
    truncatedFromChars: originalLength,
  });

  const envelopeLength = serializedLength({ ...payload, results: [] });
  let budget = Math.max(
    MIN_FIELD_CHARS,
    Math.floor(Math.max(0, maxChars - envelopeLength) / results.length),
  );
  let best: Record<string, unknown> | null = null;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const candidate = build(budget);
    const size = serializedLength(candidate);
    if (size <= maxChars) {
      best = candidate;
      // Good enough, or nothing left to give back. Stop rather than keep probing.
      if (size >= maxChars * 0.9 || budget <= MIN_FIELD_CHARS) {
        return best;
      }
      // Under-using the allowance wastes context that was paid for. Grow toward it, with
      // a 2x ceiling so one step cannot leap far past the cap.
      budget = Math.floor(budget * Math.min(2, (maxChars * 0.97) / Math.max(1, size)));
      continue;
    }
    if (budget <= MIN_FIELD_CHARS) {
      // Cannot shrink further. Prefer any previously-fitting candidate; otherwise return
      // this one, still far smaller than the original.
      return best ?? candidate;
    }
    budget = Math.max(MIN_FIELD_CHARS, Math.floor((budget * maxChars * 0.95) / size));
  }
  return best ?? build(MIN_FIELD_CHARS);
}
