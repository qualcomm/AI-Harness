// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "./model-auth-markers.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
} from "./models-config.providers.secrets.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "./models-config.providers.secrets.js";
import { findNormalizedProviderValue } from "./provider-id.js";
import { stableStringify } from "./stable-stringify.js";

const log = createSubsystemLogger("agents/model-providers");

const PROVIDER_IMPLICIT_MERGERS: Partial<
  Record<
    string,
    (params: { existing: ProviderConfig | undefined; implicit: ProviderConfig }) => ProviderConfig
  >
> = {
  ollama: ({ implicit }) => implicit,
};

const PLUGIN_DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

type ImplicitProviderParams = {
  agentDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderApiKeyResolver;
  resolveProviderAuth: ProviderAuthResolver;
};

function resolveLiveProviderCatalogTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return null;
  }
  const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
  if (!raw) {
    return 15_000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function resolveProviderDiscoveryFilter(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] | undefined {
  const { config, workspaceDir, env } = params;
  const testRaw = env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS?.trim();
  if (testRaw) {
    const ids = testRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return ids.length > 0 ? [...new Set(ids)] : undefined;
  }
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return undefined;
  }
  const rawValues = [
    env.OPENCLAW_LIVE_PROVIDERS?.trim(),
    env.OPENCLAW_LIVE_GATEWAY_PROVIDERS?.trim(),
  ].filter((value): value is string => Boolean(value && value !== "all"));
  if (rawValues.length === 0) {
    return undefined;
  }
  const ids = rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return undefined;
  }
  const pluginIds = new Set<string>();
  for (const id of ids) {
    const owners =
      resolveOwningPluginIdsForProvider({
        provider: id,
        config,
        workspaceDir,
        env,
      }) ?? [];
    if (owners.length > 0) {
      for (const owner of owners) {
        pluginIds.add(owner);
      }
      continue;
    }
    pluginIds.add(id);
  }
  return pluginIds.size > 0
    ? [...pluginIds].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

export function resolveProviderDiscoveryFilterForTest(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] | undefined {
  return resolveProviderDiscoveryFilter(params);
}

function mergeImplicitProviderSet(
  target: Record<string, ProviderConfig>,
  additions: Record<string, ProviderConfig> | undefined,
): void {
  if (!additions) {
    return;
  }
  for (const [key, value] of Object.entries(additions)) {
    target[key] = value;
  }
}

function mergeImplicitProviderConfig(params: {
  providerId: string;
  existing: ProviderConfig | undefined;
  implicit: ProviderConfig;
}): ProviderConfig {
  const { providerId, existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  const merge = PROVIDER_IMPLICIT_MERGERS[providerId];
  if (merge) {
    return merge({ existing, implicit });
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}

function resolveConfiguredImplicitProvider(params: {
  configuredProviders?: Record<string, ProviderConfig> | null;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  for (const providerId of params.providerIds) {
    const configured = findNormalizedProviderValue(
      params.configuredProviders ?? undefined,
      providerId,
    );
    if (configured) {
      return configured;
    }
  }
  return undefined;
}

function resolveExistingImplicitProviderFromContext(params: {
  ctx: ImplicitProviderContext;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  return (
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.explicitProviders,
      providerIds: params.providerIds,
    }) ??
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.config?.models?.providers,
      providerIds: params.providerIds,
    })
  );
}

/**
 * How many provider catalog probes may be in flight at once.
 *
 * These are independent network round-trips to different vendors, so they were pure
 * dead time when run one after another: a measured orchestration run spent 338s of its
 * 660s inside `ensureOpenClawModelsJson`, almost all of it waiting on ~37 sequential
 * probes across four discovery orders.
 *
 * Bounded rather than unbounded `Promise.all`: opening 37 simultaneous TLS connections
 * to probe vendors invites rate-limit responses and, on constrained hosts, socket
 * exhaustion — which would turn a latency problem into a correctness one. Eight keeps
 * the slowest order dominated by the slowest single probe while staying polite.
 */
const PROVIDER_CATALOG_PROBE_CONCURRENCY = 8;

