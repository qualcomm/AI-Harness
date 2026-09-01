import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolveDiscoveredProviderPluginIds } from "./providers.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import { createPluginSourceLoader } from "./source-loader.js";
import type { ProviderPlugin } from "./types.js";

type ProviderDiscoveryModule =
  | ProviderPlugin
  | ProviderPlugin[]
  | {
      default?: ProviderPlugin | ProviderPlugin[];
      providers?: ProviderPlugin[];
      provider?: ProviderPlugin;
    };

function normalizeDiscoveryModule(value: ProviderDiscoveryModule): ProviderPlugin[] {
  const resolved =
    value && typeof value === "object" && "default" in value && value.default !== undefined
      ? value.default
      : value;
  if (Array.isArray(resolved)) {
    return resolved;
  }
  if (resolved && typeof resolved === "object" && "id" in resolved) {
    return [resolved];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { providers?: ProviderPlugin[]; provider?: ProviderPlugin };
    if (Array.isArray(record.providers)) {
      return record.providers;
    }
    if (record.provider) {
      return [record.provider];
    }
  }
  return [];
}

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const pluginIds = resolveDiscoveredProviderPluginIds(params);
  const pluginIdSet = new Set(pluginIds);
  const records = loadPluginManifestRegistry(params).plugins.filter(
    (plugin) => plugin.providerDiscoverySource && pluginIdSet.has(plugin.id),
  );
  if (records.length === 0) {
    return [];
  }
  const loadSource = createPluginSourceLoader();
  const providers: ProviderPlugin[] = [];
  for (const manifest of records) {
    try {
      const moduleExport = loadSource(manifest.providerDiscoverySource!) as ProviderDiscoveryModule;
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) => ({
          ...provider,
          pluginId: manifest.id,
        })),
      );
    } catch {
      // Discovery fast path is optional. Fall back to the full plugin loader
      // below so existing plugin diagnostics/load behavior remains canonical.
      return [];
    }
  }
  return providers;
}

/**
 * Discovery runs on the snapshot path (`activate:false`), and `loadOpenClawPlugins`
 * rejects `activate:false` without `cache:false` — so every call re-transpiles and
 * re-executes the whole provider plugin graph through a fresh Jiti loader. That work
 * is synchronous: measured at 21-28s per call, blocking the event loop hard enough to
 * stall unrelated gateway RPCs for ~10s.
 *
 * Nothing here depends on the calling agent — `agentDir` is not an input — so the
 * result is stable for a given config/workspace/env/plugin scope and can be reused
 * across agents. Callers still re-run each provider's catalog hook per call, so
 * per-agent auth and credentials are unaffected by this memo.
 */
let discoveryProvidersMemo: { key: string; providers: ProviderPlugin[] } | null = null;

function stableKeyPart(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableKeyPart(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableKeyPart(entry)}`).join(",")}}`;
}

function buildDiscoveryProvidersMemoKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): string {
  return stableKeyPart({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    // Order is not meaningful to the loader, but it is to a string key.
    onlyPluginIds: params.onlyPluginIds ? [...params.onlyPluginIds].toSorted() : undefined,
  });
}

/** Test hook: the memo is process-wide, so suites that vary plugin scope must clear it. */
export function resetPluginDiscoveryProvidersMemoForTest(): void {
  discoveryProvidersMemo = null;
}

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const memoKey = buildDiscoveryProvidersMemoKey(params);
  if (discoveryProvidersMemo?.key === memoKey) {
    // TEMPORARY DIAGNOSTIC: remove with the [startup-diag] probes.
    console.error(`[startup-diag] discovery memo HIT len=${memoKey.length}`);
    return discoveryProvidersMemo.providers;
  }
  // TEMPORARY DIAGNOSTIC: on a miss, report which key part changed so the volatile
  // input is named rather than guessed at.
  const prev = discoveryProvidersMemo;
  if (prev) {
    console.error(
      `[startup-diag] discovery memo MISS prevLen=${prev.key.length} nextLen=${memoKey.length} firstDiffAt=${firstDiffIndex(prev.key, memoKey)} ctx=${JSON.stringify(diffContext(prev.key, memoKey))}`,
    );
  } else {
    console.error(`[startup-diag] discovery memo COLD len=${memoKey.length}`);
  }
  const providers = resolveDiscoveryProvidersUncached(params);
  discoveryProvidersMemo = { key: memoKey, providers };
  return providers;
}

/** TEMPORARY DIAGNOSTIC helper. */
function firstDiffIndex(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index++) {
    if (a[index] !== b[index]) {
      return index;
    }
  }
  return limit;
}

/** TEMPORARY DIAGNOSTIC helper: 120 chars around the divergence, from both keys. */
function diffContext(a: string, b: string): { prev: string; next: string } {
  const at = firstDiffIndex(a, b);
  const from = Math.max(0, at - 60);
  return { prev: a.slice(from, at + 60), next: b.slice(from, at + 60) };
}

function resolveDiscoveryProvidersUncached(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const entryProviders = resolveProviderDiscoveryEntryPlugins(params);
  if (entryProviders.length > 0) {
    return entryProviders;
  }
  return resolvePluginProviders({
    ...params,
    bundledProviderAllowlistCompat: true,
  });
}
