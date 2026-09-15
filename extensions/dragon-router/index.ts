import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { dragonRouterConfigSchema, resolveConfig } from "./src/config-schema.js";
import { registerHooks } from "./src/hooks.js";
import { buildMirror, PROXY_PROVIDER_ID } from "./src/provider.js";
import { startProxy, type ProxyHandle } from "./src/proxy.js";
import { createToolResultDesensitizeMiddleware } from "./src/tool-result-desensitize.js";

export default definePluginEntry({
  id: "dragon-router",
  name: "DragonRouter",
  description:
    "Privacy-aware + complexity-based model router (S1/S2/S3 detection, complexity routing, reversible S2 desensitization)",
  configSchema: dragonRouterConfigSchema,

  register(api: OpenClawPluginApi) {
    // Check registration mode
    if (api.registrationMode !== "full") {
      return;
    }

    // Resolve config
    const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    if (!config.enabled) {
      // Judge whether the plugin is enabled or not.
      api.logger.info("[dragon-router] disabled via config");
      return;
    }

    api.logger.info(
      `[dragon-router] init — localModel=${config.localModel.api}/${config.localModel.model} @ ${config.localModel.endpoint}`,
    );

    // ── Virtual provider for S2 proxy traffic ──
    const openclawConfig = api.config as {
      models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: unknown }> };
    };
    const mirroredModels = buildMirror(config, openclawConfig);

    api.registerProvider({
      id: PROXY_PROVIDER_ID,
      label: "DragonRouter S2 Proxy",
      aliases: [],
      envVars: [],
      auth: [],
    } as unknown as Parameters<typeof api.registerProvider>[0]);

    // The proxy forwards verbatim to OpenAI-format upstreams (e.g. bytedance-coding),
    // so the framework must speak OpenAI to the proxy too — otherwise it defaults to
    // anthropic-messages and the upstream rejects `tool_use` content blocks (400).
    const proxyProviderEntry = {
      baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
      apiKey: "dragon-router-proxy-handles-auth",
      api: "openai-completions",
      models: mirroredModels,
    } as { baseUrl?: string; apiKey?: string; api?: string; models?: unknown };

    // Attach the virtual provider to the config so model resolution finds it.
    if (!openclawConfig.models) openclawConfig.models = { providers: {} };
    if (!openclawConfig.models.providers) openclawConfig.models.providers = {};
    openclawConfig.models.providers[PROXY_PROVIDER_ID] = proxyProviderEntry;

    // The embedded agent runner resolves models against the pinned process-wide
    // runtime config snapshot (getRuntimeConfig()) — NOT api.config. Without
    // patching that snapshot too, the runner never sees `api: openai-completions` and
    // falls back to anthropic-messages, causing the upstream 400 on `tool_use`.
    try {
      const runtimeCfg = api.runtime.config.current() as
        | { models?: { providers?: Record<string, unknown> } }
        | undefined;
      if (runtimeCfg && runtimeCfg !== (api.config as unknown)) {
        if (!runtimeCfg.models) runtimeCfg.models = { providers: {} };
        if (!runtimeCfg.models.providers) runtimeCfg.models.providers = {};
        runtimeCfg.models.providers[PROXY_PROVIDER_ID] = proxyProviderEntry;
      }
    } catch (err) {
      // Non-fatal: best-effort runtime snapshot patch.
      api.logger.warn(`[dragon-router] runtime config patch skipped: ${String(err)}`);
    }

    // ── Local proxy service ──
    let proxyHandle: ProxyHandle | null = null;
    api.registerService({
      id: "dragon-router-proxy",
      async start() {
        proxyHandle = await startProxy(config.proxyPort, api.logger);
      },
      async stop() {
        await proxyHandle?.close();
        proxyHandle = null;
      },
    });

    registerHooks(api, config);

    // Desensitize local file-read tool results (read/ls/glob/grep/find) before
    // they reach the transcript / cloud model. tool_result_persist can't do this
    // — it's sync-only and silently drops async handlers — so this uses the
    // awaited tool-result middleware seam instead.
    //
    // MUST pass `runtimes` explicitly and keep it in sync with the "openclaw"
    // entry in openclaw.plugin.json's contracts.agentToolResultMiddleware.
    // Omitting `runtimes` defaults to requesting EVERY supported runtime
    // (currently ["openclaw", "codex"]); if the manifest doesn't declare all of
    // them, the host rejects the ENTIRE registration silently (a diagnostic is
    // pushed, but nothing throws or logs anywhere this plugin can see) — this
    // is exactly what happened before this was made explicit: the manifest only
    // declared "openclaw", the implicit default also requested "codex", the
    // mismatch caused the host to drop the registration outright, and the
    // middleware silently never ran.
    api.registerAgentToolResultMiddleware(createToolResultDesensitizeMiddleware(api, config), {
      runtimes: ["openclaw"],
    });
  },
});
