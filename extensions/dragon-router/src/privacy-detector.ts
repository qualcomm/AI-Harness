/**
 * Privacy level detection (S1/S2/S3) via local model.
 */

import { callLocalModel } from "./local-model.js";
import { normalizeModelText } from "./parse-helpers.js";
import { loadPrompt } from "./prompt-loader.js";
import type { LocalModelConfig, PrivacyLevel } from "./types.js";

// Complete built-in prompt. Kept in sync with prompts/privacy-detection.md — this
// is the source of truth at runtime, since prompts/*.md are NOT copied into the
// compiled dist/. The .md file only serves as an optional user override when present.
const FALLBACK_PROMPT = `You are a strict privacy classifier. Output ONLY a single JSON object — nothing else.

Classify the user's message into exactly one sensitivity level, judging by BOTH the actual data present AND the intent.

S3 = PRIVATE (local only):
- Credentials: passwords, API keys, secrets, tokens, private/SSH keys
- Financial: payslip, salary, bank account, tax (工资单, 报销单, 税表)
- Medical: records, diagnoses, prescriptions, lab results (病历, 体检报告)
- ANY request to read/analyze a file about the above → S3

S2 = SENSITIVE (redact PII):
- Physical addresses (地址, 路, 街, 小区, 号)
- Phone, email, real personal names as contact info
- ID/SSN, license plates, delivery/tracking codes, gate/door codes
- PII mixed with an otherwise ordinary task

S1 = SAFE: no sensitive data or intent (general Q&A, coding, writing, translation, greetings)

Rules:
- Credentials/medical/financial → ALWAYS S3 (never S2)
- Ordinary PII (name/phone/address/email) → S2
- When unsure, pick the HIGHER (more restrictive) level

Do NOT explain. Do NOT think step by step. Your entire response must be exactly one line: {"level":"S1"} or {"level":"S2"} or {"level":"S3"}.

Examples:
Input: 帮我写一首关于春天的诗
Output: {"level":"S1"}
Input: 我的手机号是13800138000，帮我拟一条短信
Output: {"level":"S2"}
Input: 数据库密码是 root/Abc@123，帮我看看连接串对不对
Output: {"level":"S3"}`;

function parseLevel(raw: string): PrivacyLevel | null {
  // Strip markdown fences + unescape double-encoded quotes (e.g. {\"level\":\"S2\"})
  // so the primary pattern matches instead of falling back to the bare-token scan.
  const text = normalizeModelText(raw);
  const m = text.match(/"level"\s*:\s*"(S[123])"/i);
  if (m) return m[1].toUpperCase() as PrivacyLevel;
  // tolerant: a bare S1/S2/S3 token
  const bare = text.match(/\bS([123])\b/i);
  if (bare) return `S${bare[1]}` as PrivacyLevel;
  return null;
}

/**
 * Detect the privacy level of a message.
 * On local-model failure, conservatively returns "S3" (keep local, never leak).
 *
 * NOTE: caching removed — every call re-queries the local model. `cacheTtlMs` is
 * kept in the signature for call-site compatibility but is currently unused.
 */
export async function detectPrivacyLevel(
  cfg: LocalModelConfig,
  message: string,
  _cacheTtlMs: number,
): Promise<PrivacyLevel> {
  const systemPrompt = loadPrompt("privacy-detection", FALLBACK_PROMPT);
  // DIAGNOSTIC: log the exact prompt the local model receives for privacy detection.
  console.info(
    `[dragon-router] DIAG privacy-detect sysPromptHead=${JSON.stringify(systemPrompt.slice(0, 80))}`,
  );
  console.info(
    `[dragon-router] DIAG privacy-detect message=${JSON.stringify(message.slice(0, 300))}`,
  );
  try {
    const raw = await callLocalModel(cfg, systemPrompt, message);
    console.info(`[dragon-router] DIAG privacy-detect raw=${JSON.stringify(raw.slice(0, 200))}`);
    return parseLevel(raw) ?? "S2"; // unparseable → treat as sensitive
  } catch {
    // Local model down: fail safe — keep it fully local.
    return "S3";
  }
}
