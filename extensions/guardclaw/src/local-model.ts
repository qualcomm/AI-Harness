/**
 * GuardClaw Local Model Detector
 *
 * Local model-based sensitivity detection using Ollama or other local providers.
 */

import { loadPrompt, loadPromptWithVars } from "./prompt-loader.js";
import type {
  DetectionContext,
  DetectionResult,
  PrivacyConfig,
  SensitivityLevel,
} from "./types.js";
import { levelToNumeric } from "./types.js";

/**
 * Detect sensitivity level using a local model
 */
export async function detectByLocalModel(
  context: DetectionContext,
  config: PrivacyConfig,
): Promise<DetectionResult> {
  // Check if local model is enabled
  if (!config.localModel?.enabled) {
    return {
      level: "S1",
      levelNumeric: 1,
      reason: "Local model detection disabled",
      detectorType: "localModelDetector",
      confidence: 0,
    };
  }

  try {
    const prompt = buildDetectionPrompt(context);
    const response = await callLocalModel(prompt, config);
    const parsed = parseModelResponse(response);

    let { level } = parsed;

    // If the LLM says S1 but we have file content with obvious PII, bump to S2.
    // This handles cases where the message itself is innocent but the file has PII.
    if (level === "S1" && context.fileContentSnippet) {
      const piiLevel = quickPiiScan(context.fileContentSnippet);
      if (piiLevel !== "S1") {
        console.log(`[GuardClaw] LLM said S1 but file PII scan found ${piiLevel} — bumping`);
        level = piiLevel;
        parsed.reason = `${parsed.reason ?? ""}; file content contains PII (auto-bumped to ${piiLevel})`;
      }
    }

    return {
      level,
      levelNumeric: levelToNumeric(level),
      reason: parsed.reason,
      detectorType: "localModelDetector",
      confidence: parsed.confidence ?? 0.8,
    };
  } catch (err) {
    // Fail-closed: if the local model is unavailable, treat the content as the
    // highest sensitivity level (S3) rather than silently passing it through as
    // safe (S1). This prevents sensitive content from reaching cloud models when
    // the privacy protection layer is degraded.
    //
    // Users who intentionally run without a local model should set
    // localModel.enabled = false in their config — that path returns S1 above.
    console.error("[GuardClaw] Local model detection failed — failing closed (S3):", err);
    return {
      level: "S3",
      levelNumeric: 3,
      reason: `Local model unavailable — failing closed to prevent data leakage: ${String(err)}`,
      detectorType: "localModelDetector",
      confidence: 0,
    };
  }
}

/**
 * Quick regex-based PII scan for file content.
 * Not used for primary detection — only as a safety net when the LLM says S1
 * but the file content clearly contains PII that should be at least S2.
 */
function quickPiiScan(content: string): SensitivityLevel {
  const s3Patterns = [
    /\bpassword\s*[:=]/i,
    /\b密码\s*[:：]/,
    /\bAPI[_\s]?key\s*[:=]/i,
    /\bsecret\s*[:=]/i,
    /\btoken\s*[:=]/i,
    /\bprivate[_\s]?key/i,
    /\bid_rsa\b/i,
  ];
  for (const p of s3Patterns) {
    if (p.test(content)) return "S3";
  }

  let piiHits = 0;
  const s2Patterns = [
    /\(\d{3}\)\s?\d{3}-\d{4}/, // US phone (415) 867-5321
    /\b1[3-9]\d{9}\b/, // CN mobile 13867554321
    /\b\d{3}-\d{2}-\d{4}\b/, // US SSN 518-73-6294
    /\b\d{6}(?:19|20)\d{8}\b/, // CN ID 330106196208158821
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, // email
    /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/, // card number
    /\b(?:gate|door|access)\s*code\s*[:：]?\s*\S+/i, // gate code
    /门禁码\s*[:：]?\s*\S+/, // CN gate code
    /\b(?:tracking|单号)\s*[:：]?\s*\S+/i, // tracking number
    /\b(?:license\s*plate|车牌号?)\s*[:：]?\s*\S+/i, // license plate
    /\b[沪京粤苏浙鲁豫川闽湘鄂]\w[·]?\w{4,5}\b/, // CN license plate
    /\b\d{1,5}\s+\w+\s+(?:St|Street|Ave|Avenue|Blvd|Dr|Drive|Rd|Road|Ln|Lane)\b/i, // US address
    /(?:路|街|弄|号|巷|村)\d+/, // CN address
  ];
  for (const p of s2Patterns) {
    if (p.test(content)) piiHits++;
  }

  // Need at least 2 PII pattern matches to classify as S2
  return piiHits >= 2 ? "S2" : "S1";
}

