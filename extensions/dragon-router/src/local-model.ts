/**
 * Local model invocation (Ollama / OpenAI-compatible).
 *
 * Used for: privacy detection, complexity classification, PII extraction.
 * Pattern adapted from guardclaw's local-model.ts.
 */

import type { LocalModelConfig } from "./types.js";

/** Strip <think>...</think> reasoning output that some local models emit. */
function stripThinking(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const lastClose = result.lastIndexOf("</think>");
  if (lastClose !== -1) {
    result = result.slice(lastClose + "</think>".length).trim();
  }
  return result;
}

/**
 * Call the local model with a system + user prompt, return raw text.
 * Throws on network/HTTP error (caller decides fallback).
 */
export async function callLocalModel(
  cfg: LocalModelConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const api = cfg.api.toLowerCase();
  if (api === "ollama") {
    return await callOllama(cfg.endpoint, cfg.model, systemPrompt, userContent);
  }
  if (api !== "openai-compatible") {
    // Unknown api value — fall back to openai-compatible (fail-safe) but warn.
    console.warn(
      `[dragon-router] unknown localModel.api "${cfg.api}", falling back to "openai-compatible"`,
    );
  }
  return await callOpenAiCompatible(cfg.endpoint, cfg.model, systemPrompt, userContent);
}

async function callOllama(
  endpoint: string,
  model: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const url = `${endpoint.replace(/\/$/, "")}/api/chat`;
  const modelLower = model.toLowerCase();
  const sys = modelLower.includes("qwen") ? `/no_think\n${systemPrompt}` : systemPrompt;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userContent },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 1024 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  return stripThinking(data.message?.content ?? "");
}

async function callOpenAiCompatible(
  endpoint: string,
  model: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const baseUrl = endpoint.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const url = `${baseUrl}/v1/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: 1024,
      stream: false,
      // Local classifier/extractor calls: disable thinking, deterministic.
      // Flag below is not standard OpenAI API, we adopt it for geniex now.
      enable_think: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Local model API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return stripThinking(data.choices?.[0]?.message?.content ?? "");
}
