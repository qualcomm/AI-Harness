/**
 * dragon-router hooks.
 *
 * before_agent_reply is the pre-agent gate (runs BEFORE the agent, so it can
 * short-circuit with a synthetic reply and skip the LLM entirely):
 *   - detect privacy level (S1/S2/S3)
 *   - S3 → HIGH SENSITIVITY: run the prompt to completion in an isolated child
 *     session (fixed local S3 model, no cloud escape hatch) and reply with its
 *     result. The child session's transcript is never part of the main
 *     session's history, so it can never be replayed into a later cloud
 *     request from this session (see s3-isolation.ts for the rationale).
 *   - S1/S2 → cache the level so before_model_resolve reuses it (no re-detect).
 *
 * before_model_resolve is the routing point (runs inside the agent, can override
 * provider/model but cannot emit a reply):
 *   - S1 → classify complexity, route to the matching cloud model (direct)
 *   - S2 → desensitize (reversible), route via local proxy, re-sensitize response
 *   - S3 → fail-safe fallback only (before_agent_reply normally handles S3).
 *
 * before_prompt_build injects the desensitized S2 text (marker-wrapped).
 * message_sending re-sensitizes the final message as a fallback.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { classifyComplexity } from "./complexity-classifier.js";
import { desensitize } from "./desensitizer.js";
import { clearPiiMap, getPiiMap, reSensitize, setPiiMap } from "./pii-map-store.js";
import { detectPrivacyLevel } from "./privacy-detector.js";
import { PROXY_PROVIDER_ID } from "./provider.js";
import { S2_CLOSE, S2_OPEN } from "./proxy.js";
import { decideS1, decideS3, targetForTier } from "./router-decision.js";
import { isS3ChildSession, runIsolatedS3 } from "./s3-isolation.js";
import { stripInboundMeta } from "./strip-meta.js";
import { checkToolParamsS3, isOutboundTool } from "./tool-guard.js";
import type { DragonRouterConfig, PrivacyLevel, RouteDecision } from "./types.js";

/**
 * Per-session pending state for prompt-build / message-sending.
 * - desensitizedPrompt: S2 marker-wrapped text for the proxy.
 * - localPrompt: S3 detector-inconsistency fail-safe only (see before_model_resolve) —
 *   the current prompt re-injected verbatim for a fully-local, non-isolated run.
 */
type Pending = { decision: RouteDecision; desensitizedPrompt?: string; localPrompt?: string };
const pending = new Map<string, Pending>();

/**
 * Level detected in before_agent_reply, handed to before_model_resolve so it does
 * not re-query the local model. Only set for S1/S2 (S3 short-circuits earlier).
 */
const levelCache = new Map<string, PrivacyLevel>();

/** Shown when the isolated S3 run fails — never fall through to normal routing. */
const S3_ISOLATED_FAILURE_TEXT =
  "⚠️ This message looked highly sensitive (S3) and could not be processed safely on the local model. Please try again.";

/**
 * Internal/derived agent runs use a `temp:` session-key prefix (e.g.
 * `temp:slug-generator`, spawned when OpenClaw's session-memory hook archives a
 * session on /new or /reset). These are housekeeping LLM calls, not user turns —
 * dragon-router must not classify, route, or desensitize them.
 *
 * S3-isolated child sessions (see s3-isolation.ts) must also be skipped: they
 * are dragon-router's own spawned runs, and re-classifying their turn would
 * recursively re-detect S3 and spawn an unbounded chain of grandchild sessions.
 */
function isInternalSession(sessionKey: string): boolean {
  return sessionKey.startsWith("temp:") || isS3ChildSession(sessionKey);
}