/** Default detection system prompt (fallback if prompts/detection-system.md is missing) */
const DEFAULT_DETECTION_SYSTEM_PROMPT = `[SYSTEM] You are a strict privacy classifier. Output ONLY a single JSON object — nothing else.

Classify by BOTH actual data AND intent. If the user asks to read/analyze a file, classify based on what the file WILL contain.

S3 = PRIVATE (local only, never cloud):
  - Financial: payslip, salary, tax, bank account, SSN, 工资单, 报销单, 税表
  - Medical: health records, diagnoses, prescriptions, lab results, 病历, 体检报告
  - Credentials: passwords, API keys, secrets, tokens, private keys
  - ANY request to read/analyze a file about the above topics → S3
  "evaluate these passwords" → S3
  "check my payslip" → S3
  "summarize the medical record" → S3

S2 = SENSITIVE (redact PII, then send to cloud):
  - Addresses (ANY physical address, 地址, 住址, street, road, apartment, 路, 街, 小区, 弄, 号)
  - Gate/door codes, pickup codes, delivery tracking numbers
  - Phone numbers, email addresses, real names used as contact PII
  - License plates, SSN/ID mixed with personal context, chat logs with PII
  - File content containing the above PII → S2
  - ANY mention of "address"/"地址" with actual location data → S2
  "1847 Elm St, gate code 4523#" → S2
  "我的地址是北京市朝阳区xxx" → S2
  "张伟 手机13912345678" → S2
  "my address is 123 Main St" → S2

S1 = SAFE: No sensitive data or intent.
  "write a poem about spring" → S1
  "how to read Excel with pandas" → S1

Rules:
- Passwords/credentials → ALWAYS S3 (never S2)
- Medical data → ALWAYS S3 (never S2)
- Gate/access/pickup codes → S2 (not S3)
- If file content is provided and contains PII → at least S2
- When unsure → pick higher level

Output format: {"level":"S1|S2|S3","reason":"brief"}`;

/**
 * Build detection prompt for the local model.
 *
 * The system instruction is loaded from prompts/detection-system.md (editable by users).
 * The dynamic [CONTENT] block with message/tool info is appended by code.
 *
 * Tuned for MiniCPM4.1-8B but works with other 8B-class models (Qwen3, Llama).
 */
function buildDetectionPrompt(context: DetectionContext): string {
  const systemPrompt = loadPrompt("detection-system", DEFAULT_DETECTION_SYSTEM_PROMPT);

  const parts: string[] = [systemPrompt, "", "[CONTENT]"];

  if (context.message) {
    parts.push(`Message: ${context.message.slice(0, 1500)}`);
  }

  if (context.toolName) {
    parts.push(`Tool: ${context.toolName}`);
  }

  if (context.toolParams) {
    const paramsStr = JSON.stringify(context.toolParams, null, 2);
    parts.push(`Tool Parameters: ${paramsStr.slice(0, 800)}`);
  }

  if (context.toolResult) {
    const resultStr =
      typeof context.toolResult === "string"
        ? context.toolResult
        : JSON.stringify(context.toolResult);
    parts.push(`Tool Result: ${resultStr.slice(0, 800)}`);
  }

  if (context.recentContext && context.recentContext.length > 0) {
    parts.push(`Recent Context: ${context.recentContext.slice(-3).join(" | ")}`);
  }

  parts.push("[/CONTENT]");

  return parts.join("\n");
}

/**
 * Call local model (Ollama or OpenAI-compatible providers)
 */
async function callLocalModel(prompt: string, config: PrivacyConfig): Promise<string> {
  const provider = config.localModel?.provider ?? "ollama";
  const model = config.localModel?.model ?? "openbmb/minicpm4.1";
  const endpoint = config.localModel?.endpoint ?? "http://localhost:11434";

  if (provider === "ollama") {
    return await callOllama(endpoint, model, prompt);
  }

  if (provider.includes("openai")) {
    return await callOpenAiCompatible(endpoint, model, prompt);
  }

  throw new Error(`Unsupported local model provider: ${provider}`);
}

/**
 * Call Ollama API
 */