/**
 * Run `task` over `items` with at most `limit` concurrent, returning results in INPUT
 * order regardless of completion order.
 *
 * Index-keyed rather than push-on-completion: callers here depend on positional order
 * (see the merge loop in `resolvePluginImplicitProviders`), and a completion-ordered
 * array would silently reorder provider precedence.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolvePluginImplicitProviders(
  ctx: ImplicitProviderContext,
  providers: import("../plugins/types.js").ProviderPlugin[],
  order: import("../plugins/types.js").ProviderDiscoveryOrder,
): Promise<Record<string, ProviderConfig> | undefined> {
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const discovered: Record<string, ProviderConfig> = {};
  const catalogConfig = buildPluginCatalogConfig(ctx);
  const ordered = byOrder[order];

  /*
   * TWO PHASES, AND THE SPLIT IS LOAD-BEARING.
   *
   * Probing is concurrent because each probe is an independent network call that reads
   * only immutable context (`catalogConfig`, `ctx.resolveProviderApiKey`,
   * `ctx.resolveProviderAuth`) and touches no shared state.
   *
   * MERGING STAYS SEQUENTIAL AND IN INPUT ORDER. `mergeImplicitProviderConfig` reads
   * `discovered[providerId]` as it accumulates, so when two providers contribute the
   * same id the winner depends on merge order. Merging as results arrive would make
   * provider precedence depend on network latency — non-deterministic config, and the
   * kind of bug that only shows up on a slow link.
   *
   * `ctx.authStore` is lazily created by a SYNCHRONOUS getter, so concurrent probes
   * cannot interleave inside its initialization; the first one to touch it wins and the
   * rest reuse it.
   */
  const probeResults = await mapWithConcurrency(
    ordered,
    PROVIDER_CATALOG_PROBE_CONCURRENCY,
    async (provider) => {
      const resolveCatalogProviderApiKey = (providerId?: string) => {
        const resolvedProviderId = providerId?.trim() || provider.id;
        const resolved = ctx.resolveProviderApiKey(resolvedProviderId);
        if (resolved.apiKey) {
          return resolved;
        }

        if (
          !findNormalizedProviderValue(
            {
              [provider.id]: true,
              ...Object.fromEntries((provider.aliases ?? []).map((alias) => [alias, true])),
              ...Object.fromEntries((provider.hookAliases ?? []).map((alias) => [alias, true])),
            },
            resolvedProviderId,
          )
        ) {
          return resolved;
        }

        const synthetic = provider.resolveSyntheticAuth?.({
          config: catalogConfig,
          provider: resolvedProviderId,
          providerConfig: catalogConfig.models?.providers?.[resolvedProviderId],
        });
        const syntheticApiKey = synthetic?.apiKey?.trim();
        if (!syntheticApiKey) {
          return resolved;
        }

        return {
          apiKey: isNonSecretApiKeyMarker(syntheticApiKey)
            ? syntheticApiKey
            : resolveNonEnvSecretRefApiKeyMarker("file"),
          discoveryApiKey: undefined,
        };
      };

      // TEMPORARY DIAGNOSTIC: with probing now concurrent, an order costs as long as its
      // SLOWEST provider — `simple` still floors at ~14s, so one provider dominates. There
      // is no timeout outside live mode (`resolveLiveProviderCatalogTimeoutMs` returns
      // null), so naming the provider is the prerequisite for choosing one. Remove with the
      // other [startup-diag] probes.
      const tProbe = Date.now();
      const probed = await runProviderCatalogWithTimeout({
        provider,
        config: catalogConfig,
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        env: ctx.env,
        resolveProviderApiKey: resolveCatalogProviderApiKey,
        resolveProviderAuth: (providerId, options) =>
          ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
        timeoutMs: resolveLiveProviderCatalogTimeoutMs(ctx.env),
      });
      const probeMs = Date.now() - tProbe;
      // Only the slow ones: 37 providers × 4 orders would otherwise bury the log.
      if (probeMs >= 1000) {
        log.debug(`[startup-diag]     probe ${order}/${provider.id} ${probeMs}ms`);
      }
      return probed;
    },
  );

  // Merge phase: strictly in input order, so provider precedence is a property of the
  // declared order and not of which probe answered first.
  for (const [index, provider] of ordered.entries()) {
    const result = probeResults[index];
    if (!result) {
      continue;
    }
    const normalizedResult = normalizePluginDiscoveryResult({
      provider,
      result,
    });
    for (const [providerId, implicitProvider] of Object.entries(normalizedResult)) {
      discovered[providerId] = mergeImplicitProviderConfig({
        providerId,
        existing:
          discovered[providerId] ??
          resolveExistingImplicitProviderFromContext({
            ctx,
            providerIds: [
              providerId,
              provider.id,
              ...(provider.aliases ?? []),
              ...(provider.hookAliases ?? []),
            ],
          }),
        implicit: implicitProvider,
      });
    }
  }
  return Object.keys(discovered).length > 0 ? discovered : undefined;
}

function buildPluginCatalogConfig(ctx: ImplicitProviderContext): OpenClawConfig {
  if (!ctx.explicitProviders || Object.keys(ctx.explicitProviders).length === 0) {
    return ctx.config ?? {};
  }
  return {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers: {
        ...ctx.config?.models?.providers,
        ...ctx.explicitProviders,
      },
    },
  };
}

