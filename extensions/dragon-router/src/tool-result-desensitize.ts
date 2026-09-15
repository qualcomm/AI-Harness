/**
 * Async, PII-aware tool-result middleware for local file-read tools.
 *
 * `tool_result_persist` (the previous approach) is sync-only in OpenClaw — an
 * async handler there gets its Promise silently discarded, so local-model-based
 * desensitization never actually applied. `registerAgentToolResultMiddleware`
 * is awaited by the host, so it is the correct seam for this.
 *
 * Only local file-read tools are covered — the ones that can pull raw file
 * content (names, birthdays, etc.) into the transcript in one shot. Other tools
 * are left untouched to avoid a local-model round trip on every tool call.
 */

import type {
  AgentToolResultMiddleware,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { desensitize } from "./desensitizer.js";
import { addPiiItems } from "./pii-map-store.js";
import { isS3ChildSession } from "./s3-isolation.js";
import type { DragonRouterConfig } from "./types.js";

/** Local file-read tools whose results may contain raw file content. */
const LOCAL_READ_TOOLS = new Set(["read", "ls", "glob", "grep", "find"]);

/** True if this tool's result can carry raw file content into the transcript. */
export function isLocalReadTool(toolName: string): boolean {
  return LOCAL_READ_TOOLS.has(toolName.toLowerCase());
}

/** Join all text blocks in a tool result into one string for desensitization. */
function extractText(content: OpenClawAgentToolResult["content"]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Replace every occurrence of each PII item's original value with its placeholder. */
function replaceText(
  content: OpenClawAgentToolResult["content"],
  items: { original: string; placeholder: string }[],
): OpenClawAgentToolResult["content"] {
  return content.map((block) => {
    if (block.type !== "text") return block;
    let text = block.text;
    for (const item of items) {
      text = text.split(item.original).join(item.placeholder);
    }
    return { ...block, text };
  });
}

/**
 * Build the `registerAgentToolResultMiddleware` handler that desensitizes
 * local file-read tool results before they reach the transcript / cloud model.
 */
export function createToolResultDesensitizeMiddleware(
  api: OpenClawPluginApi,
  config: DragonRouterConfig,
): AgentToolResultMiddleware {
  return async (event, ctx) => {
    if (!isLocalReadTool(event.toolName)) return;

    const sessionKey = ctx.sessionKey ?? "";
    // The S3-isolated child session never leaves the device — desensitizing its
    // tool results would just replace real content with placeholders that
    // nothing ever restores (re-sensitization only runs for the main session's
    // message_sending), corrupting the reply the user actually sees.
    if (isS3ChildSession(sessionKey)) {
      api.logger.info(
        `[dragon-router] tool-result desensitize skipped for "${event.toolName}" — S3-isolated session`,
      );
      return;
    }

    const text = extractText(event.result.content);
    if (!text.trim()) {
      api.logger.info(
        `[dragon-router] tool-result desensitize skipped for "${event.toolName}" — no text content extracted (content=${JSON.stringify(event.result.content).slice(0, 300)})`,
      );
      return;
    }

    const desen = await desensitize(config.localModel, sessionKey, text);
    if (desen.failed) {
      api.logger.warn(
        `[dragon-router] tool-result desensitize FAILED for "${event.toolName}" — local model call failed, tool result left as-is`,
      );
      return;
    }
    if (desen.items.length === 0) {
      api.logger.info(
        `[dragon-router] tool-result desensitize: no PII detected for "${event.toolName}" (textLen=${text.length})`,
      );
      return;
    }

    addPiiItems(sessionKey, desen.items);
    api.logger.info(
      `[dragon-router] tool-result desensitized "${event.toolName}" — ${desen.items.length} PII item(s) redacted`,
    );

    return {
      result: {
        ...event.result,
        content: replaceText(event.result.content, desen.items),
      },
    };
  };
}
