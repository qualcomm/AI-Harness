/**
 * GuardClaw Hooks Registration
 *
 * Registers all plugin hooks for sensitivity detection at various checkpoints.
 * Implements:
 *   - S1: pass-through (no intervention)
 *   - S2: desensitize content via local model / rules, then forward to cloud
 *   - S3: redirect to isolated guard subsession with local-only model
 *   - File-access guards (block cloud models from reading session transcripts)
 *
 * Memory isolation is achieved by the guard agent's separate workspace
 * (workspace-guard/), not by file naming conventions. No MEMORY-FULL.md needed.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { defaultPrivacyConfig } from "./config-schema.js";
import { detectSensitivityLevel } from "./detector.js";
import {
  isGuardSessionKey,
  getGuardAgentConfig,
  isLocalProvider,
} from "./guard-agent.js";
import { desensitizeWithLocalModel } from "./local-model.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  markSessionAsPrivate,
  recordDetection,
  isFilePreRead,
  isSessionMarkedPrivate,
  markPreReadFiles,
  storePiiMapping,
  resensitizeParams,
  resensitizeText,
  hasRedactedTags,
  markPendingS3Escalation,
  consumePendingS3Escalation,
  desensitizeWithPiiMap,
  registerDisplaySession,
  appendToDisplaySession,
  isMessageWrittenToDisplaySession,
  clearDisplaySession,
} from "./session-state.js";
import type { PrivacyConfig } from "./types.js";
import { isProtectedMemoryPath } from "./utils.js";

/**
 * Default guard agent system prompt (used as fallback if prompts/guard-agent-system.md is missing).
 * To customize, edit: extension/prompts/guard-agent-system.md
 */
const DEFAULT_GUARD_AGENT_SYSTEM_PROMPT = `You are a privacy-aware analyst. Analyze the data the user provides. Do your job.

RULES:
1. Analyze the data directly. Do NOT generate programming examples or tutorials.
2. NEVER echo raw sensitive values (exact salary, SSN, bank account, password). Use generic references like "your base salary", "the SSN on file", etc.
3. You MAY discuss percentages, ratios, whether deductions are correct, anomalies, and recommendations.
4. Reply ONCE, then stop. No [message_id:] tags. No multi-turn simulation.
5. **Language rule: Reply in the SAME language the user writes in.** If the user writes in Chinese, reply entirely in Chinese. If the user writes in English, reply entirely in English.
6. Be concise and professional.

语言规则：必须使用与用户相同的语言回复。如果用户用中文提问，你必须用中文回答。`;

/** Load guard agent system prompt from prompts/guard-agent-system.md (or use default) */
function getGuardAgentSystemPrompt(): string {
  return loadPrompt("guard-agent-system", DEFAULT_GUARD_AGENT_SYSTEM_PROMPT);
}

type PreReadEntry = {
  level: "S1" | "S2" | "S3";
  /** Desensitized file content — only set for S2 files, used to re-inject on subsequent turns. */
  desensitizedContent?: string;
};

/**
 * Tracks files already pre-read for sensitivity in resolve_model, keyed by sessionKey.
 * Stores the detected sensitivity level and (for S2) the desensitized content so
 * subsequent resolve_model calls can route and inject correctly without re-reading.
 *
 * After the first pre-read:
 *   - S3 files → route to local model on every subsequent mention
 *   - S2 files → re-inject cached desensitized content; block raw file read
 *   - S1 files → skip (no action needed)
 */
const preReadFilesPerSession = new Map<string, Map<string, PreReadEntry>>();

function getPreReadEntry(sessionKey: string, filePath: string): PreReadEntry | undefined {
  return preReadFilesPerSession.get(sessionKey)?.get(filePath);
}

function markFileAsPreRead(
  sessionKey: string,
  filePath: string,
  level: "S1" | "S2" | "S3",
  desensitizedContent?: string,
): void {
  let map = preReadFilesPerSession.get(sessionKey);
  if (!map) {
    map = new Map();
    preReadFilesPerSession.set(sessionKey, map);
  }
  map.set(filePath, { level, desensitizedContent });
}

/**
 * Register all GuardClaw hooks
 */
