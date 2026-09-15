/**
 * Task complexity classification (tier 1-5) via local model, with SHA-256 cache.
 */

import { createHash } from "node:crypto";
import { callLocalModel } from "./local-model.js";
import { normalizeModelText } from "./parse-helpers.js";
import { loadPrompt } from "./prompt-loader.js";
import type { ComplexityTier, LocalModelConfig } from "./types.js";

// Complete built-in prompt. Kept in sync with prompts/complexity-classify.md — this
// is the runtime source of truth, since prompts/*.md are NOT copied into the compiled
// dist/. The .md file only serves as an optional user override when present.
const FALLBACK_PROMPT = `You are a task complexity classifier for an AI coding agent. Classify each task into exactly one of five tiers (1 = simplest, 5 = hardest) based on the nature of the work.

## Tiers

Tier 1 — SIMPLE. Pure text transformation. Takes existing text and produces modified text: summarizing a single document, rewriting or humanizing content, simple Q&A, greetings.

Tier 2 — MEDIUM (default). Standard agent work. Writing emails, coding scripts, data analysis (CSV/Excel), project scaffolding, image generation, factual lookups, researching events or conferences, competitive/market research and analysis reports, search-and-replace, memory management.

Tier 3 — COMPLEX. Structured multi-item processing. Systematically processes a collection or extracts precise information: triaging or searching through multiple emails, creating multiple files and directories as a structured tree, extracting facts or structured data from documents and reports.

Tier 4 — RESEARCH. Creative synthesis. Original long-form writing or multi-source combination: blog posts, articles, multi-step workflows (read → code → document), briefings from multiple source files.

Tier 5 — REASONING. Deep PDF analysis. Reading, understanding, and explaining PDF documents in simplified terms.

## Disambiguation

- Summarizing ONE text file → Tier 1; synthesizing MULTIPLE text/research source files into a briefing → Tier 4.
- Data analysis (CSV, Excel, spreadsheets) → Tier 2, regardless of file count.
- Scaffolding a project or library → Tier 2; creating multiple files and directories from a spec → Tier 3.
- Explaining or simplifying a PDF (ELI5) → Tier 5; extracting structured data points from a document → Tier 3.
- Market/competitive analysis or event/conference research → Tier 2.
- When unsure, choose Tier 2.

Output format (raw JSON, no markdown fences, no explanation):
{"tier":1}`;

type CacheEntry = { tier: ComplexityTier; ts: number };
const cache = new Map<string, CacheEntry>();

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function parseTier(raw: string): ComplexityTier | null {
  // Strip markdown fences + unescape double-encoded quotes (e.g. {\"tier\":5})
  // so the primary pattern matches instead of relying on the bare-digit scan.
  const text = normalizeModelText(raw);
  const m = text.match(/"tier"\s*:\s*([1-5])/);
  if (m) return Number(m[1]) as ComplexityTier;
  const bare = text.match(/\b([1-5])\b/);
  if (bare) return Number(bare[1]) as ComplexityTier;
  return null;
}

/**
 * Classify complexity of a message.
 * On failure, returns tier 2 (MEDIUM) as a safe default.
 */
export async function classifyComplexity(
  cfg: LocalModelConfig,
  message: string,
  cacheTtlMs: number,
): Promise<ComplexityTier> {
  const key = hash(message);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < cacheTtlMs) {
    return cached.tier;
  }

  const systemPrompt = loadPrompt("complexity-classify", FALLBACK_PROMPT);
  try {
    const raw = await callLocalModel(cfg, systemPrompt, message);
    const tier = parseTier(raw) ?? 2;
    cache.set(key, { tier, ts: Date.now() });
    return tier;
  } catch {
    return 2;
  }
}
