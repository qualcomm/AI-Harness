import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry,
} from "../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";

/**
 * Load key of the last call that actually resolved a registry, plus the subagent
 * mode it left active.
 *
 * WHY THIS MEMO EXISTS
 *
 * `resolveRuntimePluginRegistry` decides reuse by comparing this caller's load key
 * against the key of the ACTIVE registry — but the gateway activates its registry
 * with a much richer option set (`activationSourceConfig`, `autoEnabledReasons`,
 * `onlyPluginIds`, `coreGatewayHandlers`, `preferSetupRuntimeForChannelPlugins`),
 * all of which feed that key. Callers here supply only config/workspaceDir/binding,
 * so the two keys can never be equal and every call fell through to a full reload.
 *
 * Measured cost: every `embedded run start` (run.ts) and every `before_agent_reply`
 * (get-reply.ts) re-registered every plugin and then waited ~27s before the run
 * began. A single decomposition turn does that 5+ times.
 *
 * Comparing against our OWN previous key instead is both cheap and sufficient: it
 * still changes whenever the plugins config or workspace changes, so a real config
 * edit is still picked up, while repeated identical calls stop rebuilding.
 */
let lastResolved: { key: string; subagentMode: string } | null = null;

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const loadOptions = {
    config: params.config,
    workspaceDir,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };

  const key = resolvePluginRegistryLoadCacheKey(loadOptions);
  const activeMode = getActivePluginRuntimeSubagentMode();
  // Skip only when nothing this function guarantees could have changed: same load
  // inputs as our last resolve, a registry still active, and the subagent mode still
  // what that resolve left behind (so a lost gateway binding — the very thing this
  // function exists to re-assert — still forces a reload).
  if (
    lastResolved !== null &&
    lastResolved.key === key &&
    lastResolved.subagentMode === activeMode &&
    getActivePluginRegistry()
  ) {
    return;
  }

  resolveRuntimePluginRegistry(loadOptions);
  lastResolved = { key, subagentMode: getActivePluginRuntimeSubagentMode() };
}
