/**
 * Strip OpenClaw-injected inbound metadata from a user message before it is fed
 * to the local classifier / PII extractor.
 *
 * OpenClaw's `buildInboundUserContextPrefix` (src/auto-reply/reply/inbound-meta.ts)
 * prepends AI-facing metadata blocks (Sender / Conversation info / reply context /
 * chat history) plus a `[Www YYYY-MM-DD HH:MM …]` timestamp to the user message.
 * That noise derails small local models (they "answer" the metadata instead of
 * classifying), so we remove it before privacy detection / PII extraction.
 *
 * This is a self-contained port of the core of src/auto-reply/reply/strip-inbound-meta.ts
 * (that module is NOT exported via the plugin SDK). Keep the sentinel list in sync
 * with inbound-meta.ts if OpenClaw changes the block headers.
 *
 * NOTE: only used to build the classifier INPUT. The message actually forwarded
 * to the tier / s3 model is untouched.
 */

/** Leading `[Www YYYY-MM-DD HH:MM …]` timestamp prefix injected by injectTimestamp. */
const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

/** Block header sentinels — must match inbound-meta.ts's buildInboundUserContextPrefix. */
const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const SENTINEL_FAST_RE = new RegExp(
  INBOUND_META_SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

function isSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

/**
 * Remove injected metadata blocks (each: sentinel line + ```json … ``` fence) and
 * the leading timestamp prefix. Returns the cleaned user text. Fast-path returns
 * the input (minus timestamp) unchanged when no metadata blocks are present.
 */
export function stripInboundMeta(text: string): string {
  if (!text) return text;

  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) return withoutTimestamp;

  const lines = withoutTimestamp.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of a metadata block: sentinel line immediately followed by ```json.
    if (!inMetaBlock && isSentinelLine(line)) {
      if (lines[i + 1]?.trim() !== "```json") {
        result.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      // Blank separators between consecutive blocks are dropped.
      if (line.trim() === "") continue;
      // Unexpected non-blank line outside a fence — treat as user content.
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}
