/**
 * Local model invocation for the `runLocally` fallback (answering in place
 * with a target agent's approximated voice — see index.ts/hooks.ts).
 *
 * Classification, decomposition, and summarization no longer go through this
 * module; they call `subagent.run` with an optional provider/model override
 * instead (see delegate.ts `runOneShotModelCall`), so they can target a cloud
 * model rather than always hitting a local endpoint.
 *
 * Adapted from the dragon-router implementation that previously lived in this
 * repo (see git history at 849a4717^).
 */

import type { LocalModelConfig } from "./types.js";

/** Strip <think>...</think> reasoning blocks that some local models emit. */
export function stripThinking(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const lastClose = result.lastIndexOf("</think>");
  if (lastClose !== -1) {
    result = result.slice(lastClose + "</think>".length).trim();
  }
  return result;
}

/**
 * Call the local model with a system + user prompt and return raw text.
 * Throws on network/HTTP error — callers decide the fallback.
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
  return await callOpenAiCompatible(cfg.endpoint, cfg.model, systemPrompt, userContent);
}

async function callOllama(
  endpoint: string,
  model: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const url = `${endpoint.replace(/\/$/, "")}/api/chat`;
  // Qwen models honor a /no_think directive to skip reasoning output.
  const sys = model.toLowerCase().includes("qwen") ? `/no_think\n${systemPrompt}` : systemPrompt;

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
      options: { temperature: 0, num_predict: 2048 },
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
      max_tokens: 2048,
      stream: false,
      // Non-standard flag, carried over from dragon-router: disables thinking on
      // endpoints that support it. Harmless where unrecognized.
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
