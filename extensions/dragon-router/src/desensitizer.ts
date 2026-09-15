/**
 * Reversible desensitization.
 *
 * Two-step: (1) local model extracts PII items as JSON, (2) we programmatically
 * replace each occurrence with a UNIQUE placeholder and record the mapping so
 * the response can be re-sensitized later.
 *
 * Placeholder format: ⟦PII_<hex>⟧  — the ⟦ ⟧ brackets are unlikely to appear in
 * normal text or to be generated spontaneously by the cloud model, reducing the
 * risk of accidental re-sensitization.
 */

import { createHash } from "node:crypto";
import { callLocalModel } from "./local-model.js";
import { normalizeModelText } from "./parse-helpers.js";
import { loadPrompt } from "./prompt-loader.js";
import type { DesensitizeResult, LocalModelConfig, PiiItem } from "./types.js";

// Complete built-in prompt. Kept in sync with prompts/pii-extraction.md — this is
// the runtime source of truth, since prompts/*.md are NOT copied into the compiled
// dist/. The .md file only serves as an optional user override when present.
const FALLBACK_PROMPT = `You extract personally identifiable information (PII) from text. Output ONLY a JSON array — nothing else.

For each PII item found, output an object: {"type":"<TYPE>","value":"<exact substring>"}.

Types: NAME (every person),PASSWORD, PHONE, ADDRESS (all variants), EMAIL, ID (SSN/身份证), CARD (bank/medical/insurance), LICENSE_PLATE (车牌), ACCESS_CODE (gate/door/门禁码), DELIVERY (tracking/pickup codes/取件码), PAYMENT (Venmo/PayPal/支付宝), BIRTHDAY.

Rules:
- Extract EVERY person's name and EVERY address variant.
- \`value\` must be the EXACT substring as it appears in the text (so it can be string-replaced).
- If no PII, output [].

Output format — follow EXACTLY, no exceptions:
- A single line. No line breaks anywhere in the output, including inside or between array items.
- Raw JSON only. Do NOT wrap it in markdown code fences (no \`\`\`json, no \`\`\`).
- Do NOT escape the JSON or turn it into a string. Output the array itself, not a quoted/escaped representation of it.
- No comments, no explanation, no text before or after the array.

Example:
Input: 张伟 lives at 123 Main St, phone 13912345678, email a@b.com
Output: [{"type":"NAME","value":"张伟"},{"type":"ADDRESS","value":"123 Main St"},{"type":"PHONE","value":"13912345678"},{"type":"EMAIL","value":"a@b.com"}]

Output ONLY the JSON array on one line — no markdown fences, no escaping, no explanation.`;

type RawPii = { type?: string; value?: string };

/**
 * True only when the model's own output, after normalization, IS a clean empty
 * array (`[]`) — i.e. the model explicitly reported "no PII found". This must be
 * distinguished from "couldn't parse anything usable out of this output" (e.g. a
 * bare object, malformed JSON, prose) — those cases are NOT "no PII" and must be
 * treated as an extraction failure by the caller, not silently downgraded to zero
 * items. See desensitize()'s failed-flag handling below.
 */
function isExplicitEmptyArray(raw: string): boolean {
  for (const text of [raw, normalizeModelText(raw)]) {
    if (text.trim() === "[]") return true;
  }
  return false;
}

function parsePiiArray(raw: string): RawPii[] {
  // Try the raw text first (handles the common ```json\n[...]\n``` case — the
  // fences sit outside the [ ] slice). If that fails, retry on a normalized copy
  // that unescapes double-encoded quotes (e.g. [{\"type\":\"PHONE\"...}]).
  for (const text of [raw, normalizeModelText(raw)]) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed as RawPii[];
      } catch {
        /* try next candidate */
      }
    }
    // Fallback: the model emitted a single bare object instead of an array
    // (e.g. {"type":"PASSWORD","value":"666666"}) — treat it as a one-item list
    // instead of silently discarding it (a bare object never matches the [...]
    // scan above, so without this it always looked identical to "no PII found").
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      try {
        const parsed = JSON.parse(text.slice(objStart, objEnd + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return [parsed as RawPii];
        }
      } catch {
        /* try next candidate */
      }
    }
  }
  return [];
}

/** Deterministic-per-index placeholder (avoids Math.random). */
function makePlaceholder(sessionKey: string, index: number, value: string): string {
  const h = createHash("sha256")
    .update(`${sessionKey}:${index}:${value}`)
    .digest("hex")
    .slice(0, 8);
  return `⟦PII_${h}⟧`;
}

/**
 * Desensitize `message`: extract PII via local model, replace with placeholders.
 * Returns desensitized text + placeholder↔original items.
 * On local-model failure, `failed: true` and text is returned unchanged.
 */
export async function desensitize(
  cfg: LocalModelConfig,
  sessionKey: string,
  message: string,
): Promise<DesensitizeResult> {
  const basePrompt = loadPrompt("pii-extraction", FALLBACK_PROMPT);

  // Embed the text to analyze INSIDE the system prompt, and make the user message
  // a fixed instruction. If the text itself is left as the user message, weaker
  // local models (e.g. gpt-oss-20b) execute the instruction inside the text (e.g.
  // "改写这句话") instead of extracting PII. Anchoring the task in the user turn
  // keeps the model on the extraction task.
  const systemPrompt = `${basePrompt}

[TEXT TO ANALYZE]
${message}
[/TEXT TO ANALYZE]`;
  const userInstruction = "Extract all PII from the text above. Output ONLY the JSON array.";

  let raw: string;
  try {
    raw = await callLocalModel(cfg, systemPrompt, userInstruction);
  } catch (err) {
    // DIAGNOSTIC: surface why the local PII-extraction call failed (endpoint down,
    // model id wrong, timeout, non-2xx, etc.) instead of silently failing safe.
    console.error(
      `[dragon-router] desensitize local-model call failed @ ${cfg.endpoint} model=${cfg.model}: ${String(err)}`,
    );
    return { desensitized: message, items: [], failed: true };
  }

  const rawItems = parsePiiArray(raw);
  if (rawItems.length === 0 && !isExplicitEmptyArray(raw)) {
    // The model's output did NOT parse into any items, AND it wasn't a clean
    // `[]` either — this is an extraction FAILURE (malformed/unexpected model
    // output), not a confirmed "no PII in this text". Treating this as "0 PII"
    // would silently forward the raw, un-redacted message to the cloud — this is
    // exactly how a password ("我的密码是666666") reached qwen-turbo in plaintext
    // when the model answered with a bare object instead of an array. Fail safe:
    // report failure so the caller keeps this message local instead of proxying
    // unredacted text to the cloud.
    console.error(
      `[dragon-router] desensitize: unparseable/unexpected model output, treating as extraction FAILURE (not "no PII") — raw="${raw.slice(0, 500)}"`,
    );
    return { desensitized: message, items: [], failed: true };
  }
  const items: PiiItem[] = [];
  let out = message;

  let idx = 0;
  for (const it of rawItems) {
    const value = (it.value ?? "").trim();
    if (!value || !out.includes(value)) continue;
    // Skip if we already mapped this exact value.
    if (items.some((p) => p.original === value)) continue;
    const placeholder = makePlaceholder(sessionKey, idx++, value);
    out = out.split(value).join(placeholder);
    items.push({ placeholder, original: value, type: (it.type ?? "PII").toUpperCase() });
  }

  return { desensitized: out, items, failed: false };
}
