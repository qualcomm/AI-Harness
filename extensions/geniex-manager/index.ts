// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * GenieX manager plugin.
 *
 * Split from the `geniex` provider plugin because a bundled plugin only gets
 * loaded at gateway startup ("sidecar" treatment) when its manifest declares
 * no provider/channel/contract surface (see
 * `src/plugins/channel-plugin-ids.ts:isGatewayStartupSidecar`). `geniex`
 * declares `providers: ["geniex"]`, so core treats it as lazily loaded —
 * discovered when a chat request needs it, not necessarily at gateway
 * startup. That is correct for inference, but this plugin's job (owning the
 * `geniex serve` process and its gateway methods) needs to run unconditionally
 * from boot. Giving it its own provider-free manifest is what makes core pick
 * it up as a startup sidecar, the same way `dragon-router` and
 * `dragon-task-orchestrator` are.
 *
 * See this plugin's README for the full rationale and the split's operational
 * consequences (both plugins auto-enable independently; each ships disabled by
 * default and enables itself only on a supported host with the CLI present).
 */
import { invalidateModelCatalog } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { allowlistPulledModel } from "./src/allowlist.js";
import { isGenieXCliAvailable } from "./src/cli.js";
import { normalizeGenieXManagerPluginConfig } from "./src/config.js";
import { GENIEX_MANAGER_PLUGIN_ID } from "./src/defaults.js";
import { registerGenieXGatewayMethods } from "./src/gateway.js";
import { resolveGenieXPlatformSupport } from "./src/platform.js";
import { GenieXPullJobManager } from "./src/pull-jobs.js";
import { GenieXServeSupervisor } from "./src/serve-process.js";

export default definePluginEntry({
  id: GENIEX_MANAGER_PLUGIN_ID,
  name: "GenieX Manager",
  description: "Manages the geniex serve process and on-device model downloads",
  register(api: OpenClawPluginApi) {
    const pluginConfig = normalizeGenieXManagerPluginConfig(api.pluginConfig);

    // Same criteria as the geniex provider plugin's own probe (duplicated,
    // not shared — see defaults.ts): the platform check is pure memory
    // access, so hosts that can never run GenieX pay nothing; only ARM64
    // hosts go on to touch the filesystem looking for the CLI. Both plugins
    // auto-enable together, so the user never has to enable them separately.
    api.registerAutoEnableProbe(() => {
      const platform = resolveGenieXPlatformSupport();
      if (!platform.supported) {
        return null;
      }
      return isGenieXCliAvailable() ? "geniex CLI detected on PATH" : null;
    });

    const supervisor = new GenieXServeSupervisor(pluginConfig.serve ?? {}, api.logger);
    // A finished download adds a model to `geniex serve`. Allowlist it first (the
    // chat picker filters through `agents.defaults.models`), then drop the cached
    // model catalog so the next `models.list` re-runs provider discovery.
    const pullJobs = new GenieXPullJobManager(api.logger, (job) => {
      void allowlistPulledModel({
        config: api.runtime.config,
        baseUrl: supervisor.baseUrl,
        model: job.model,
        logger: api.logger,
      })
        .catch((error) => api.logger.warn(`GenieX allowlist update failed: ${String(error)}`))
        .finally(() => invalidateModelCatalog());
    });

    // Own the serve process for the gateway's lifetime. `start()` handles the
    // "not supported / not installed / already running" cases itself and never
    // throws, so a host without GenieX simply gets an inactive service.
    api.registerService({
      id: "geniex-serve",
      async start() {
        await supervisor.start();
      },
      async stop() {
        // Pause downloads before stopping the server so partial files are saved
        // (GenieX resumes from them) rather than left mid-write.
        await pullJobs.cancelAll();
        await supervisor.stop();
      },
    });

    registerGenieXGatewayMethods({ api, supervisor, pullJobs });
  },
});
