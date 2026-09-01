import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { dragonTaskOrchestratorConfigSchema, resolveConfig } from "./src/config-schema.js";
import { getDelegationMeta } from "./src/delegation-meta.js";
import { registerHooks } from "./src/hooks.js";
import { callLocalModel } from "./src/local-model.js";
import { logInfo } from "./src/log.js";
import {
  clearSessionsUsingPipeline,
  getSessionMode,
  setSessionMode,
  type SessionMode,
} from "./src/mission-mode.js";
import {
  deletePipeline,
  getPipeline,
  initPipelineStore,
  listPipelines,
  runSerializedWrite,
  upsertPipeline,
  type PipelineStep,
} from "./src/pipeline-store.js";
import { sendChannelNotice, type NotifyApi } from "./src/notify.js";
import { resolvePendingApproval, type PrdDecision } from "./src/prd-approval.js";
import { emitSubtaskToolEvent, summarizeToolPayload } from "./src/progress-event.js";
import { INTERNAL_AGENT_IDS, isSubtaskDelegationKey } from "./src/session-key.js";

/**
 * Gateway method the Control UI calls to answer a PRD confirmation.
 *
 * A plugin-owned method rather than the host's `plugin.approval.*` flow: that
 * flow caps `description` at 256 chars (too small for a decomposition) and its
 * decisions are limited to allow/deny, so it cannot carry an adjustment request.
 */
const PRD_RESOLVE_METHOD = "dragonTaskOrchestrator.prd.resolve";
/**
 * Per-session mode. Renamed from `mission.*` when the boolean became a three-way
 * choice — the old name would have described only one of the three modes. Both methods
 * are self-registered and only this plugin's own UI calls them, so there is no external
 * consumer to keep compatible.
 */
const MODE_GET_METHOD = "dragonTaskOrchestrator.session.mode.get";
const MODE_SET_METHOD = "dragonTaskOrchestrator.session.mode.set";
/** Fixed-pipeline CRUD. Registered unconditionally: the UI needs them to build one. */
const PIPELINES_LIST_METHOD = "dragonTaskOrchestrator.pipelines.list";
const PIPELINES_SAVE_METHOD = "dragonTaskOrchestrator.pipelines.save";
const PIPELINES_DELETE_METHOD = "dragonTaskOrchestrator.pipelines.delete";

function isPrdDecision(value: unknown): value is PrdDecision {
  return value === "confirm" || value === "cancel" || value === "adjust";
}

/**
 * Resolve a tool-hook context to the subtask it belongs to, or null when the call
 * has nothing to do with this plugin.
 *
 * Two gates, in this order: the session key must carry this plugin's delegation
 * marker (cheap, and it is transport-set so a model cannot forge it), and the
 * process-local metadata must say which subtask that session is currently serving.
 * A metadata miss (different process — see delegation-meta.ts) simply means no
 * activity is reported, which is the correct degradation for a display feature.
 */
function resolveSubtaskContext(
  sessionKey: string | undefined,
): { rootSessionKey: string; subtaskId: number; agentId: string; role: "work" | "verify" } | null {
  if (!isSubtaskDelegationKey(sessionKey)) return null;
  const meta = getDelegationMeta(sessionKey);
  if (!meta || meta.subtaskId === undefined) return null;
  return {
    rootSessionKey: meta.rootSessionKey,
    subtaskId: meta.subtaskId,
    agentId: meta.hintedAgentId,
    role: meta.role ?? "work",
  };
}