async function callOllama(endpoint: string, model: string, prompt: string): Promise<string> {
  const url = `${endpoint}/api/generate`;

  const modelLower = model.toLowerCase();

  // Model-specific prompt adjustments:
  // - Qwen3: prefix with /no_think to suppress chain-of-thought output
  // - MiniCPM / others: use prompt as-is
  const finalPrompt = modelLower.includes("qwen") ? `/no_think\n${prompt}` : prompt;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt: finalPrompt,
      stream: false,
      options: {
        temperature: 0.1, // Low temperature for consistent classification
        num_predict: 800, // Allow space for thinking models
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { response?: string };
  let result = data.response ?? "";

  // Strip thinking output from models that use 、、 (MiniCPM, Qwen3, etc.)
  // Case 1: Full 、、 blocks
  result = result.replace(/、、[\s\S]*?<\/think>/g, "").trim();
  // Case 2: Only 、、 appears (partial thinking) — take text after the LAST 、、
  const lastThinkClose = result.lastIndexOf("、、");
  if (lastThinkClose !== -1) {
    result = result.slice(lastThinkClose + "、、".length).trim();
  }

  return result;
}

/**
 * Call OpenAI-compatible API (LM Studio, vLLM, etc.)
 */
async function callOpenAiCompatible(
  endpoint: string,
  model: string,
  prompt: string,
): Promise<string> {
  // Normalize endpoint: remove /v1 suffix if present to avoid duplication
  const baseUrl = endpoint.replace(/\/v1\/?$/, "");
  const url = `${baseUrl}/v1/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI-compatible API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let result = data.choices?.[0]?.message?.content ?? "";

  // Strip thinking output
  result = result.replace(/、、[\s\S]*?<\/think>/g, "").trim();
  const lastThinkClose = result.lastIndexOf("、、");
  if (lastThinkClose !== -1) {
    result = result.slice(lastThinkClose + "、、".length).trim();
  }

  return result;
}

/**
 * Desensitize content using local model.
 * For S2 content: ask the local model to redact sensitive parts, then return
 * the cleaned text that is safe to send to cloud models.
 *
 * Falls back to rule-based redaction if the local model is unavailable.
 */
/**
 * Two-step desensitization using a local model:
 *   Step 1: Model identifies PII items as a JSON array (completion-style prompt)
 *   Step 2: Programmatic string replacement using the model's output
 *
 * This approach is much more reliable than asking the model to rewrite text,
 * because small models like MiniCPM4.1 hallucinate when asked to edit text
 * but are good at structured extraction with completion-style prompts.
 *
 * Returns a `piiMap` (tag → original value) so callers can store it in session
 * state and later re-sensitize tool call parameters before local execution.
 * Tags are numbered per type to ensure uniqueness:
 *   e.g. two phone numbers → [REDACTED:PHONE:1] and [REDACTED:PHONE:2]
 */
export async function desensitizeWithLocalModel(
  content: string,
  config: PrivacyConfig,
): Promise<{ desensitized: string; wasModelUsed: boolean; piiMap: Map<string, string> }> {
  if (!config.localModel?.enabled) {
    console.log("[GuardClaw] desensitizeWithLocalModel: local model disabled, skipping");
    return { desensitized: content, wasModelUsed: false, piiMap: new Map() };
  }

  const endpoint = config.localModel?.endpoint ?? "http://localhost:11434";
  const model = config.localModel?.model ?? "openbmb/minicpm4.1";
  const provider = config.localModel?.provider ?? "ollama";

  console.log(
    `[GuardClaw] desensitizeWithLocalModel: start provider=${provider} model=${model} contentLen=${content.length}`,
  );

  try {
    // Step 1: Ask the model to identify PII as JSON
    const piiItems = await extractPiiWithModel(endpoint, model, content, provider);

    if (piiItems.length === 0) {
      console.warn(
        "[GuardClaw] desensitizeWithLocalModel: model returned 0 PII items — " +
          "content will be sent to cloud UNCHANGED. Check PII extraction logs above.",
      );
      return { desensitized: content, wasModelUsed: true, piiMap: new Map() };
    }

    console.log(
      `[GuardClaw] desensitizeWithLocalModel: replacing ${piiItems.length} PII item(s): ` +
        piiItems.map((i) => `${i.type}="${i.value.slice(0, 20)}"`).join(", "),
    );

    // Step 2: Programmatic replacement with numbered tags for uniqueness.
    // Each distinct PII value gets its own tag: [REDACTED:SECRET:1], [REDACTED:PHONE:1], etc.
    // The piiMap records tag → original value for later re-sensitization in tool calls.
    let redacted = content;
    const piiMap = new Map<string, string>(); // tag → original value
    const typeCounters = new Map<string, number>(); // baseTag → count

    // Sort by value length descending to avoid partial replacements
    const sorted = [...piiItems].sort((a, b) => b.value.length - a.value.length);
    for (const item of sorted) {
      if (!item.value || item.value.length < 2) continue;

      // Check if this exact value was already assigned a tag (dedup)
      let existingTag: string | undefined;
      for (const [tag, val] of piiMap) {
        if (val === item.value) {
          existingTag = tag;
          break;
        }
      }

      if (existingTag) {
        // Same value already mapped — just replace remaining occurrences
        redacted = replaceAll(redacted, item.value, existingTag);
      } else {
        // New value — assign a unique numbered tag
        const baseTag = mapPiiTypeToTag(item.type);
        const count = (typeCounters.get(baseTag) ?? 0) + 1;
        typeCounters.set(baseTag, count);
        // Insert counter before the closing ]: [REDACTED:SECRET] → [REDACTED:SECRET:1]
        const tag = baseTag.replace("]", `:${count}]`);
        piiMap.set(tag, item.value);
        redacted = replaceAll(redacted, item.value, tag);
      }
    }

    console.log(
      `[GuardClaw] desensitizeWithLocalModel: done. original="${content.slice(0, 80)}" → redacted="${redacted.slice(0, 80)}"`,
    );
    console.log(
      `[GuardClaw] desensitizeWithLocalModel: piiMap has ${piiMap.size} entries: ` +
        [...piiMap.keys()].join(", "),
    );

    return { desensitized: redacted, wasModelUsed: true, piiMap };
  } catch (err) {
    console.error("[GuardClaw] desensitizeWithLocalModel: FAILED —", err);
    // Fail-closed: throw so callers can block the request rather than
    // forwarding unredacted S2 content to the cloud model.
    throw new Error(
      `Local model unavailable for desensitization — cannot safely process S2 content: ${String(err)}`,
    );
  }
}

/** Map model PII types to [REDACTED:...] tags */
function mapPiiTypeToTag(type: string): string {
  const t = type.toUpperCase().replace(/\s+/g, "_");
  const mapping: Record<string, string> = {
    ADDRESS: "[REDACTED:ADDRESS]",
    ACCESS_CODE: "[REDACTED:ACCESS_CODE]",
    DELIVERY: "[REDACTED:DELIVERY]",
    COURIER_NUMBER: "[REDACTED:DELIVERY]",
    COURIER_NO: "[REDACTED:DELIVERY]",
    COURIER_CODE: "[REDACTED:DELIVERY]",
    TRACKING_NUMBER: "[REDACTED:DELIVERY]",
    NAME: "[REDACTED:NAME]",
    SENDER_NAME: "[REDACTED:NAME]",
    RECIPIENT_NAME: "[REDACTED:NAME]",
    PHONE: "[REDACTED:PHONE]",
    SENDER_PHONE: "[REDACTED:PHONE]",
    FACILITY_PHONE: "[REDACTED:PHONE]",
    LANDLINE: "[REDACTED:PHONE]",
    MOBILE: "[REDACTED:PHONE]",
    EMAIL: "[REDACTED:EMAIL]",
    ID: "[REDACTED:ID]",
    ID_CARD: "[REDACTED:ID]",
    ID_NUMBER: "[REDACTED:ID]",
    CARD: "[REDACTED:CARD]",
    BANK_CARD: "[REDACTED:CARD]",
    CARD_NUMBER: "[REDACTED:CARD]",
    SECRET: "[REDACTED:SECRET]",
    PASSWORD: "[REDACTED:SECRET]",
    API_KEY: "[REDACTED:SECRET]",
    TOKEN: "[REDACTED:SECRET]",
    IP: "[REDACTED:IP]",
    LICENSE_PLATE: "[REDACTED:LICENSE]",
    PLATE: "[REDACTED:LICENSE]",
    TIME: "[REDACTED:TIME]",
    DATE: "[REDACTED:DATE]",
    SALARY: "[REDACTED:SALARY]",
    AMOUNT: "[REDACTED:AMOUNT]",
  };
  return mapping[t] ?? `[REDACTED:${t}]`;
}

/** Simple replaceAll polyfill for older Node */
function replaceAll(str: string, search: string, replacement: string): string {
  // Escape regex special chars in search string
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return str.replace(new RegExp(escaped, "g"), replacement);
}

/**
 * Call Ollama with a completion-style prompt to extract PII as JSON.
 *
 * Uses the generate API with a prefix that shows the model examples and
 * starts the JSON array for it to complete. This is far more reliable
 * than asking the model to rewrite text.
 */
async function extractPiiWithModel(
  endpoint: string,
  model: string,
  content: string,
  provider?: string,
): Promise<Array<{ type: string; value: string }>> {
  const textSnippet = content.slice(0, 3000);

  /** Default PII extraction prompt (fallback if prompts/pii-extraction.md is missing) */
  const DEFAULT_PII_PROMPT = `Task: Extract ALL PII (personally identifiable information) from text as a JSON array.

Types: NAME (every person), PHONE, ADDRESS (all variants including shortened), ACCESS_CODE (gate/door/门禁码), DELIVERY (tracking numbers, pickup codes/取件码), ID (SSN/身份证), CARD (bank/medical/insurance), LICENSE_PLATE (plate numbers/车牌), EMAIL, PASSWORD, PAYMENT (Venmo/PayPal/支付宝), BIRTHDAY, TIME (appointment/delivery times), NOTE (private instructions)

Important: Extract EVERY person's name and EVERY address variant.

Example:
Input: Alex lives at 123 Main St. Li Na phone 13912345678, gate code 1234#, card YB330-123, plate 京A12345, tracking SF123, Venmo @alex99
Output: [{"type":"NAME","value":"Alex"},{"type":"NAME","value":"Li Na"},{"type":"ADDRESS","value":"123 Main St"},{"type":"PHONE","value":"13912345678"},{"type":"ACCESS_CODE","value":"1234#"},{"type":"CARD","value":"YB330-123"},{"type":"LICENSE_PLATE","value":"京A12345"},{"type":"DELIVERY","value":"SF123"},{"type":"PAYMENT","value":"@alex99"}]

Input: {{CONTENT}}
Output: [`;

  const prompt = loadPromptWithVars("pii-extraction", DEFAULT_PII_PROMPT, {
    CONTENT: textSnippet,
  });

  let raw = "";

  console.log(
    `[GuardClaw] extractPiiWithModel: calling provider=${provider ?? "ollama"} model=${model} contentLen=${textSnippet.length}`,
  );

  // Use appropriate API based on provider
  if (provider?.includes("openai")) {
    // OpenAI-compatible API: use proper system/user chat format.
    // Completion-style prompts (Input/Output pairs ending with "Output: [") confuse chat
    // models — they treat the examples as conversation history and fail to identify the
    // actual input to process, returning empty content. Use system/user separation instead.
    const baseUrl = endpoint.replace(/\/v1\/?$/, "");
    const url = `${baseUrl}/v1/chat/completions`;
    console.log(`[GuardClaw] extractPiiWithModel: POST ${url}`);

    const piiSystemMessage = `You are a PII extractor. Extract ALL personally identifiable information from the user's text and return ONLY a JSON array. No explanation, no markdown fences, just the raw JSON array.

PII types: NAME (every person's name), PHONE, ADDRESS (all address variants), ACCESS_CODE (gate/door codes/门禁码), DELIVERY (tracking numbers, pickup codes/取件码), ID (SSN/身份证), CARD (bank/medical/insurance card numbers), LICENSE_PLATE (plate numbers/车牌), EMAIL, PASSWORD (passwords, secrets, API keys, tokens), PAYMENT (Venmo/PayPal/支付宝 handles), BIRTHDAY, TIME (appointment/delivery times), NOTE (private instructions)

Example input: "Alex lives at 123 Main St. Li Na phone 13912345678, gate code 1234#, card YB330-123, plate 京A12345, tracking SF123, Venmo @alex99"
Example output: [{"type":"NAME","value":"Alex"},{"type":"NAME","value":"Li Na"},{"type":"ADDRESS","value":"123 Main St"},{"type":"PHONE","value":"13912345678"},{"type":"ACCESS_CODE","value":"1234#"},{"type":"CARD","value":"YB330-123"},{"type":"LICENSE_PLATE","value":"京A12345"},{"type":"DELIVERY","value":"SF123"},{"type":"PAYMENT","value":"@alex99"}]

Return ONLY the JSON array. If no PII is found, return [].`;

    const requestBody = {
      model,
      messages: [
        { role: "system", content: piiSystemMessage },
        { role: "user", content: `Extract PII from this text:\n${textSnippet}` },
      ],
      temperature: 0.0,
      max_tokens: 2500,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    raw = data.choices?.[0]?.message?.content ?? "";
  } else {
    // Ollama API
    const url = `${endpoint}/api/generate`;
    console.log(`[GuardClaw] extractPiiWithModel: POST ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.0,
          num_predict: 2500,
          stop: ["Input:", "Task:"],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = (await response.json()) as { response?: string };
    raw = data.response ?? "";
  }

  // Strip thinking tags
  raw = raw.replace(/、、[\s\S]*?<\/think>/g, "").trim();
  const lastThink = raw.lastIndexOf("、、");
  if (lastThink !== -1) {
    raw = raw.slice(lastThink + "、、".length).trim();
  }

  // Strip markdown code fences — chat models (OpenAI-compatible) often wrap JSON in ```json ... ```
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Normalize whitespace (model may use newlines between items)
  raw = raw.replace(/\s+/g, " ").trim();

  console.log(`[GuardClaw] PII extraction model raw response (${raw.length} chars): ${raw.slice(0, 200)}`);

  // Complete the JSON array.
  // Completion-style (Ollama /api/generate): model returns continuation without "[", prepend it.
  // Chat-style (OpenAI /v1/chat/completions): model returns complete array starting with "[",
  // do NOT prepend another "[" or the result becomes [[{...}] which is invalid JSON.
  let jsonStr: string;
  if (raw.startsWith("[")) {
    jsonStr = raw; // already a complete array
  } else {
    jsonStr = "[" + raw; // completion-style: prepend the opening bracket
  }

  // Find the last ] to cut off any trailing garbage (explanations, etc.)
  const lastBracket = jsonStr.lastIndexOf("]");
  if (lastBracket >= 0) {
    jsonStr = jsonStr.slice(0, lastBracket + 1);
  } else {
    // No closing ] — model was cut off. Close after the last complete object.
    const lastCloseBrace = jsonStr.lastIndexOf("}");
    if (lastCloseBrace >= 0) {
      jsonStr = jsonStr.slice(0, lastCloseBrace + 1) + "]";
    } else {
      console.warn(`[GuardClaw] PII extraction: no valid JSON found in model response. raw="${raw.slice(0, 200)}"`);
      return [];
    }
  }

  // Fix trailing commas before ]
  jsonStr = jsonStr.replace(/,\s*\]/g, "]");

  // Normalize Python-style single-quoted JSON to double-quoted JSON.
  // Some local models (e.g. minicpm4.1) output {'key': 'value'} instead of {"key": "value"}.
  // Strategy: replace single-quoted keys/values while preserving apostrophes in natural text.
  jsonStr = jsonStr
    .replace(
      /(?<=[\[,{]\s*)'([^']+?)'(?=\s*:)/g,
      '"$1"', // keys: 'type' → "type"
    )
    .replace(
      /(?<=:\s*)'([^']*?)'(?=\s*[,}\]])/g,
      '"$1"', // values: 'PHONE' → "PHONE"
    );

  console.log(
    `[GuardClaw] PII extraction raw JSON (${jsonStr.length} chars): ${jsonStr.slice(0, 300)}...`,
  );

  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) {
      console.warn(`[GuardClaw] PII extraction: parsed result is not an array: ${typeof arr}`);
      return [];
    }
    const items = arr.filter(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).type === "string" &&
        typeof (item as Record<string, unknown>).value === "string",
    ) as Array<{ type: string; value: string }>;
    console.log(
      `[GuardClaw] PII extraction found ${items.length} items: ${items.map((i) => `${i.type}=${i.value}`).join(", ")}`,
    );
    return items;
  } catch (parseErr) {
    console.error(
      `[GuardClaw] PII extraction: JSON.parse failed — ${String(parseErr)}. jsonStr="${jsonStr.slice(0, 300)}"`,
    );
    return [];
  }
}