async function runProviderCatalogWithTimeout(
  params: Parameters<typeof runProviderCatalog>[0] & {
    timeoutMs: number | null;
  },
): Promise<Awaited<ReturnType<typeof runProviderCatalog>> | undefined> {
  const catalogRun = runProviderCatalog(params);
  const timeoutMs = params.timeoutMs ?? undefined;
  if (!timeoutMs) {
    return await catalogRun;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      catalogRun,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const message = formatErrorMessage(error);
    if (message.includes("provider catalog timed out after")) {
      log.warn(`${message}; skipping provider discovery`);
      return undefined;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Memo for the whole catalog-probe pass.
 *
 * WHY THIS IS SEPARATE FROM THE EXISTING MEMOS, AND WHY IT IS THE ONE THAT MATTERS
 * `provider-discovery.runtime.ts` already memoizes the provider LIST — the cheap part,
 * and it hit 11 of 13 times in the measured run while `catalog hooks total` still cost
 * 22–46s on 7 of those. `ensureOpenClawModelsJson` memoizes the WRITE, keyed on a
 * fingerprint that includes models.json's own mtime. Neither covers the probes.
 *
 * That gap sustained a feedback loop. Vendor probes are not perfectly repeatable, so each
 * pass could produce a slightly different model list; a different list means different
 * file contents, which means a write, which changes models.json's mtime, which invalidates
 * the write fingerprint, so the next call re-planned and re-probed — and possibly wrote
 * again. The measured run rewrote models.json on 10 of 15 calls. Caching the probes breaks
 * the loop at its source: stable probe output means stable contents, no write, no mtime
 * churn, and the existing write cache starts working as intended.
 *
 * KEY: exactly what the probes read, and no more.
 * - `models`, `secrets`, `plugins` — the only config branches on this path.
 *   `buildPluginCatalogConfig` and `resolveConfiguredImplicitProvider` read
 *   `models.providers`; the secret resolvers read `secrets`/`models.providers`; plugin
 *   discovery reads `plugins`.
 * - `env` — NOT optional and not derivable from config. It supplies API keys
 *   (`createProviderApiKeyResolver`), the discovery filter
 *   (`OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS`, `OPENCLAW_LIVE_*`) and the probe timeout.
 *   Keying without it would serve a cached catalog after a key was exported — a stale
 *   answer, not just a stale timing.
 * - `authProfilesMtimeMs` — so adding or refreshing a credential takes effect.
 *
 * NOT the whole config, which was the first attempt's mistake. Each agent resolves its own
 * config (`systemPromptOverride`, `tools`, `workspace` all differ), so a whole-config key
 * turned "probe once per machine" into "probe once per agent" — 7 distinct keys for 15
 * calls in the measured run. None of those fields reach a provider catalog.
 *
 * NOT models.json's mtime either: the probes never read that file, and including it is
 * precisely what made the outer write cache self-invalidating.
 *
 * TTL rather than forever: a vendor adding a model, or a credential going stale, should be
 * picked up by a long-running gateway without a restart.
 *
 * 15 minutes, corrected from an initial 2 — that first value was justified as "far longer
 * than one orchestration run", which was simply wrong. The measured run spans ~20 minutes,
 * so entries expired mid-run and the same agent re-probed: `agent:coding` missed at
 * 23:42:54 and again at 23:52:09, 9m15s apart. A TTL shorter than the workload it is meant
 * to cover buys nothing.
 */
const CATALOG_MEMO_TTL_MS = 15 * 60_000;

/**
 * A MAP, not a single slot, and that distinction decides whether this works at all.
 *
 * Callers legitimately alternate between a small number of distinct keys — a main agent
 * and its subagents differ by config shape (`subagents.maxConcurrent` was the observed
 * case). A one-entry memo alternating between two keys misses every single time, which
 * would leave the 338s exactly where it was while looking like a cache had been added.
 *
 * Capped because the key embeds config and env: an unbounded map keyed on that is a slow
 * leak in a long-running gateway. Eviction is oldest-inserted (insertion-ordered `Map`),
 * which suits a working set of a few agents.
 */
const CATALOG_MEMO_MAX_ENTRIES = 16;

/**
 * Stores the in-flight PROMISE, not the settled result.
 *
 * Two callers arriving before the first probe finishes would otherwise both probe: the
 * measured run shows exactly that at 23:39:14 and 23:39:27, both logging `entries=3`
 * because neither had inserted yet — a ~25s pass run twice for one answer. Sharing the
 * promise means the second caller awaits the first.
 *
 * `expiresAt` is stamped at insert rather than on settle. A probe pass takes tens of
 * seconds, so stamping on settle would be indistinguishable in practice, and stamping at
 * insert keeps the entry immutable once created.
 */
const catalogMemo = new Map<
  string,
  { expiresAt: number; providers: Promise<NonNullable<OpenClawConfig["models"]>["providers"]> }
>();

/** Test hook: the memo is process-wide, so suites varying config or auth must clear it. */
export function resetImplicitProvidersMemoForTest(): void {
  catalogMemo.clear();
}

/**
 * Exposed for tests only. `mapWithConcurrency` guarantees input-order results, and that
 * guarantee is what keeps provider precedence deterministic — worth asserting directly
 * rather than inferring it from an end-to-end catalog run.
 */
export const __testing = {
  mapWithConcurrency,
  PROVIDER_CATALOG_PROBE_CONCURRENCY,
  CATALOG_MEMO_TTL_MS,
};

async function buildCatalogMemoKey(params: ImplicitProviderParams): Promise<string> {
  const authProfilesMtimeMs = await readAuthProfilesMtimeMs(params.agentDir);
  return stableStringify({
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    // Only the branches the probe path actually consumes — see the memo comment above for
    // why the whole config must not go in here.
    models: params.config?.models,
    secrets: params.config?.secrets,
    plugins: params.config?.plugins,
    explicitProviders: params.explicitProviders,
    env: params.env ?? process.env,
    authProfilesMtimeMs,
  });
}

async function readAuthProfilesMtimeMs(agentDir: string): Promise<number | null> {
  try {
    const stat = await fsPromises.stat(path.join(agentDir, "auth-profiles.json"));
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

export async function resolveImplicitProviders(
  params: ImplicitProviderParams,
): Promise<NonNullable<OpenClawConfig["models"]>["providers"]> {
  const memoKey = await buildCatalogMemoKey(params);
  const hit = catalogMemo.get(memoKey);
  if (hit && hit.expiresAt > Date.now()) {
    log.debug(`[startup-diag] catalog memo HIT entries=${catalogMemo.size}`);
    return await hit.providers;
  }
  if (hit) {
    // Expired: drop it so the re-insert below refreshes insertion order, keeping eviction
    // aligned with actual use rather than first-ever sighting.
    catalogMemo.delete(memoKey);
  }
  log.debug(`[startup-diag] catalog memo MISS entries=${catalogMemo.size}`);

  const pending = resolveImplicitProvidersUncached(params);
  // Registered BEFORE the first await, so a concurrent caller with the same key finds it.
  catalogMemo.set(memoKey, { expiresAt: Date.now() + CATALOG_MEMO_TTL_MS, providers: pending });
  while (catalogMemo.size > CATALOG_MEMO_MAX_ENTRIES) {
    const oldest = catalogMemo.keys().next();
    if (oldest.done) break;
    catalogMemo.delete(oldest.value);
  }
  try {
    return await pending;
  } catch (error) {
    // A failed probe pass must not be cached: leaving the rejected promise in place would
    // replay the same failure to every caller for the whole TTL, turning one transient
    // network error into 15 minutes of broken provider discovery.
    if (catalogMemo.get(memoKey)?.providers === pending) {
      catalogMemo.delete(memoKey);
    }
    throw error;
  }
}

async function resolveImplicitProvidersUncached(
  params: ImplicitProviderParams,
): Promise<NonNullable<OpenClawConfig["models"]>["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const env = params.env ?? process.env;
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    }));
  const context: ImplicitProviderContext = {
    ...params,
    get authStore() {
      return getAuthStore();
    },
    env,
    resolveProviderApiKey: createProviderApiKeyResolver(env, getAuthStore, params.config),
    resolveProviderAuth: createProviderAuthResolver(env, getAuthStore, params.config),
  };
  // TEMPORARY DIAGNOSTIC: attribute ensureOpenClawModelsJson's ~25s between plugin
  // discovery and the per-provider catalog hooks. Remove once the cost is located.
  const tDiscoveryStart = Date.now();
  const discoveryProviders = await resolvePluginDiscoveryProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: resolveProviderDiscoveryFilter({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env,
    }),
  });
  log.debug(
    `[startup-diag] resolvePluginDiscoveryProviders ${Date.now() - tDiscoveryStart}ms providers=${discoveryProviders.length}`,
  );

  const tCatalogStart = Date.now();
  for (const order of PLUGIN_DISCOVERY_ORDERS) {
    const tOrderStart = Date.now();
    mergeImplicitProviderSet(
      providers,
      await resolvePluginImplicitProviders(context, discoveryProviders, order),
    );
    log.debug(`[startup-diag]   catalog order=${order} ${Date.now() - tOrderStart}ms`);
  }
  log.debug(`[startup-diag] catalog hooks total ${Date.now() - tCatalogStart}ms`);

  return providers;
}
