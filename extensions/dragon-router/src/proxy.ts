/**
 * Local HTTP proxy for S2 traffic.
 *
 * Request:  strip desensitization markers → forward to real upstream (by model id).
 * Response: stream back to the client, re-sensitizing placeholders (⟦PII_xxxx⟧)
 *           into their original values. Handles placeholders split across chunks
 *           via a tail-buffer.
 */

import * as http from "node:http";
import { deSensitizeGlobal, getMaxPlaceholderLen, reSensitizeGlobal } from "./pii-map-store.js";
import { getUpstreamTarget } from "./provider.js";

export type ProxyHandle = {
  port: number;
  close: () => Promise<void>;
};

export const S2_OPEN = "<dragon-s2>";
export const S2_CLOSE = "</dragon-s2>";

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Strip <dragon-s2>...</dragon-s2> markers, keeping ONLY the desensitized text. */
function stripMarkers(messages: Array<{ content?: unknown }>): void {
  for (const msg of messages) {
    if (typeof msg.content !== "string") continue;
    const open = msg.content.indexOf(S2_OPEN);
    const close = msg.content.indexOf(S2_CLOSE);
    if (open === -1 || close === -1 || close <= open) continue;
    msg.content = msg.content.slice(open + S2_OPEN.length, close).trim();
  }
}

/**
 * Safety net: replace any raw PII value with its placeholder across ALL messages,
 * regardless of markers. `stripMarkers` only rewrites the marker-wrapped message;
 * the original user message (and prior-turn history / tool results) still carry
 * raw PII. Applying deSensitizeGlobal here guarantees no known raw PII value is
 * forwarded to the upstream cloud model. Handles string and array (multimodal)
 * content, and re-count the number of replacements for logging.
 */
function desensitizeAllMessages(messages: Array<{ content?: unknown }>): number {
  let changed = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      const next = deSensitizeGlobal(msg.content);
      if (next !== msg.content) {
        msg.content = next;
        changed++;
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ text?: unknown }>) {
        if (part && typeof part.text === "string") {
          const next = deSensitizeGlobal(part.text);
          if (next !== part.text) {
            part.text = next;
            changed++;
          }
        }
      }
    }
  }
  return changed;
}

/**
 * System notice injected when the outbound request carries ⟦PII_…⟧ placeholders.
 * Tells the upstream model these tokens are redacted sensitive values: keep them
 * verbatim in the reply, don't interpret, expand, guess, or ask about them.
 */
const PLACEHOLDER_NOTICE =
  "The user content may contain redacted placeholders of the form ⟦PII_xxxxxxxx⟧. " +
  "Each placeholder stands for a piece of sensitive personal information (name, phone, " +
  "address, email, etc.) that has been removed for privacy. Treat every placeholder as " +
  "an opaque token: do NOT try to infer, guess, or ask about its real value, and do not " +
  "comment on it. Preserve each placeholder EXACTLY as written (same characters, unchanged) " +
  "wherever it should appear in your response, as if it were the original value.";

/**
 * Prepend a system message carrying the placeholder notice. Must run AFTER
 * desensitization so the sample ⟦PII_xxxxxxxx⟧ token in the notice isn't itself
 * treated as PII. Uses a standalone system message (works for OpenAI-format
 * chat/completions, which is what the proxy forwards).
 */
function injectPlaceholderNotice(messages: Array<{ role?: string; content?: unknown }>): void {
  messages.unshift({ role: "system", content: PLACEHOLDER_NOTICE });
}

/**
 * Transform a response text chunk, re-sensitizing complete placeholders and
 * holding back a tail that might be the start of a split placeholder.
 * Returns [emit, newTail].
 */
export function reSensitizeChunk(tail: string, chunk: string): [string, string] {
  const combined = tail + chunk;
  const restored = reSensitizeGlobal(combined);

  // Hold back a suffix that could be the prefix of an unfinished placeholder.
  // Placeholders start with "⟦PII_". Find the last "⟦" not yet closed by "⟧".
  const lastOpen = restored.lastIndexOf("⟦");
  const lastClose = restored.lastIndexOf("⟧");
  if (lastOpen !== -1 && lastOpen > lastClose) {
    // Possible split placeholder — but cap the held tail length.
    const maxHold = getMaxPlaceholderLen() + 4;
    if (restored.length - lastOpen <= maxHold) {
      return [restored.slice(0, lastOpen), restored.slice(lastOpen)];
    }
  }
  return [restored, ""];
}

/**
 * Convert a complete (non-streaming) OpenAI chat completion response into SSE
 * chunks the client SDK can consume as a stream. Used because the proxy always
 * calls the upstream non-streaming (so re-sensitization runs on complete text),
 * but the client may have requested a stream.
 */