/**
 * Parse model response to extract sensitivity level
 */
function parseModelResponse(response: string): {
  level: SensitivityLevel;
  reason?: string;
  confidence?: number;
} {
  try {
    // Try to find JSON in the response
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        level?: string;
        reason?: string;
        confidence?: number;
      };

      // Validate level
      const level = parsed.level?.toUpperCase();
      if (level === "S1" || level === "S2" || level === "S3") {
        return {
          level: level as SensitivityLevel,
          reason: parsed.reason,
          confidence: parsed.confidence,
        };
      }
    }

    // Fallback: look for level mentions in text
    const upperResponse = response.toUpperCase();
    if (upperResponse.includes("S3") || upperResponse.includes("PRIVATE")) {
      return {
        level: "S3",
        reason: "Detected from text analysis",
        confidence: 0.6,
      };
    }
    if (upperResponse.includes("S2") || upperResponse.includes("SENSITIVE")) {
      return {
        level: "S2",
        reason: "Detected from text analysis",
        confidence: 0.6,
      };
    }

    // Default to S1 if unable to parse
    return {
      level: "S1",
      reason: "Unable to parse model response",
      confidence: 0.3,
    };
  } catch (err) {
    console.error("[GuardClaw] Error parsing model response:", err);
    return {
      level: "S1",
      reason: "Parse error",
      confidence: 0,
    };
  }
}

