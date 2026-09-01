/**
 * Length-bounding helpers.
 *
 * Two length helpers with opposite retention:
 *   - truncate:         keeps the head (normal text)
 *   - truncateKeepTail: keeps the tail (text whose instruction sits at the end)
 */

const REFERENCE_DATA_START = "<<<REFERENCE_DATA_START>>>";
const REFERENCE_DATA_END = "<<<REFERENCE_DATA_END>>>";

export { REFERENCE_DATA_END, REFERENCE_DATA_START };

/**
 * Truncate to at most `max` characters, keeping the head.
 *
 * Reserves room for the notice suffix first, so the return value is always
 * <= max. A naive `slice(0, max) + suffix` returns max + suffix.length, which
 * would quietly break every length guarantee built on this function.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const dropped = text.length - max;
  const tail = `\n...(内容过长，已截断 ${dropped} 字符)`;
  // Degenerate config: max smaller than the notice itself — return the notice
  // prefix rather than attempting to keep unreadable fragments of the original.
  if (tail.length >= max) return tail.slice(0, max);
  return text.slice(0, max - tail.length) + tail;
}

/**
 * Truncate to at most `max` characters, keeping the TAIL.
 *
 * For text shaped as `priorContext + "\n\n---\n\n" + instruction`, where the
 * actual instruction is at the end. Head-keeping truncation would cut the
 * instruction away entirely once the prior context grew large, leaving only
 * reference material and no task.
 *
 * Also removes an orphaned REFERENCE_DATA_END: if the cut lands inside a marker
 * pair, the surviving lone END would desync the "text between markers is data,
 * text outside may be instructions" boundary downstream. The block is already
 * incomplete, so dropping the stray END makes the remnant read as plain text
 * instead of a falsely well-formed reference block.
 */
export function truncateKeepTail(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const dropped = text.length - max;
  const head = `(前置参考内容过长，已截断 ${dropped} 字符)\n...\n`;
  if (head.length >= max) return head.slice(0, max);
  const kept = text.slice(text.length - (max - head.length));

  const startIdx = kept.indexOf(REFERENCE_DATA_START);
  const endIdx = kept.indexOf(REFERENCE_DATA_END);
  const hasOrphanEnd = endIdx !== -1 && (startIdx === -1 || startIdx > endIdx);
  const cleanedKept = hasOrphanEnd
    ? kept.slice(0, endIdx) + kept.slice(endIdx + REFERENCE_DATA_END.length)
    : kept;
  return head + cleanedKept;
}

/**
 * Wrap untrusted text as a reference-data block, so a model reads it as data to
 * be examined rather than as instructions addressed to it.
 *
 * The markers in `text` are escaped first: without that, input containing a
 * literal `<<<REFERENCE_DATA_END>>>` could close the block early and have
 * whatever follows read as instructions — the exact injection the wrapper exists
 * to prevent.
 */
export function wrapAsReferenceData(text: string, maxChars: number): string {
  const escaped = text
    .replaceAll(REFERENCE_DATA_START, "&lt;&lt;&lt;REFERENCE_DATA_START&gt;&gt;&gt;")
    .replaceAll(REFERENCE_DATA_END, "&lt;&lt;&lt;REFERENCE_DATA_END&gt;&gt;&gt;");
  return `${REFERENCE_DATA_START}\n${truncate(escaped, maxChars)}\n${REFERENCE_DATA_END}`;
}