function completionToSSE(responseJson: Record<string, unknown>): string {
  const id = (responseJson.id as string) ?? "chatcmpl-dragon";
  const model = (responseJson.model as string) ?? "";
  const created = (responseJson.created as number) ?? 0;
  const choices = (responseJson.choices as Array<Record<string, unknown>>) ?? [];
  const chunks: string[] = [];

  for (const choice of choices) {
    const msg = choice.message as Record<string, unknown> | undefined;
    const content = (msg?.content as string) ?? "";
    const finishReason = (choice.finish_reason as string) ?? "stop";
    const index = (choice.index as number) ?? 0;
    // The assistant message may be a tool call (content empty, tool_calls set).
    // These MUST be forwarded verbatim in the streamed delta, otherwise the
    // client sees finish_reason="tool_calls" with no tool_calls payload and
    // aborts the turn ("incomplete turn: stopReason=toolUse payloads=0").
    const toolCalls = msg?.tool_calls as unknown[] | undefined;

    if (content || (Array.isArray(toolCalls) && toolCalls.length > 0)) {
      const delta: Record<string, unknown> = { role: "assistant" };
      if (content) delta.content = content;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) delta.tool_calls = toolCalls;
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index, delta, finish_reason: null }],
        })}\n\n`,
      );
    }
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index, delta: {}, finish_reason: finishReason }],
        ...(responseJson.usage ? { usage: responseJson.usage } : {}),
      })}\n\n`,
    );
  }

  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

/**
 * Re-sensitize a completion JSON object in place: restore ⟦PII_…⟧ placeholders
 * to their original values in both the assistant `content` AND any tool-call
 * arguments (the model may echo a placeholder into a tool argument, e.g. a search
 * query built from the user's redacted address — the tool must receive the real
 * value, not the placeholder).
 */
function reSensitizeCompletion(responseJson: Record<string, unknown>): void {
  const choices = responseJson.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const msg = choice.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    if (typeof msg.content === "string") {
      msg.content = reSensitizeGlobal(msg.content);
    }
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.arguments === "string") {
          fn.arguments = reSensitizeGlobal(fn.arguments);
        }
      }
    }
  }
}

export async function startProxy(port: number, log: Logger): Promise<ProxyHandle> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
        stream?: boolean;
      };
      // Remember whether the CLIENT wanted streaming; we always call the upstream
      // non-streaming so re-sensitization runs on complete, contiguous text.
      const clientWantsStream = parsed.stream === true;

      // ① Strip S2 markers (keep desensitized text only).
      if (Array.isArray(parsed.messages)) {
        stripMarkers(parsed.messages);
        // ①b Safety net: desensitize ANY remaining raw PII across all messages
        // (original user message, history, tool results) before forwarding.
        const redacted = desensitizeAllMessages(parsed.messages);
        if (redacted > 0) {
          log.info(`[dragon-router:proxy] desensitized raw PII in ${redacted} message(s)`);
        }
        // ①c Tell the upstream model that ⟦PII_…⟧ tokens are redacted placeholders:
        // keep them verbatim, don't interpret/expand/ask about them. Injected AFTER
        // desensitization so the sample token below isn't itself rewritten.
        if (redacted > 0) {
          injectPlaceholderNotice(parsed.messages);
        }
      }

      // ② Resolve real upstream by model id.
      const modelId = parsed.model ?? "";
      const target = getUpstreamTarget(modelId);
      if (!target || !target.baseUrl) {
        log.error(`[dragon-router:proxy] no upstream for model "${modelId}"`);
        res.writeHead(502).end(JSON.stringify({ error: `no upstream for model ${modelId}` }));
        return;
      }

      const upstreamUrl = `${target.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (target.apiKey) {
        if (target.provider.toLowerCase().includes("anthropic")) {
          headers["x-api-key"] = target.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${target.apiKey}`;
        }
      }

      // ③ Always call the upstream NON-streaming: re-sensitization must run on the
      // complete, contiguous response text. On an SSE stream a placeholder can be
      // split across chunks (⟦PII_…⟧ interleaved with SSE framing), so exact-match
      // restoration is impossible. Buffering the full JSON avoids that entirely.
      // Also drop `stream_options` (e.g. {include_usage:true}): it's a streaming-only
      // field the client may have sent alongside stream:true, and some providers
      // (e.g. dashscope) reject a request where stream:false but stream_options is
      // still present with "'stream' and 'stream_options' must be set together".
      const upstreamBody = { ...parsed, stream: false, stream_options: undefined };
      // TEMP DIAGNOSTIC: confirm no raw PII reaches the upstream body. Remove after verifying.
      // Includes tool-role messages too — tool results (e.g. a `read` call's file
      // contents) are the main vector for PII that never passed through the S2
      // user-message desensitize path; the tool-result middleware is responsible
      // for redacting those before they ever get here.
      const diagMessages = (upstreamBody.messages ?? []).filter(
        (m) => m.role === "user" || m.role === "tool",
      );
      log.info(`[dragon-router:proxy] DIAG outbound user+tool messages=${JSON.stringify(diagMessages)}`);
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });

      const responseText = await upstream.text();

      // Upstream error or non-JSON: pass through verbatim (still re-sensitized).
      let responseJson: Record<string, unknown> | null = null;
      if (upstream.ok) {
        try {
          responseJson = JSON.parse(responseText) as Record<string, unknown>;
        } catch {
          responseJson = null;
        }
      }

      if (!responseJson) {
        // Couldn't parse — return the raw body with placeholders restored as text.
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(reSensitizeGlobal(responseText));
        return;
      }

      // ④ Re-sensitize placeholders → original values on the complete text.
      reSensitizeCompletion(responseJson);

      if (clientWantsStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(completionToSSE(responseJson));
      } else {
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseJson));
      }
    } catch (err) {
      log.error(`[dragon-router:proxy] error: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  log.info(`[dragon-router:proxy] listening on http://127.0.0.1:${port}`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