export function registerHooks(api: OpenClawPluginApi, config: DragonRouterConfig): void {
  /**
   * Route `text` through the full S2 pipeline: desensitize → classify complexity
   * → proxy provider, stashing the desensitized text for before_prompt_build to
   * inject (marker-wrapped). Returns the model override.
   */
  async function routeAsS2(sessionKey: string, text: string, tag: string) {
    const desen = await desensitize(config.localModel, sessionKey, text);
    if (desen.failed) {
      // Local model down → cannot safely desensitize → keep fully local, direct
      // (not isolated — before_model_resolve cannot emit a synthetic reply, so
      // this fail-safe just keeps the CURRENT turn off the cloud). Stash the raw
      // text as localPrompt so before_prompt_build injects it.
      const s3 = decideS3(config);
      pending.set(sessionKey, {
        decision: { ...s3, reason: `${tag} desensitize failed → local` },
        localPrompt: text,
      });
      api.logger.warn(`[dragon-router] ${tag} desensitize failed — routing local for safety`);
      return { providerOverride: s3.target.provider, modelOverride: s3.target.model };
    }

    setPiiMap(sessionKey, desen.items);
    const tier = await classifyComplexity(config.localModel, desen.desensitized, config.cacheTtlMs);
    const target = targetForTier(config, tier);
    const decision: RouteDecision = {
      level: "S2",
      tier,
      target,
      viaProxy: true,
      reason: `${tag} tier=${tier} (${desen.items.length} PII redacted)`,
    };
    pending.set(sessionKey, { decision, desensitizedPrompt: desen.desensitized });
    api.logger.info(
      `[dragon-router] ${tag} tier=${tier} → proxy → ${target.provider}/${target.model} (${desen.items.length} PII)`,
    );
    return { providerOverride: PROXY_PROVIDER_ID, modelOverride: target.model };
  }

  // ── Pre-agent gate: detect privacy BEFORE the LLM runs, so S3 can short-circuit
  //    with a synthetic reply and skip the model entirely. ──
  api.on("before_agent_reply", async (event: { cleanedBody?: string }, ctx: { sessionKey?: string }) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      const rawPrompt = typeof event.cleanedBody === "string" ? event.cleanedBody : "";
      if (!rawPrompt.trim()) return;
      if (isInternalSession(sessionKey)) return;

      const prompt = stripInboundMeta(rawPrompt);
      if (!prompt.trim()) return;

      const level = await detectPrivacyLevel(config.localModel, prompt, config.cacheTtlMs);
      api.logger.info(`[dragon-router] session=${sessionKey} privacy=${level}`);

      if (level === "S3") {
        // Highly sensitive: run to completion in an isolated child session
        // (fixed local S3 model, no cloud) and reply with its result. Nothing
        // about this turn — prompt or reply — ever enters THIS session's
        // transcript, so it can never be replayed into a later cloud request.
        levelCache.delete(sessionKey);
        api.logger.info("[dragon-router] S3 detected — running in isolated child session");
        try {
          const replyText = await runIsolatedS3(api, config, sessionKey, prompt);
          return { handled: true, reply: { text: replyText } };
        } catch (isolatedErr) {
          api.logger.error(`[dragon-router] S3 isolated run failed: ${String(isolatedErr)}`);
          return { handled: true, reply: { text: S3_ISOLATED_FAILURE_TEXT } };
        }
      }

      // S1/S2: cache the level so before_model_resolve reuses it (no re-detect).
      levelCache.set(sessionKey, level);
    } catch (err) {
      api.logger.error(`[dragon-router] before_agent_reply error: ${String(err)}`);
    }
  });

  api.on("before_model_resolve", async (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      const rawPrompt = typeof event.prompt === "string" ? event.prompt : "";
      if (!rawPrompt.trim()) return;

      // Skip internal/derived runs (e.g. temp:slug-generator from /new archiving,
      // or dragon-router's own S3-isolated child sessions).
      if (isInternalSession(sessionKey)) {
        api.logger.info(`[dragon-router] session=${sessionKey} skip internal session`);
        return;
      }

      // Strip OpenClaw-injected inbound metadata (Sender/Conversation blocks,
      // timestamp prefix) so the local classifier/extractor sees only the user's
      // real text — the noise otherwise derails small local models.
      const prompt = stripInboundMeta(rawPrompt);
      if (!prompt.trim()) return;

      // Reuse the level detected in before_agent_reply; re-detect only if missing.
      let level = levelCache.get(sessionKey);
      levelCache.delete(sessionKey);
      if (!level) {
        level = await detectPrivacyLevel(config.localModel, prompt, config.cacheTtlMs);
        api.logger.info(`[dragon-router] session=${sessionKey} privacy=${level} (re-detect)`);
      }

      // ③ S3 normally short-circuits in before_agent_reply; if we still see it here
      //    (edge case), fail safe to local, direct (not isolated — this hook can't
      //    emit a synthetic reply, so isolation isn't available at this point).
      if (level === "S3") {
        const decision = decideS3(config);
        pending.set(sessionKey, { decision, localPrompt: prompt });
        api.logger.info(
          `[dragon-router] S3 → local ${decision.target.provider}/${decision.target.model}`,
        );
        return {
          providerOverride: decision.target.provider,
          modelOverride: decision.target.model,
        };
      }

      // ② S1: complexity → cloud model (direct, no proxy).
      if (level === "S1") {
        const decision = await decideS1(config, prompt);
        pending.set(sessionKey, { decision });
        api.logger.info(
          `[dragon-router] S1 tier=${decision.tier} → ${decision.target.provider}/${decision.target.model}`,
        );
        return {
          providerOverride: decision.target.provider,
          modelOverride: decision.target.model,
        };
      }

      // ④ S2: reversible desensitize → complexity(on clean text) → proxy route.
      return routeAsS2(sessionKey, prompt, "S2");
    } catch (err) {
      api.logger.error(`[dragon-router] before_model_resolve error: ${String(err)}`);
    }
  });

  // Inject the task text for turns before_model_resolve stashed context for:
  //  - S2: desensitized text, marker-wrapped so the proxy keeps only it.
  //  - S3 (fail-safe edge case only): the raw task text verbatim.
  api.on("before_prompt_build", (_event: unknown, ctx: { sessionKey?: string }) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      const p = pending.get(sessionKey);
      if (!p) return undefined;
      if (p.decision.level === "S2" && p.desensitizedPrompt) {
        return { prependContext: `${S2_OPEN}\n${p.desensitizedPrompt}\n${S2_CLOSE}` };
      }
      if (p.decision.level === "S3" && p.localPrompt) {
        return { prependContext: p.localPrompt };
      }
      return undefined;
    } catch (err) {
      api.logger.error(`[dragon-router] before_prompt_build error: ${String(err)}`);
      return undefined;
    }
  });

  // ── Tool-call guard: block sensitive data from leaving the device via an
  //    OUTBOUND tool (network/shell/external), in any S3 session — the isolated
  //    S3 child session (its own turns route through this same hook registry)
  //    and the rare direct-S3 fail-safe edge case above. ──
  //    - Local-only tools (write/read/edit/ls…) never leave the device → not guarded.
  //    - S1/S2 sessions are not highly sensitive → not guarded here (S2 PII is
  //      handled by desensitization on the proxy path instead).
  api.on(
    "before_tool_call",
    (event: { toolName: string; params?: unknown }, ctx: { sessionKey?: string }) => {
      try {
        const sessionKey = ctx.sessionKey ?? "";
        // Guard S3-isolated child sessions unconditionally, and the main session
        // only when THIS turn was routed as S3 (the direct fail-safe edge case).
        if (!isS3ChildSession(sessionKey) && pending.get(sessionKey)?.decision.level !== "S3") {
          return undefined;
        }
        // Only guard tools that can actually exfiltrate data off-device.
        if (!isOutboundTool(event.toolName)) return undefined;

        const params = (event.params ?? {}) as Record<string, unknown>;
        const reason = checkToolParamsS3(params);
        if (reason) {
          api.logger.warn(
            `[dragon-router] S3 outbound tool "${event.toolName}" blocked — ${reason}`,
          );
          return {
            block: true,
            blockReason: `dragon-router: tool "${event.toolName}" blocked — ${reason}`,
          };
        }
        return undefined;
      } catch (err) {
        api.logger.error(`[dragon-router] before_tool_call error: ${String(err)}`);
        return undefined;
      }
    },
  );

  // Fallback re-sensitization on the outbound message (complete text, no SSE splits).
  // Runs whenever the session has a PII map — covers both S2 user-message PII
  // AND tool-result PII that can occur even in an otherwise-S1 session.
  api.on("message_sending", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      const hasMap = getPiiMap(sessionKey)?.length;
      if (!hasMap) return;
      const content = typeof event.content === "string" ? event.content : "";
      if (!content) return;
      const restored = reSensitize(sessionKey, content);
      // Turn done — clear the map so PII doesn't linger.
      clearPiiMap(sessionKey);
      pending.delete(sessionKey);
      if (restored !== content) {
        api.logger.info("[dragon-router] re-sensitized outbound message");
        return { content: restored };
      }
    } catch (err) {
      api.logger.error(`[dragon-router] message_sending error: ${String(err)}`);
    }
  });
}