const plugin = {
  id: "dragon-task-orchestrator",
  name: "Dragon Task Orchestrator",
  description:
    "Dynamic task decomposition and delegation (mode C): splits composite requests into subtasks at runtime, routes each to a matching agent, executes in dependency layers, and summarizes into one reply.",
  version: "2026.7.30",
  configSchema: dragonTaskOrchestratorConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    if (!cfg.enabled) {
      // toggle: the hook is never registered when disabled
      return;
    }

    const agentList = () => api.config.agents?.list ?? [];

    registerHooks(api, {
      cfg,
      getKnownAgentIds: () => {
        const ids = agentList()
          .map((a: { id?: string }) => a.id?.trim())
          // `!!id` rather than `Boolean(id)`: the latter is an opaque call that
          // does not narrow, leaving `id` as `string | undefined` for the
          // INTERNAL_AGENT_IDS lookup.
          .filter((id): id is string => !!id && !INTERNAL_AGENT_IDS.has(id));
        return new Set(ids);
      },
      // Priority: the plugin's own agentDescriptions, then the borrowed
      // systemPromptOverride, then (in formatKnownDomains) the bare id.
      //
      // The plugin-local map exists because the host's `agents.list` has no
      // description field, and an override is a full persona instruction: its
      // first MAX_DOMAIN_DESCRIPTION_CHARS are frequently generic boilerplate
      // ("你是一个严谨的助手，回答时请...") with the actual domain buried later or
      // absent, leaving the classifier to guess from the id — the very thing
      // attaching descriptions was meant to avoid. Borrowing is kept as the
      // fallback so agents with no entry behave exactly as before.
      //
      // INTERNAL_AGENT_IDS are excluded from both maps: those entries exist only
      // to carry this plugin's own system prompt overrides and have no tools, so
      // offering one as a routable domain would send a real subtask to an agent
      // that cannot possibly perform it.
      getAgentDescriptions: () => {
        const map = new Map<string, string>();
        for (const a of agentList() as Array<{ id?: string; systemPromptOverride?: string }>) {
          const id = a.id?.trim();
          if (!id || INTERNAL_AGENT_IDS.has(id)) continue;
          const configured = cfg.agentDescriptions[id]?.trim();
          const desc = configured || a.systemPromptOverride?.trim();
          if (desc) map.set(id, desc);
        }
        return map;
      },
      getSubagent: () => api.runtime.subagent,
      // `before_agent_reply` can only pass through or short-circuit with a
      // synthetic reply — there is no host API to "run agentId's real pipeline
      // (persona/tools/system prompt) and hand back the text". runLocally must
      // short-circuit (see hooks.ts), so it cannot invoke the target agent's
      // actual tools; it approximates the target's voice using that agent's own
      // `systemPromptOverride` from the host's `agents.list` config (not a
      // plugin-local setting), falling back to no system prompt when the agent
      // has none configured.
      runLocally: async (prompt: string, agentId: string) => {
        const entry = agentList().find((a: { id?: string }) => a.id?.trim() === agentId);
        const systemPrompt = entry?.systemPromptOverride ?? "";
        return await callLocalModel(cfg.localModel, systemPrompt, prompt);
      },
      // Read at request time, not captured: a pipeline can be edited or deleted between
      // the session selecting it and the next turn arriving.
      getPipeline: (id: string) => getPipeline(id),
      // Out-of-band PRD/progress delivery. `before_agent_reply` can only return one
      // reply, so these notices go straight out through the channel adapter instead
      // (see src/notify.ts). Strictly best-effort: the final summarized reply stays
      // the only guaranteed delivery, and it remains self-contained either way.
      notify: (sessionKey: string, agentId: string, text: string) =>
        sendChannelNotice(api as unknown as NotifyApi, sessionKey, agentId, text),
      // The Control UI's other half: webchat is an internal channel that the
      // outbound adapter above cannot reach, so the same updates are also
      // broadcast as gateway plugin events (see src/progress-event.ts).
      emitEvent: (eventType: string, payload: Record<string, unknown>) =>
        api.emitEvent?.(eventType, payload),
      logger: api.logger,
    });

    // Relay a subtask's tool activity into the orchestrator card. The host already
    // broadcasts these on the CHILD session, but the Control UI drops tool events
    // for sessions it is not viewing (app-tool-stream.ts), so from the root session
    // — where the user actually is — subtask execution looks like a black box.
    //
    // Both handlers are wrapped: this is decoration on top of the real work, so a
    // throw here must never fail the tool call that triggered it.
    api.on("before_tool_call", (event, ctx) => {
      try {
        const target = resolveSubtaskContext(ctx.sessionKey);
        if (!target) return;
        emitSubtaskToolEvent(
          (eventType, payload) => api.emitEvent?.(eventType, payload),
          {
            ...target,
            toolName: ctx.toolName,
            phase: "start",
            summary: summarizeToolPayload(event.params),
          },
          api.logger,
        );
      } catch {
        /* activity reporting must not break the tool call */
      }
    });

    api.on("after_tool_call", (event, ctx) => {
      try {
        const target = resolveSubtaskContext(ctx.sessionKey);
        if (!target) return;
        emitSubtaskToolEvent(
          (eventType, payload) => api.emitEvent?.(eventType, payload),
          {
            ...target,
            toolName: ctx.toolName,
            phase: "result",
            summary: event.error ? undefined : summarizeToolPayload(event.result),
            error: event.error,
          },
          api.logger,
        );
      } catch {
        /* same rule */
      }
    });

    // Only registered when the gate is on: an unused RPC surface is one more thing
    // reachable from a connected client for no benefit.
    if (cfg.prdConfirmation.enabled) {
      api.registerGatewayMethod(PRD_RESOLVE_METHOD, async ({ params, respond }) => {
        const approvalId = typeof params.approvalId === "string" ? params.approvalId.trim() : "";
        const decision = params.decision;
        const adjustment = typeof params.adjustment === "string" ? params.adjustment.trim() : "";
        if (!approvalId || !isPrdDecision(decision)) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid approvalId/decision" });
          return;
        }
        // An "adjust" with nothing to adjust would re-run the decomposer with no new
        // information and show the same plan again.
        if (decision === "adjust" && !adjustment) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "adjustment text is required for decision \"adjust\"",
          });
          return;
        }
        const matched = resolvePendingApproval(approvalId, {
          decision,
          ...(adjustment ? { adjustment } : {}),
        });
        // Reported rather than silently accepted, so a card left open past the
        // timeout tells the operator instead of appearing to work.
        if (!matched) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "unknown or already-answered confirmation",
          });
          return;
        }
        respond(true, { ok: true }, undefined);
      });
    }

    // The pipeline store needs `stateDir`, which `register(api)` does not provide —
    // only `OpenClawPluginServiceContext` does. A minimal service exists purely to
    // receive it. Registered before the gateway methods so the store is loaded by the
    // time any of them can be called.
    api.registerService({
      id: "dragon-task-orchestrator-pipelines",
      start: (ctx) => {
        initPipelineStore(ctx.stateDir, api.logger);
        const { pipelines } = listPipelines();
        logInfo(cfg.logging, api.logger, `loaded ${pipelines.length} fixed pipeline(s)`);
      },
    });

    /** Live, non-internal agent ids — the only valid targets for a pipeline step. */
    const knownAgentIds = () =>
      new Set(
        agentList()
          .map((a: { id?: string }) => a.id?.trim())
          .filter((id): id is string => !!id && !INTERNAL_AGENT_IDS.has(id)),
      );

    function parseSteps(value: unknown): PipelineStep[] | null {
      if (!Array.isArray(value)) return null;
      const steps: PipelineStep[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const record = entry as Record<string, unknown>;
        if (typeof record.agentId !== "string") return null;
        steps.push({
          agentId: record.agentId,
          // An absent instruction is allowed (the agent falls back to its own prompt),
          // but a non-string one is a client bug worth rejecting rather than coercing.
          instruction: record.instruction === undefined ? "" : String(record.instruction),
        });
      }
      return steps;
    }

    // The session's mode is per session, defaults to `off`, and is not persisted, so the
    // UI cannot infer it from config — it reads it back on every session switch. A
    // gateway restart clears the store, and this is what lets the selector re-sync
    // instead of showing a stale mode.
    api.registerGatewayMethod(MODE_GET_METHOD, async ({ params, respond }) => {
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
      if (!sessionKey) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "sessionKey is required" });
        return;
      }
      respond(true, { sessionKey, mode: getSessionMode(sessionKey) }, undefined);
    });

    api.registerGatewayMethod(MODE_SET_METHOD, async ({ params, respond }) => {
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
      const rawMode = params.mode as Record<string, unknown> | undefined;
      const kind = typeof rawMode?.kind === "string" ? rawMode.kind : "";
      if (!sessionKey || (kind !== "off" && kind !== "dynamic" && kind !== "pipeline")) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: 'sessionKey and mode.kind ("off" | "dynamic" | "pipeline") are required',
        });
        return;
      }
      let mode: SessionMode;
      if (kind === "pipeline") {
        const pipelineId =
          typeof rawMode?.pipelineId === "string" ? rawMode.pipelineId.trim() : "";
        // Verified to exist before it is stored: a session pointing at a deleted
        // pipeline would silently fall through to the ordinary reply path, which looks
        // to the operator like the selector did nothing.
        if (!pipelineId || !getPipeline(pipelineId)) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "pipelineId is required and must reference an existing pipeline",
          });
          return;
        }
        mode = { kind: "pipeline", pipelineId };
      } else {
        mode = { kind };
      }
      setSessionMode(sessionKey, mode);
      logInfo(cfg.logging, api.logger, `session mode set to ${kind} on ${sessionKey}`);
      // Echo what the store actually holds rather than the request, so the UI can never
      // render a mode the plugin does not agree with.
      respond(true, { sessionKey, mode: getSessionMode(sessionKey) }, undefined);
    });

    api.registerGatewayMethod(PIPELINES_LIST_METHOD, async ({ respond }) => {
      respond(true, listPipelines(), undefined);
    });

    // Every write echoes the full list back, so the UI never has to reconcile local
    // state with the server's. `baseRevision` is the optimistic lock; the store also
    // serializes writes internally, since two callers can both pass the revision check
    // before either has written.
    api.registerGatewayMethod(PIPELINES_SAVE_METHOD, async ({ params, respond }) => {
      const baseRevision = typeof params.baseRevision === "number" ? params.baseRevision : NaN;
      const name = typeof params.name === "string" ? params.name : "";
      const id = typeof params.id === "string" && params.id.trim() ? params.id.trim() : undefined;
      const steps = parseSteps(params.steps);
      if (!Number.isFinite(baseRevision) || steps === null) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "baseRevision (number) and steps (array) are required",
        });
        return;
      }
      const result = await runSerializedWrite(() =>
        upsertPipeline({ baseRevision, id, name, steps, knownAgentIds: knownAgentIds() }),
      );
      respond(true, result, undefined);
    });

    api.registerGatewayMethod(PIPELINES_DELETE_METHOD, async ({ params, respond }) => {
      const baseRevision = typeof params.baseRevision === "number" ? params.baseRevision : NaN;
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!Number.isFinite(baseRevision) || !id) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "baseRevision (number) and id (string) are required",
        });
        return;
      }
      const result = await runSerializedWrite(() => deletePipeline({ baseRevision, id }));
      if (result.ok) {
        // Sessions still selecting it would keep a dangling reference. hooks.ts already
        // passes those turns through, but leaving the selection would show the operator
        // a pipeline that no longer exists.
        const cleared = clearSessionsUsingPipeline(id);
        if (cleared > 0) {
          logInfo(cfg.logging, api.logger, `cleared ${cleared} session(s) using deleted ${id}`);
        }
      }
      respond(true, result, undefined);
    });

    api.logger.info("[dragon-task-orchestrator] hooks registered");
  },
};

export default plugin;