/**
 * Call Ollama chat API with proper system/user message separation.
 * Less prone to prompt-echoing than the generate API.
 */
async function callOllamaChat(
  endpoint: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  options?: { stop?: string[] },
): Promise<string> {
  const url = `${endpoint}/api/chat`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 1500,
        ...(options?.stop ? { stop: options.stop } : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat API error: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { message?: { content?: string } };
  let result = data.message?.content ?? "";
  // Strip thinking output
  result = result.replace(/、、[\s\S]*?<\/think>/g, "").trim();
  const lastThink = result.lastIndexOf("、、");
  if (lastThink !== -1) {
    result = result.slice(lastThink + "、、".length).trim();
  }
  return result;
}

/**
 * Call Ollama directly for an S3 analysis task, bypassing the full agent pipeline.
 * Uses /api/generate (Ollama) or /v1/chat/completions (OpenAI-compatible) depending on provider.
 */
export async function callLocalModelDirect(
  systemPrompt: string,
  userMessage: string,
  config: { endpoint?: string; model?: string; provider?: string },
): Promise<string> {
  const endpoint = config.endpoint ?? "http://localhost:11434";
  const model = config.model ?? "openbmb/minicpm4.1";
  const provider = config.provider ?? "ollama";

  if (provider.includes("openai")) {
    // OpenAI-compatible API: use /v1/chat/completions
    const baseUrl = endpoint.replace(/\/v1\/?$/, "");
    const url = `${baseUrl}/v1/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        stop: ["[message_id:", "[Message_id:", "[system:", "Instructions:", "Data:"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI-compatible API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let result = data.choices?.[0]?.message?.content ?? "";

    // Strip thinking output
    result = result.replace(/、、[\s\S]*?<\/think>/g, "").trim();
    const lastThink = result.lastIndexOf("、、");
    if (lastThink !== -1) {
      result = result.slice(lastThink + "、、".length).trim();
    }

    // Truncate at any remaining [message_id: artifacts
    for (const marker of ["[message_id:", "[Message_id:"]) {
      const idx = result.indexOf(marker);
      if (idx > 0) {
        result = result.slice(0, idx).trim();
      }
    }

    return result;
  }

  // Ollama API: use /api/generate
  const url = `${endpoint}/api/generate`;

  // Combine system + user into a single prompt for /api/generate
  const prompt = `${systemPrompt}\n\n${userMessage}\n\nAnalysis:`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 1500,
        repeat_penalty: 1.3,
        stop: ["[message_id:", "[Message_id:", "[system:", "Instructions:", "Data:"],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama generate API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { response?: string };
  let result = data.response ?? "";

  // Strip thinking output
  result = result.replace(/、、[\s\S]*?<\/think>/g, "").trim();
  const lastThink = result.lastIndexOf("、、");
  if (lastThink !== -1) {
    result = result.slice(lastThink + "、、".length).trim();
  }

  // Truncate at any remaining [message_id: artifacts
  for (const marker of ["[message_id:", "[Message_id:"]) {
    const idx = result.indexOf(marker);
    if (idx > 0) {
      result = result.slice(0, idx).trim();
    }
  }

  return result;
}