export function registerHooks(api: OpenClawPluginApi): void {
  // Conditionally intercept globalThis.fetch to log LLM request/response bodies to disk.
  // Only enabled when privacy.debug.interceptLlmRequests = true in plugin config.
  // WARNING: This writes all LLM payloads (including sensitive content) to disk.
  // Never enable in production.
  const privacyConfigForDebug = getPrivacyConfigFromApi(api);
  if (privacyConfigForDebug.debug?.interceptLlmRequests === true) {
    if (!(globalThis as any).__fetchIntercepted) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        const url = args[0] as string | URL | Request;
        const opts = args[1] as RequestInit | undefined;
        const urlString = url.toString();
        const reqId = Date.now();
        const isLLM =
          urlString.includes("v1/chat/completions") ||
          urlString.includes("anthropic") ||
          urlString.includes("googleapis.com/v1/models");

        if (isLLM) {
          try {
            if (opts?.body) {
              let bodyStr =
                opts.body instanceof Uint8Array || Buffer.isBuffer(opts.body)
                  ? new TextDecoder().decode(opts.body as Uint8Array)
                  : opts.body.toString();
              const bodyJson = JSON.parse(bodyStr);
              // oxlint-disable-next-line typescript/no-require-imports
              const fs = require("node:fs") as typeof import("node:fs");
              // oxlint-disable-next-line typescript/no-require-imports
              const nodePath = require("node:path") as typeof import("node:path");
              const reqFileName = nodePath.join(
                process.cwd(),
                `llm_request_body_${reqId}.json`,
              );
              fs.writeFileSync(reqFileName, JSON.stringify(bodyJson, null, 2), "utf8");
              api.logger.info(
                `[GuardClaw][debug] LLM request body written to: ${reqFileName}`,
              );
            }
          } catch (e) {
            api.logger.error(`[GuardClaw][debug] Failed to write request body: ${String(e)}`);
          }
        }

        const response = await originalFetch(...args);

        if (isLLM) {
          try {
            const resClone = response.clone();
            // oxlint-disable-next-line typescript/no-require-imports
            const fs = require("node:fs") as typeof import("node:fs");
            // oxlint-disable-next-line typescript/no-require-imports
            const nodePath = require("node:path") as typeof import("node:path");
            const resText = await resClone.text();
            const resFileName = nodePath.join(process.cwd(), `llm_response_body_${reqId}.txt`);
            fs.writeFileSync(resFileName, resText, "utf8");
            api.logger.info(
              `[GuardClaw][debug] LLM response body written to: ${resFileName}`,
            );
          } catch (e) {
            api.logger.error(
              `[GuardClaw][debug] Failed to write response body: ${String(e)}`,
            );
          }
        }

        return response;
      };
      (globalThis as any).__fetchIntercepted = true;
      api.logger.warn(
        "[GuardClaw][debug] LLM request interception ENABLED — all LLM payloads will be written to disk. Do NOT use in production.",
      );
    }
  }

  // =========================================================================
  // Hook 1: message_received — Checkpoint for user messages
  // =========================================================================
  api.on("message_received", async (event, ctx) => {
    try {
      api.logger.debug?.(
        `[GuardClaw] message_received hook triggered with event: ${JSON.stringify(event)}`,
      );
      api.logger.debug?.(
        `[GuardClaw] message_received hook triggered with ctx: ${JSON.stringify(ctx)}`,
      );

      // Extract message content from event (may be in different fields)
      const messageContent = (event as any).content || (event as any).message;
      const sessionKey = ctx.sessionKey ?? (event as any).sessionKey ?? "default-session";
      const agentId = ctx.agentId ?? (event as any).agentId;

      api.logger.debug?.(
        `[GuardClaw] message_received: message=${messageContent}, sessionKey=${sessionKey}, agentId=${agentId}`,
      );
      if (!messageContent || !sessionKey) {
        api.logger.error(`[GuardClaw] message_received: missing content or sessionKey, skipping`);
        return;
      }

      const messageText = extractMessageText(messageContent);
      if (!messageText) {
        api.logger.error(
          `[GuardClaw] message_received: unable to extract text from message content, skipping`,
        );
        return;
      }
      api.logger.debug?.(`[GuardClaw] message_received: extracted messageText=${messageText}`);

      // Slash commands (/help, /model, /new, etc.) are internal control directives —
      // always safe, no detection needed.
      if (isSlashCommand(messageText)) {
        api.logger.debug?.(
          `[GuardClaw] message_received: skipping detection for slash command: ${messageText.slice(0, 40)}`,
        );
        return;
      }

      // Detect sensitivity level
      const result = await detectSensitivityLevel(
        {
          checkpoint: "onUserMessage",
          message: messageText,
          sessionKey,
          agentId,
        },
        api.pluginConfig ?? {},
        api.logger,
      );

      // Record detection
      recordDetection(sessionKey, result.level, "onUserMessage", result.reason);

      if (result.level !== "S1") {
        api.logger.info(
          `[GuardClaw] message_received Message sensitivity: ${result.level} for session ${sessionKey} — ${result.reason ?? "no reason"}`,
        );
      }

      // Mark session state
      if (result.level === "S3") {
        markSessionAsPrivate(sessionKey, result.level);
        api.logger.warn(`[GuardClaw] Session ${sessionKey} marked as PRIVATE (S3 detected)`);
      } else if (result.level === "S2") {
        markSessionAsPrivate(sessionKey, result.level);
        api.logger.info(
          `[GuardClaw] S2 detected for session ${sessionKey}. Content will be desensitized for cloud.`,
        );
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in message_received hook: ${String(err)}`);
    }

    api.logger.debug?.(`[GuardClaw] message_received hook completed`);
  });

  // =========================================================================
  // Hook 2: before_tool_call — Checkpoint for tool calls before execution
  //   S3 tools → BLOCK the call and return an error
  //   S2 tools → allow but log
  //   Also: block cloud model access to protected memory/history paths
  //   Also: guard subagent spawn / A2A send (sessions_spawn, sessions_send)
  // =========================================================================
  api.on("before_tool_call", async (event, ctx) => {
    try {
      const { toolName, params } = event;
      const sessionKey = ctx.sessionKey ?? "";

      if (!toolName) {
        return;
      }

      // ── File-access guard: block cloud models from reading full history / memory ──
      const typedParams = params as Record<string, unknown>;
      if (typedParams) {
        const privacyConfig = getPrivacyConfigFromApi(api);
        const baseDir = privacyConfig.session?.baseDir ?? "~/.openclaw";
        const pathValues = extractPathValuesFromParams(typedParams);

        // Cross-agent session isolation: each agent may only read its own sessions.
        // openclaw has no built-in cross-agent session isolation, so this hook is
        // the primary enforcement mechanism.
        //
        //   Cloud model (main agent) → may NOT read guard agent's sessions
        //   Guard agent              → may NOT read main agent's sessions
        const guardAgentId = getGuardAgentConfig(getPrivacyConfigFromApi(api))?.id ?? "guard";
        const blockedAgentId = isGuardSessionKey(sessionKey) ? "main" : guardAgentId;
        for (const p of pathValues) {
          if (isProtectedMemoryPath(p, baseDir, blockedAgentId)) {
            api.logger.warn(
              `[GuardClaw] BLOCKED: session ${sessionKey} tried to read ${blockedAgentId} agent session: ${p}`,
            );
            return {
              block: true,
              blockReason: `GuardClaw: cross-agent session access denied — cannot read ${blockedAgentId} agent session history (${p})`,
            };
          }
        }
      }

      // ── Block tool reads for files already pre-read in S2 desensitization ──
      if (toolName === "read" || toolName === "read_file" || toolName === "cat") {
        const filePath = String(
          typedParams?.path ?? typedParams?.file ?? typedParams?.target ?? "",
        );
        if (filePath && isFilePreRead(sessionKey, filePath)) {
          api.logger.info(
            `[GuardClaw] BLOCKED tool ${toolName} for pre-read file: ${filePath} (content already desensitized in prompt)`,
          );
          return {
            block: true,
            blockReason: `File content has already been provided in the conversation (desensitized for privacy). No need to read it again.`,
          };
        }
      }

      // ── Subagent / A2A guard ──
      // sessions_spawn: scan the task for sensitivity before it reaches the subagent
      // sessions_send:  scan the message for sensitivity before A2A delivery
      const isSpawn = toolName === "sessions_spawn";
      const isSend = toolName === "sessions_send";

      if (isSpawn || isSend) {
        const contentField = isSpawn
          ? String(typedParams?.task ?? "")
          : String(typedParams?.message ?? "");

        if (contentField.trim()) {
          const subagentResult = await detectSensitivityLevel(
            {
              checkpoint: "onToolCallProposed",
              message: contentField,
              toolName,
              toolParams: typedParams,
              sessionKey,
              agentId: ctx.agentId,
            },
            api.pluginConfig ?? {},
            api.logger,
          );

          const label = isSpawn ? "subagent task" : "A2A message";
          recordDetection(
            sessionKey,
            subagentResult.level,
            "onToolCallProposed",
            subagentResult.reason,
          );

          if (subagentResult.level === "S3") {
            const spawnModel = String(typedParams?.model ?? "");
            const isTargetSafe =
              spawnModel.includes("ollama/") ||
              spawnModel.includes("llama") ||
              isLocalProvider(spawnModel.split("/")[0]);

            if (isTargetSafe) {
              api.logger.info(
                `[GuardClaw] Allowed S3 task for sub-agent because it is using a local/safe model (${spawnModel}).`,
              );
              // We return the original params here to skip the "general" sensitivity detection below which will block it
              return { params: typedParams };
            } else {
              markSessionAsPrivate(sessionKey, subagentResult.level);
              api.logger.warn(
                `[GuardClaw] BLOCKED ${toolName}: ${label} contains S3 content. ` +
                  `Reason: ${subagentResult.reason ?? "private data detected"}`,
              );
              return {
                block: true,
                blockReason:
                  `GuardClaw: ${label} blocked — S3 sensitivity detected in ${toolName} ` +
                  `(${subagentResult.reason ?? "private data must not leave local boundary"})`,
              };
            }
          }

          if (subagentResult.level === "S2") {
            markSessionAsPrivate(sessionKey, subagentResult.level);
            api.logger.info(
              `[GuardClaw] S2 detected in ${toolName} ${label}. Desensitizing before forwarding.`,
            );

            const privacyConfig = getPrivacyConfigFromApi(api);
            let desensitizedField: string;
            try {
              const { desensitized } = await desensitizeWithLocalModel(contentField, privacyConfig);
              desensitizedField = desensitized;
            } catch (desensitizeErr) {
              api.logger.error(
                `[GuardClaw] S2 ${label} desensitization failed — blocking ${toolName}: ${String(desensitizeErr)}`,
              );
              return {
                block: true,
                blockReason: `GuardClaw: S2 content detected in ${toolName} but local model is unavailable for desensitization. Blocked to prevent data leakage. Please ensure the local model (Ollama) is running and retry.`,
              };
            }

            // Return modified params with desensitized content
            const fieldName = isSpawn ? "task" : "message";
            return {
              params: { ...typedParams, [fieldName]: desensitizedField },
            };
          }

          // S1: fall through to normal detection below
        }
      }

      // ── Sensitivity detection (general) ──
      const result = await detectSensitivityLevel(
        {
          checkpoint: "onToolCallProposed",
          toolName,
          toolParams: typedParams,
          sessionKey,
          agentId: ctx.agentId,
        },
        api.pluginConfig ?? {},
        api.logger,
      );

      recordDetection(sessionKey, result.level, "onToolCallProposed", result.reason);

      if (result.level !== "S1") {
        api.logger.info(
          `[GuardClaw] Tool call sensitivity: ${result.level} for ${toolName} — ${result.reason ?? "no reason"}`,
        );
      }

      // S3 → BLOCK the tool call
      if (result.level === "S3") {
        markSessionAsPrivate(sessionKey, result.level);
        api.logger.warn(
          `[GuardClaw] BLOCKED tool ${toolName} (S3). Session ${sessionKey} marked as PRIVATE.`,
        );
        return {
          block: true,
          blockReason: `GuardClaw: tool "${toolName}" blocked — S3 sensitivity detected (${result.reason ?? "sensitive operation"})`,
        };
      }

      // S2 → allow but mark session
      if (result.level === "S2") {
        markSessionAsPrivate(sessionKey, result.level);
      }

      // ── Re-sensitize tool params ──────────────────────────────────────────
      // If this session has a PII mapping (from S2 desensitization in resolve_model),
      // restore original values in tool params before the tool is executed locally.
      // This ensures sensitive data (e.g. passwords, addresses) is written/used
      // with the real values, not the [REDACTED:xxx:N] placeholders.
      if (sessionKey) {
        const resensitized = resensitizeParams(sessionKey, typedParams);
        // Check if any params actually changed (avoid unnecessary returns)
        const paramsChanged = hasRedactedTags(JSON.stringify(typedParams)) &&
          JSON.stringify(resensitized) !== JSON.stringify(typedParams);
        if (paramsChanged) {
          api.logger.info(
            `[GuardClaw] Re-sensitized tool params for "${toolName}" in session ${sessionKey} — original PII values restored`,
          );
          return { params: resensitized };
        }
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_tool_call hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 3: after_tool_call — Checkpoint for tool results
  // =========================================================================
  api.on("after_tool_call", async (event, ctx) => {
    try {
      const { toolName, result } = event;
      const sessionKey = ctx.sessionKey ?? "";

      if (!toolName) {
        return;
      }

      const detectionResult = await detectSensitivityLevel(
        {
          checkpoint: "onToolCallExecuted",
          toolName,
          toolResult: result,
          sessionKey,
          agentId: ctx.agentId,
        },
        api.pluginConfig ?? {},
        api.logger,
      );

      recordDetection(
        sessionKey,
        detectionResult.level,
        "onToolCallExecuted",
        detectionResult.reason,
      );

      if (detectionResult.level !== "S1") {
        api.logger.info(
          `[GuardClaw] Tool result sensitivity: ${detectionResult.level} for ${toolName} — ${detectionResult.reason ?? "no reason"}`,
        );
      }

      if (detectionResult.level === "S3") {
        // Use a one-shot pending flag instead of permanently marking the session.
        // This ensures only the NEXT resolve_model call (which processes this tool
        // result) is routed to the local model. Subsequent user messages are
        // evaluated fresh — no sticky S3 routing.
        markPendingS3Escalation(sessionKey);
        api.logger.warn(
          `[GuardClaw] Tool ${toolName} result contains S3 content. Pending S3 escalation set for session ${sessionKey}.`,
        );
      } else if (detectionResult.level === "S2") {
        markSessionAsPrivate(sessionKey, detectionResult.level);
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in after_tool_call hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 4: resolve_model — Model + session routing
  //
  //   S1 → pass-through (cloud model, normal session)
  //   S2 → desensitize content, send desensitized version to cloud model
  //   S3 → redirect to guard subsession with local-only model
  // =========================================================================
  api.on("resolve_model", async (event, ctx) => {
    try {
      //05:10:12 [gateway] [GuardClaw] resolve_model hook triggered with event: {"message":"分析excel 文件 D:\\workspace\\privacy\\test.xlsx","provider":"minimax-portal","model":"MiniMax-M2.5","isDefault":true}
      //05:10:12 [gateway] [GuardClaw] resolve_model hook triggered with ctx: {"agentId":"main","sessionKey":"agent:main:main","messageProvider":"webchat"}
      api.logger.debug?.(
        `[GuardClaw] resolve_model hook triggered with event: ${JSON.stringify(event)}`,
      );
      api.logger.debug?.(`[GuardClaw] resolve_model hook triggered with ctx: ${JSON.stringify(ctx)}`);
      const { message, provider, model } = event;
      const sessionKey = ctx.sessionKey ?? "";

      api.logger.info(
        `[GuardClaw] resolve_model called: sessionKey=${sessionKey}, message=${String(message).slice(0, 50)}, provider=${provider}, model=${model}`,
      );

      if (!sessionKey) {
        api.logger.error(`[GuardClaw] resolve_model: no sessionKey, returning`);
        return;
      }

      const privacyConfig = getPrivacyConfigFromApi(api);
      api.logger.info(
        `[GuardClaw] resolve_model: enabled=${privacyConfig.enabled}, localModel=${privacyConfig.localModel?.enabled}, checkpoints=${JSON.stringify(privacyConfig.checkpoints?.onUserMessage)}`,
      );
      if (!privacyConfig.enabled) {
        api.logger.error(`[GuardClaw] resolve_model: privacy disabled, returning`);
        return;
      }

      // If already in a guard session, enforce exact local model from config
      if (isGuardSessionKey(sessionKey)) {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        if (guardCfg && (provider !== guardCfg.provider || model !== guardCfg.modelName)) {
          return {
            provider: guardCfg.provider,
            model: guardCfg.modelName,
            reason: `GuardClaw: guard session must use configured local model (${guardCfg.provider}/${guardCfg.modelName})`,
          };
        }
        return; // already correct
      }

      // ── Re-route if a tool result was escalated to S3 in the previous turn ──
      // When after_tool_call detects S3 content (e.g. a file containing sensitive
      // keywords), it sets a one-shot pending flag. We consume it here so that only
      // THIS resolve_model call is redirected to the local guard model. The flag is
      // cleared immediately — subsequent user messages are evaluated fresh.
      if (consumePendingS3Escalation(sessionKey)) {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const guardProvider = guardCfg?.provider ?? "ollama";
        const guardModelName = guardCfg?.modelName ?? "openbmb/minicpm4.1";
        const guardAgentId = guardCfg?.id ?? "guard";

        api.logger.warn(
          `[GuardClaw] resolve_model: session ${sessionKey} already at S3 (escalated by tool result). Routing to local model.`,
        );

        api.emitEvent?.("privacy_activated", {
          active: true,
          level: "S3",
          model: `${guardProvider}/${guardModelName}`,
          provider: guardProvider,
        });

        const s3SessionKey = `agent:${guardAgentId}:s3-guard`;
        return {
          reason: `GuardClaw: S3 — session escalated by tool result, routing to local model`,
          sessionKey: s3SessionKey,
          provider: guardProvider,
          model: guardModelName,
          deliverToOriginal: true,
          extraSystemPrompt: getGuardAgentSystemPrompt(),
        };
      }

      // Detect sensitivity of current message
      if (!message) {
        api.logger.error(`[GuardClaw] resolve_model: no message, return`);
        return;
      }

      // Skip if message was already desensitized (prevent double resolve_model runs)
      const msgStr = String(message);
      if (msgStr.includes("[REDACTED:") || msgStr.startsWith("[SYSTEM]")) {
        api.logger.warn(
          `[GuardClaw] resolve_model: already processed or internal prompt, skipping`,
        );
        return;
      }

      // Slash commands (/help, /model, /new, etc.) are internal control directives —
      // always safe, skip detection and let the cloud model handle them directly.
      if (isSlashCommand(msgStr)) {
        api.logger.debug?.(
          `[GuardClaw] resolve_model: skipping detection for slash command: ${msgStr.slice(0, 40)}`,
        );
        return;
      }

      // Pre-read any file paths mentioned in the user message so we can detect
      // S3 content BEFORE routing to the cloud model. Without this, the cloud
      // model would read the file itself (via read_file tool) and see the S3
      // content before after_tool_call can set the pending escalation flag.
      const mentionedPaths = extractFilePathsFromMessage(msgStr);
      if (mentionedPaths.length > 0) {
        api.logger.info(
          `[GuardClaw] resolve_model: pre-reading ${mentionedPaths.length} file(s) for sensitivity check: ${mentionedPaths.join(", ")}`,
        );
        // oxlint-disable-next-line typescript/no-require-imports
        const nodeFs = require("node:fs") as typeof import("node:fs");
        for (const filePath of mentionedPaths) {
          // Check if this file was already pre-read in a previous resolve_model call.
          const cachedEntry = getPreReadEntry(sessionKey, filePath);
          if (cachedEntry !== undefined) {
            if (cachedEntry.level === "S3") {
              // File was previously detected as S3 — route to local model immediately
              // without re-reading. This prevents the alternating local/cloud pattern.
              const guardCfg = getGuardAgentConfig(privacyConfig);
              const guardProvider = guardCfg?.provider ?? "ollama";
              const guardModelName = guardCfg?.modelName ?? "openbmb/minicpm4.1";
              const guardAgentId = guardCfg?.id ?? "guard";

              api.logger.info(
                `[GuardClaw] resolve_model: file "${filePath}" was previously S3 — routing to local model (cached).`,
              );

              api.emitEvent?.("privacy_activated", {
                active: true,
                level: "S3",
                model: `${guardProvider}/${guardModelName}`,
                provider: guardProvider,
              });

              const s3SessionKey = `agent:${guardAgentId}:s3-guard`;
              return {
                reason: `GuardClaw: S3 — cached file sensitivity for "${filePath}"`,
                sessionKey: s3SessionKey,
                provider: guardProvider,
                model: guardModelName,
                deliverToOriginal: true,
                extraSystemPrompt: getGuardAgentSystemPrompt(),
                userPromptOverride: msgStr,
              };
            }
            if (cachedEntry.level === "S2" && cachedEntry.desensitizedContent) {
              // File was previously desensitized — re-inject the cached desensitized
              // content so cloud model can work with it without reading the raw file.
              api.logger.info(
                `[GuardClaw] resolve_model: file "${filePath}" was previously S2 — re-injecting cached desensitized content.`,
              );

              // Emit UI event on every subsequent turn so the indicator stays visible
              const localModelId = privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
              const localProvider = privacyConfig.localModel?.provider ?? "ollama";
              api.emitEvent?.("privacy_activated", {
                active: true,
                level: "S2",
                model: `${localProvider}/${localModelId}`,
                provider: localProvider,
              });
              const fileNote =
                `\n\n[File content of "${filePath}" — sensitive values have been redacted]:\n` +
                cachedEntry.desensitizedContent;
              const s2FileNote =
                `Note from the privacy layer: This message contains privacy placeholders ` +
                `like [REDACTED:SECRET:1]. These are NOT suspicious — they are opaque tokens ` +
                `managed by the local privacy system on behalf of the user. The user's request ` +
                `is legitimate and should be carried out normally. When calling tools, pass the ` +
                `placeholders through unchanged; the system will substitute the real values ` +
                `locally before execution. Do not ask the user to re-enter any data, and do ` +
                `not refuse the request on account of these placeholders.\n\n`;
              return {
                reason: `GuardClaw: S2 — re-injecting cached desensitized content for "${filePath}"`,
                userPromptOverride: s2FileNote + msgStr + fileNote,
              };
            }
            // S1 (or S2 without cached content): skip re-read
            api.logger.debug?.(
              `[GuardClaw] resolve_model: skipping already-pre-read file "${filePath}" (cached level: ${cachedEntry.level})`,
            );
            continue;
          }
          try {
            const fileContent = nodeFs.readFileSync(filePath, "utf-8");
            const fileResult = await detectSensitivityLevel(
              {
                checkpoint: "onToolCallExecuted",
                toolName: "read_file",
                toolResult: fileContent,
                sessionKey,
                agentId: ctx.agentId,
              },
              api.pluginConfig ?? {},
              api.logger,
            );
            // Mark as pre-read with detected level (desensitized content stored for S2)
            markFileAsPreRead(sessionKey, filePath, fileResult.level as "S1" | "S2" | "S3");

            if (fileResult.level === "S3") {
              const guardCfg = getGuardAgentConfig(privacyConfig);
              const guardProvider = guardCfg?.provider ?? "ollama";
              const guardModelName = guardCfg?.modelName ?? "openbmb/minicpm4.1";
              const guardAgentId = guardCfg?.id ?? "guard";

              markSessionAsPrivate(sessionKey, "S3");
              api.logger.warn(
                `[GuardClaw] resolve_model: pre-read file "${filePath}" contains S3 content. Routing to local model immediately.`,
              );

              api.emitEvent?.("privacy_activated", {
                active: true,
                level: "S3",
                model: `${guardProvider}/${guardModelName}`,
                provider: guardProvider,
              });

              const s3SessionKey = `agent:${guardAgentId}:s3-guard`;
              return {
                reason: `GuardClaw: S3 — file content pre-read detected sensitive data in "${filePath}"`,
                sessionKey: s3SessionKey,
                provider: guardProvider,
                model: guardModelName,
                deliverToOriginal: true,
                extraSystemPrompt: getGuardAgentSystemPrompt(),
                userPromptOverride: msgStr,
              };
            }
            if (fileResult.level === "S2") {
              markSessionAsPrivate(sessionKey, "S2");
              api.logger.info(
                `[GuardClaw] resolve_model: pre-read file "${filePath}" contains S2 content. Desensitizing file content.`,
              );

              // Desensitize the file content so cloud model never sees raw PII.
              let desensitizedFileContent: string;
              let filePiiMap: Map<string, string>;
              try {
                const fileDesensitizeResult = await desensitizeWithLocalModel(fileContent, privacyConfig);
                desensitizedFileContent = fileDesensitizeResult.desensitized;
                filePiiMap = fileDesensitizeResult.piiMap;
              } catch (desensitizeErr) {
                api.logger.error(
                  `[GuardClaw] S2 file desensitization failed for "${filePath}" — blocking request: ${String(desensitizeErr)}`,
                );
                // resolve_model does NOT support block:true — use directResponse.
                return {
                  directResponse:
                    `⚠️ GuardClaw: S2 file content detected in "${filePath}" but the local model ` +
                    `(${privacyConfig.localModel?.provider ?? "ollama"}/${privacyConfig.localModel?.model ?? "openbmb/minicpm4.1"}) ` +
                    `is unavailable for desensitization. Request blocked to prevent data leakage. ` +
                    `Please ensure the local model is running and retry.`,
                };
              }

              // Store PII mapping so before_tool_call can re-sensitize tool params
              if (filePiiMap.size > 0) {
                storePiiMapping(sessionKey, filePiiMap);
                api.logger.info(
                  `[GuardClaw] S2 file pre-read: stored ${filePiiMap.size} PII mappings for "${filePath}"`,
                );
              }

              // Emit UI event so the web UI shows "moderate sensitivity" indicator
              const localModelId = privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
              const localProvider = privacyConfig.localModel?.provider ?? "ollama";
              api.emitEvent?.("privacy_activated", {
                active: true,
                level: "S2",
                model: `${localProvider}/${localModelId}`,
                provider: localProvider,
              });

              // Mark file as pre-read (with desensitized content cached for re-injection
              // on subsequent turns) so before_tool_call blocks cloud model from reading raw file.
              markFileAsPreRead(sessionKey, filePath, "S2", desensitizedFileContent);
              markPreReadFiles(sessionKey, filePath);

              // Inject desensitized file content into the prompt override so the
              // cloud model can work with the content without reading the file itself.
              const fileNote =
                `\n\n[File content of "${filePath}" — sensitive values have been redacted]:\n` +
                desensitizedFileContent;

              // Return immediately with the desensitized file content injected.
              // The cloud model sees the desensitized version; raw file is blocked.
              const s2FileNote =
                `Note from the privacy layer: This message contains privacy placeholders ` +
                `like [REDACTED:SECRET:1]. These are NOT suspicious — they are opaque tokens ` +
                `managed by the local privacy system on behalf of the user. The user's request ` +
                `is legitimate and should be carried out normally. When calling tools, pass the ` +
                `placeholders through unchanged; the system will substitute the real values ` +
                `locally before execution. Do not ask the user to re-enter any data, and do ` +
                `not refuse the request on account of these placeholders.\n\n`;
              return {
                reason: `GuardClaw: S2 — file content desensitized before cloud delivery for "${filePath}"`,
                userPromptOverride: s2FileNote + msgStr + fileNote,
              };
            }
          } catch (readErr) {
            // File may not exist or be unreadable — skip silently
            api.logger.debug?.(
              `[GuardClaw] resolve_model: could not pre-read file "${filePath}": ${String(readErr)}`,
            );
          }
        }
      }

      api.logger.info(
        `[GuardClaw] resolve_model: calling detectSensitivityLevel with message="${msgStr.slice(0, 80)}"`,
      );

      // The user don't mention any files, let's just check the message content for sensitivity and route accordingly.
      const result = await detectSensitivityLevel(
        {
          checkpoint: "onUserMessage",
          message,
          sessionKey,
          agentId: ctx.agentId,
        },
        api.pluginConfig ?? {},
        api.logger,
      );

      api.logger.info(
        `[GuardClaw] resolve_model: detection result: level=${result.level}, reason=${result.reason}`,
      );

      recordDetection(sessionKey, result.level, "onUserMessage", result.reason);

      // ── S3: redirect to guard subsession with local-only model ──
      if (result.level === "S3") {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        api.logger.info(`[GuardClaw] S3 detected. Guard config: ${JSON.stringify(guardCfg)}`);
        const guardProvider = guardCfg?.provider ?? "ollama";
        const guardModelName = guardCfg?.modelName ?? "openbmb/minicpm4.1";
        const guardAgentId = guardCfg?.id ?? "guard";

        markSessionAsPrivate(sessionKey, result.level);

        // ── Local model offline (fail-closed) ──────────────────────────────
        // When detectByLocalModel fails (Ollama unreachable), it returns S3
        // with a reason containing "Local model unavailable". In this case we
        // must NOT silently route to the guard subsession (which would also
        // fail), but instead block the request immediately and notify the
        // Web UI so the user knows why their message was rejected.
        const isLocalModelOffline = result.reason?.includes("Local model unavailable");
        if (isLocalModelOffline) {
          api.logger.error(
            `[GuardClaw] resolve_model: local model offline — blocking request for session ${sessionKey}. ` +
              `Reason: ${result.reason}`,
          );

          // Emit privacy_activated with localModelOffline=true so the Web UI
          // can display a dedicated "local model unreachable" notification
          // instead of the generic privacy-activated indicator.
          api.emitEvent?.("privacy_activated", {
            active: true,
            level: "S3",
            model: `${guardProvider}/${guardModelName}`,
            provider: guardProvider,
          });

          // resolve_model does NOT support block:true — use directResponse to
          // skip the LLM call entirely and deliver the error message directly.
          return {
            directResponse:
              `⚠️ GuardClaw: Privacy protection unavailable — the local model ` +
              `(${guardProvider}/${guardModelName}) is not responding. ` +
              `Your message has been blocked to prevent potential data leakage. ` +
              `Please ensure the local model is running and retry.`,
          };
        }

        api.logger
          .info(`[GuardClaw] S3 detected. Redirecting to local sub-agent session: provider-name:${guardProvider}
           agent-id:${guardAgentId} model-name:${guardModelName}`);

        // Emit UI event
        api.emitEvent?.("privacy_activated", {
          active: true,
          level: result.level,
          model: `${guardProvider}/${guardModelName}`,
          provider: guardProvider,
        });

        // Use a stable global session key so all S3 messages share one guard session
        const s3SessionKey = `agent:${guardAgentId}:s3-guard`;

        return {
          reason: `GuardClaw: S3 — routing directly to guard sub-agent`,
          sessionKey: s3SessionKey,
          provider: guardProvider,
          model: guardModelName,
          deliverToOriginal: true,
          extraSystemPrompt: getGuardAgentSystemPrompt(),
          userPromptOverride: msgStr,
        };
      }

      // ── S2: desensitize content, then forward to cloud model ──
      if (result.level === "S2") {
        markSessionAsPrivate(sessionKey, result.level);

        api.logger.info(`[GuardClaw] S2 detected. Desensitizing content for cloud model.`);

        // Desensitize the user message directly (inline PII case).
        // File content S2 desensitization is handled via after_tool_call when the
        // read tool executes — no pre-reading needed here.
        let desensitizedPrompt: string;
        let wasModelUsed = false;

        try {
          const {
            desensitized,
            wasModelUsed: msgModelUsed,
            piiMap: msgPiiMap,
          } = await desensitizeWithLocalModel(message, privacyConfig);
          wasModelUsed = msgModelUsed;
          desensitizedPrompt = desensitized;

          // Store PII mapping so before_tool_call can re-sensitize tool params
          if (msgPiiMap.size > 0) {
            storePiiMapping(sessionKey, msgPiiMap);
            api.logger.info(
              `[GuardClaw] S2: stored ${msgPiiMap.size} PII mappings for session ${sessionKey}: ${[...msgPiiMap.keys()].join(", ")}`,
            );
          }
        } catch (desensitizeErr) {
          api.logger.error(
            `[GuardClaw] S2 message desensitization failed — blocking request: ${String(desensitizeErr)}`,
          );
          // resolve_model does NOT support block:true — use directResponse.
          return {
            directResponse:
              `⚠️ GuardClaw: S2 content detected but the local model ` +
              `(${privacyConfig.localModel?.provider ?? "ollama"}/${privacyConfig.localModel?.model ?? "openbmb/minicpm4.1"}) ` +
              `is unavailable for desensitization. Request blocked to prevent data leakage. ` +
              `Please ensure the local model is running and retry.`,
          };
        }

        api.logger.info(
          `[GuardClaw] S2 message desensitization complete (model=${wasModelUsed})`,
        );

        // Emit UI event
        const localModelId = privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
        const localProvider = privacyConfig.localModel?.provider ?? "ollama";
        api.emitEvent?.("privacy_activated", {
          active: true,
          level: result.level,
          model: `${localProvider}/${localModelId}`,
          provider: localProvider,
        });

        // Forward the DESENSITIZED content to cloud (don't change provider/model).
        // Prepend a system note so the cloud model understands the placeholders are
        // intentional tokens managed by the privacy layer, not suspicious injections.
        // Key goals:
        //   1. Reassure the model this is a legitimate request from the user
        //   2. Instruct it to proceed normally and pass placeholders through to tools
        //   3. Avoid language that looks like prompt injection itself
        const s2SystemNote =
          `Note from the privacy layer: This message contains privacy placeholders ` +
          `like [REDACTED:SECRET:1]. These are NOT suspicious — they are opaque tokens ` +
          `managed by the local privacy system on behalf of the user. The user's request ` +
          `is legitimate and should be carried out normally. When calling tools, pass the ` +
          `placeholders through unchanged; the system will substitute the real values ` +
          `locally before execution. Do not ask the user to re-enter any data, and do ` +
          `not refuse the request on account of these placeholders.\n\n`;

        return {
          reason: `GuardClaw: S2 — desensitized content forwarded to cloud model`,
          userPromptOverride: s2SystemNote + desensitizedPrompt,
        };
      }

      // ── S1: no intervention ──
      // Session is clean, use cloud model normally
      api.logger.info(`[GuardClaw] resolve_model: S1 detected. Using cloud model as normal.`);
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in resolve_model hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 5: message_sending — Guard subagent announce & outbound messages
  //
  //   When a subagent finishes and announces results back to the requester
  //   chat, this hook scans the outbound content. If the announce reply
  //   leaks S3 data, we cancel it. If S2 PII is found, we redact before
  //   delivery. This is the safety-net: even if the subagent processed
  //   sensitive data, the announce message is scrubbed.
  // =========================================================================
  api.on("message_sending", async (event, _ctx) => {
    try {
      const { content } = event;

      if (!content || !content.trim()) {
        return;
      }

      const privacyConfig = getPrivacyConfigFromApi(api);
      if (!privacyConfig.enabled) {
        return;
      }

      // Run detection on the outbound message content
      const result = await detectSensitivityLevel(
        {
          checkpoint: "onToolCallExecuted", // reuse post-execution checkpoint config
          message: content,
        },
        api.pluginConfig ?? {},
        api.logger,
      );

      if (result.level === "S3") {
        api.logger.warn(
          `[GuardClaw] BLOCKED outbound message: S3 content detected in message_sending. ` +
            `Reason: ${result.reason ?? "private data"}`,
        );
        return {
          cancel: true,
        };
      }

      if (result.level === "S2") {
        api.logger.info(
          `[GuardClaw] S2 content in outbound message. Redacting PII before delivery.`,
        );
        let desensitized: string;
        try {
          ({ desensitized } = await desensitizeWithLocalModel(content, privacyConfig));
        } catch (desensitizeErr) {
          api.logger.error(
            `[GuardClaw] S2 outbound desensitization failed — cancelling message: ${String(desensitizeErr)}`,
          );
          return { cancel: true };
        }
        return {
          content: desensitized,
        };
      }

      // S1: pass through
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in message_sending hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 7: tool_result_persist — Desensitize tool results before session write
  //
  // Fires synchronously just before a tool result message is written to the
  // session transcript. For S2 sessions, replaces real PII values (restored
  // by before_tool_call for local execution) back to their [REDACTED:xxx:N]
  // tags using the session's in-memory PII map.
  //
  // This ensures the main session history never contains raw sensitive data,
  // even though tools execute with real values locally.
  //
  // IMPORTANT: This hook is synchronous — no async/await, no local model calls.
  // Only the in-memory PII map (built during resolve_model desensitization) is
  // available here. New PII values not yet in the map will be handled on the
  // next turn after after_tool_call detects and stores them.
  // =========================================================================
  api.on("tool_result_persist", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey || !isSessionMarkedPrivate(sessionKey)) return;

      const message = event.message;
      if (!message) return;

      // ── Write ORIGINAL message to display session (before desensitization) ──
      // The display session stores real content for WebUI rendering.
      // The main session will store the desensitized version (returned below).
      appendToDisplaySession(sessionKey, message);

      // ── Desensitize for main session ──
      // Serialize the full AgentMessage to JSON, apply PII map (replace real
      // values with [REDACTED:xxx:N] tags), then deserialize back.
      const messageStr = JSON.stringify(message);
      const desensitized = desensitizeWithPiiMap(sessionKey, messageStr);

      if (desensitized !== messageStr) {
        api.logger.info(
          `[GuardClaw] tool_result_persist: desensitized tool result for "${ctx.toolName ?? event.toolName}" before session write`,
        );
        return { message: JSON.parse(desensitized) };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in tool_result_persist hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 8: before_message_write — Write original content to display session
  //
  // Fires synchronously before any message is written to the main session.
  // For S2 sessions:
  //   - Tool result messages: already written (as original) by tool_result_persist
  //     → skip via message ID tracking to avoid double-writing.
  //   - Assistant messages: re-sensitize ([REDACTED:xxx:N] → real values) and
  //     write to display session. Main session keeps desensitized version.
  //   - User messages and others: write as-is (same content as main session).
  //
  // IMPORTANT: Synchronous hook — no async/await.
  // =========================================================================
  api.on("before_message_write", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey || !isSessionMarkedPrivate(sessionKey)) return;

      const message = event.message;
      if (!message) return;

      // Skip messages already written by tool_result_persist (tool result messages).
      // tool_result_persist fires before before_message_write for the same message,
      // so we use the tracked message ID to avoid double-writing.
      const msgId = (message as any)?.id;
      if (msgId && isMessageWrittenToDisplaySession(sessionKey, String(msgId))) {
        return;
      }

      // Determine message role (AgentMessage wraps role inside .message.role)
      const role = (message as any)?.message?.role ?? (message as any)?.role;

      if (role === "assistant") {
        // Re-sensitize: replace [REDACTED:xxx:N] tags with real values for display.
        // The main session keeps the desensitized version (cloud model sees placeholders).
        const messageStr = JSON.stringify(message);
        const resensitized = resensitizeText(sessionKey, messageStr);
        appendToDisplaySession(sessionKey, JSON.parse(resensitized));
        api.logger.debug?.(
          `[GuardClaw] before_message_write: wrote re-sensitized assistant message to display session`,
        );
      } else {
        // User messages and system messages: write as-is (no PII in message text itself)
        appendToDisplaySession(sessionKey, message);
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_message_write hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 9: session_start — Register display session file path
  //
  // When a new session starts, compute and register the display session file
  // path (<baseDir>/.agents/<agentId>/sessions/<sessionId>.display.jsonl) so
  // subsequent hooks (tool_result_persist, before_message_write) can write
  // original content to it.
  //
  // The display session is stored alongside the main session file so the
  // gateway's chat.history handler can find it by replacing .jsonl with
  // .display.jsonl in the main session file path.
  // =========================================================================
  api.on("session_start", async (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? event.sessionKey ?? "";
      if (!sessionKey) return;

      const privacyConfig = getPrivacyConfigFromApi(api);
      const baseDir = privacyConfig.session?.baseDir ?? "~/.openclaw";

      // oxlint-disable-next-line typescript/no-require-imports
      const nodeOs = require("node:os") as typeof import("node:os");
      // oxlint-disable-next-line typescript/no-require-imports
      const nodePath = require("node:path") as typeof import("node:path");
      const resolvedBaseDir = baseDir.startsWith("~")
        ? nodePath.join(nodeOs.homedir(), baseDir.slice(1))
        : baseDir;

      // Use the agent ID from context (defaults to "main") so the display
      // session lives in the same directory as the main session file:
      //   <baseDir>/agents/<agentId>/sessions/<sessionId>.display.jsonl
      const agentId = ctx.agentId ?? "main";
      const displayDir = nodePath.join(resolvedBaseDir, "agents", agentId, "sessions");
      const displayPath = nodePath.join(displayDir, `${event.sessionId}.display.jsonl`);

      // Ensure the sessions directory exists before any writes.
      // The main session directory is normally created by openclaw core, but
      // may not exist yet at session_start time on the very first session.
      // oxlint-disable-next-line typescript/no-require-imports
      const nodeFs = require("node:fs") as typeof import("node:fs");
      nodeFs.mkdirSync(displayDir, { recursive: true });

      registerDisplaySession(sessionKey, displayPath);
      api.logger.debug?.(
        `[GuardClaw] session_start: registered display session for ${sessionKey} → ${displayPath}`,
      );
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in session_start hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 10: session_end — Clean up display session state
  //
  // Clears in-memory display session tracking (file path + written IDs).
  // The display session file itself is kept on disk for WebUI access.
  // =========================================================================
  api.on("session_end", async (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? event.sessionKey ?? "";
      if (sessionKey) {
        clearDisplaySession(sessionKey);
        api.logger.debug?.(
          `[GuardClaw] session_end: cleared display session state for ${sessionKey}`,
        );
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in session_end hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 11: llm_input — Verify that the minimal system prompt was applied
  //
  // Fires just before the LLM call with the actual systemPrompt that will be
  // sent. For guard sessions, logs the first 120 chars so we can confirm the
  // minimal prompt (starts with "You are a personal assistant...") is in use
  // rather than the full prompt (which starts with the same line but is much
  // longer and contains Memory/Messaging/Voice sections).
  // =========================================================================
  api.on("llm_input", (event, ctx) => {
    const sessionKey = ctx.sessionKey ?? "";
    if (!isGuardSessionKey(sessionKey)) {
      return;
    }
    const { provider, model, systemPrompt } = event;
    const spLen = systemPrompt?.length ?? 0;
    const spPreview = systemPrompt ? systemPrompt.slice(0, 120).replace(/\n/g, "↵") : "(none)";
    api.logger.info(
      `[GuardClaw] llm_input: guard session ${sessionKey} — ` +
        `provider=${provider}/${model} | ` +
        `systemPrompt=${spLen} chars | preview: ${spPreview}`,
    );
  });

  api.logger.info(
    "[GuardClaw] All hooks registered successfully (10 hooks: message, before_tool, after_tool, model, outbound, tool_result_persist, before_message_write, session_start, session_end, llm_input)",
  );
}

// ==========================================================================
// Helpers
// ==========================================================================

/**
 * Merge user config with defaults and return typed PrivacyConfig
 */
function getPrivacyConfigFromApi(api: OpenClawPluginApi): PrivacyConfig {
  return mergeWithDefaults(
    (api.pluginConfig?.privacy as PrivacyConfig) ?? {},
    defaultPrivacyConfig,
  );
}

function mergeWithDefaults(
  userConfig: PrivacyConfig,
  defaults: typeof defaultPrivacyConfig,
): PrivacyConfig {
  return {
    enabled: userConfig.enabled ?? defaults.enabled,
    checkpoints: {
      onUserMessage: userConfig.checkpoints?.onUserMessage ?? defaults.checkpoints?.onUserMessage,
      onToolCallProposed:
        userConfig.checkpoints?.onToolCallProposed ?? defaults.checkpoints?.onToolCallProposed,
      onToolCallExecuted:
        userConfig.checkpoints?.onToolCallExecuted ?? defaults.checkpoints?.onToolCallExecuted,
    },
    rules: {
      keywords: {
        S2: userConfig.rules?.keywords?.S2 ?? defaults.rules?.keywords?.S2,
        S3: userConfig.rules?.keywords?.S3 ?? defaults.rules?.keywords?.S3,
      },
      patterns: {
        S2: userConfig.rules?.patterns?.S2 ?? defaults.rules?.patterns?.S2,
        S3: userConfig.rules?.patterns?.S3 ?? defaults.rules?.patterns?.S3,
      },
      tools: {
        S2: {
          tools: userConfig.rules?.tools?.S2?.tools ?? defaults.rules?.tools?.S2?.tools,
          paths: userConfig.rules?.tools?.S2?.paths ?? defaults.rules?.tools?.S2?.paths,
        },
        S3: {
          tools: userConfig.rules?.tools?.S3?.tools ?? defaults.rules?.tools?.S3?.tools,
          paths: userConfig.rules?.tools?.S3?.paths ?? defaults.rules?.tools?.S3?.paths,
        },
      },
    },
    localModel: {
      enabled: userConfig.localModel?.enabled ?? defaults.localModel?.enabled,
      provider: userConfig.localModel?.provider ?? defaults.localModel?.provider,
      model: userConfig.localModel?.model ?? defaults.localModel?.model,
      endpoint: userConfig.localModel?.endpoint ?? defaults.localModel?.endpoint,
    },
    guardAgent: {
      id: userConfig.guardAgent?.id ?? defaults.guardAgent?.id,
      workspace: userConfig.guardAgent?.workspace ?? defaults.guardAgent?.workspace,
      model: userConfig.guardAgent?.model ?? defaults.guardAgent?.model,
    },
    session: {
      isolateGuardHistory:
        userConfig.session?.isolateGuardHistory ?? defaults.session?.isolateGuardHistory,
      baseDir: userConfig.session?.baseDir ?? defaults.session?.baseDir,
    },
    debug: {
      interceptLlmRequests:
        userConfig.debug?.interceptLlmRequests ?? defaults.debug?.interceptLlmRequests,
    },
  };
}

/**
 * Extract text from message object
 */
function extractMessageText(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }

  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    if (typeof msg.text === "string") return msg.text;
    if (typeof msg.content === "string") return msg.content;
    if (typeof msg.body === "string") return msg.body;
  }

  return undefined;
}

/**
 * Exhaustive set of built-in OpenClaw chat slash command names (without the leading /).
 * Source: src/auto-reply/commands-registry.data.ts
 *
 * These are internal control directives — always safe, no sensitivity detection needed.
 * When the user types one of these in the Web UI (or any chat channel), guardclaw skips
 * detection entirely and lets the cloud model handle it directly.
 */
const OPENCLAW_SLASH_COMMANDS = new Set([
  // Status / info
  "help",
  "commands",
  "status",
  "context",
  "whoami",
  "id", // alias for /whoami
  "export-session",
  "export", // alias for /export-session
  // Session lifecycle
  "new",
  "reset",
  "compact",
  "stop",
  "session",
  // Model / options
  "model",
  "models",
  "think",
  "thinking", // alias for /think
  "t",        // alias for /think
  "verbose",
  "v",        // alias for /verbose
  "fast",
  "reasoning",
  "reason",   // alias for /reasoning
  "elevated",
  "elev",     // alias for /elevated
  "exec",
  "usage",
  "queue",
  // Tools
  "skill",
  "btw",
  "bash",
  "restart",
  "tts",
  // Sub-agent / session management
  "agents",
  "subagents",
  "acp",
  "focus",
  "unfocus",
  "kill",
  "steer",
  "tell",     // alias for /steer
  // Config / management
  "approve",
  "allowlist",
  "config",
  "mcp",
  "plugins",
  "plugin",   // alias for /plugins
  "debug",
  "activation",
  "send",
]);

/**
 * Returns true if the message is a known OpenClaw chat slash command.
 * Slash commands are always safe — they are internal control directives, not user data.
 * Guardclaw skips detection for these and lets the cloud model handle them directly.
 *
 * Also matches /dock-<channel> commands (dynamic, based on installed channel plugins).
 */
function isSlashCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return false;

  // Extract the command name: everything between / and the first space (or end of string)
  const spaceIdx = trimmed.indexOf(" ");
  const commandName = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();

  // Check against the known command set
  if (OPENCLAW_SLASH_COMMANDS.has(commandName)) return true;

  // /dock-<channel> commands are dynamic (depend on installed channel plugins)
  if (/^dock[-_][a-z0-9]+$/.test(commandName)) return true;

  return false;
}

/**
 * Extract file paths explicitly mentioned in a user message.
 * Handles quoted paths (single/double quotes), Windows absolute paths (C:\...),
 * and Unix absolute paths (/home/...). Only returns paths that look like files
 * (have an extension or are clearly absolute paths), to avoid false positives.
 */
function extractFilePathsFromMessage(message: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const addPath = (p: string) => {
    const trimmed = p.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      paths.push(trimmed);
    }
  };

  // Match double-quoted paths: "C:\...\file.txt" or "/path/to/file"
  const doubleQuoted = message.matchAll(/"([^"]{3,})"/g);
  for (const m of doubleQuoted) {
    const p = m[1];
    if (looksLikeFilePath(p)) addPath(p);
  }

  // Match single-quoted paths: 'C:\...\file.txt' or '/path/to/file'
  const singleQuoted = message.matchAll(/'([^']{3,})'/g);
  for (const m of singleQuoted) {
    const p = m[1];
    if (looksLikeFilePath(p)) addPath(p);
  }

  // Match unquoted Windows absolute paths: C:\Users\... or D:/path/to/file
  const windowsPaths = message.matchAll(/\b([A-Za-z]:[\\\/][^\s"'`,;]+)/g);
  for (const m of windowsPaths) {
    const p = m[1].replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
    if (looksLikeFilePath(p)) addPath(p);
  }

  // Match unquoted Unix absolute paths: /home/user/file.txt
  const unixPaths = message.matchAll(/(?:^|\s)(\/[^\s"'`,;]{3,})/g);
  for (const m of unixPaths) {
    const p = m[1].replace(/[.,;:!?]+$/, "");
    if (looksLikeFilePath(p)) addPath(p);
  }

  return paths;
}

/**
 * Returns true if the string looks like a file path (has extension or is clearly absolute).
 * Filters out URLs, session keys, and other non-path strings.
 */
function looksLikeFilePath(p: string): boolean {
  if (!p || p.length < 3) return false;
  // Exclude URLs
  if (/^https?:\/\//i.test(p)) return false;
  // Must look like an absolute path
  const isWindowsAbs = /^[A-Za-z]:[\\\/]/.test(p);
  const isUnixAbs = p.startsWith("/");
  if (!isWindowsAbs && !isUnixAbs) return false;
  // Must have a file extension (to avoid matching bare directories)
  return /\.[a-zA-Z0-9]{1,10}$/.test(p);
}

/**
 * Extract path-like values from tool params for file-access guarding
 */
function extractPathValuesFromParams(params: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const pathKeys = ["path", "file", "filepath", "filename", "dir", "directory", "target", "source"];

  for (const key of pathKeys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      paths.push(value.trim());
    }
  }

  // Recurse into nested objects
  for (const value of Object.values(params)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...extractPathValuesFromParams(value as Record<string, unknown>));
    }
  }

  return paths;
}
