/**
 * Virtual provider `dragon-router-proxy`.
 *
 * S2 traffic is routed to this provider whose baseUrl points at the local
 * proxy. The proxy strips desensitization markers, forwards to the real
 * upstream, and re-sensitizes the response stream.
 *
 * The virtual provider must "own" every cloud model that S2 might select, so
 * OpenClaw's model resolution succeeds. We mirror model ids from the configured
 * complexity tiers and register a model→upstream target map for the proxy.
 */

import type { DragonRouterConfig, ModelTarget } from "./types.js";

export const PROXY_PROVIDER_ID = "dragon-router-proxy";

/** model id → real upstream target (provider + baseUrl + apiKey). */
export type UpstreamTarget = {
  provider: string;
  baseUrl: string;
  apiKey: string;
};

const modelTargets = new Map<string, UpstreamTarget>();

export function getUpstreamTarget(modelId: string): UpstreamTarget | undefined {
  return modelTargets.get(modelId);
}

export function registerModelTarget(modelId: string, target: UpstreamTarget): void {
  modelTargets.set(modelId, target);
}

type ModelDef = { id?: string; api?: string; [k: string]: unknown };
type ProviderCfg = { baseUrl?: string; apiKey?: string; api?: string; models?: unknown };

/** Find the upstream model definition (for its api / contextWindow / etc.). */
function findUpstreamModel(provCfg: ProviderCfg | undefined, modelId: string): ModelDef | undefined {
  const models = provCfg?.models;
  if (!Array.isArray(models)) return undefined;
  return (models as ModelDef[]).find((m) => m?.id === modelId);
}

/**
 * Build the model→upstream map and the list of mirrored model entries for the
 * virtual provider, from the real providers in the OpenClaw config + the
 * complexity tier targets.
 *
 * Each mirrored entry copies the upstream model's own `api` (falling back to the
 * upstream provider's `api`). This matters because OpenClaw resolves a model's
 * transport from `model.api` FIRST (see model.inline-provider.ts) — a bare
 * `{ id }` entry has no api, so the runner defaults to `anthropic-messages` and
 * the OpenAI-format upstream (e.g. bytedance-coding) rejects the request.
 */
export function buildMirror(
  config: DragonRouterConfig,
  openclawConfig: { models?: { providers?: Record<string, ProviderCfg> } },
): Array<ModelDef> {
  const providers = openclawConfig.models?.providers ?? {};
  const mirrored: Array<ModelDef> = [];
  const seen = new Set<string>();

  const tierTargets: ModelTarget[] = Object.values(config.complexityTiers);
  for (const t of tierTargets) {
    if (seen.has(t.model)) continue;
    seen.add(t.model);

    const provCfg = providers[t.provider];
    const upstreamModel = findUpstreamModel(provCfg, t.model);
    // Resolve api: upstream model's api → upstream provider's api → openai-completions.
    const api = upstreamModel?.api ?? provCfg?.api ?? "openai-completions";
    // Copy the full upstream model def (contextWindow, maxTokens, reasoning, …) so
    // the mirrored entry resolves identically to a direct route, then force api.
    mirrored.push({ ...(upstreamModel ?? {}), id: t.model, api });

    modelTargets.set(t.model, {
      provider: t.provider,
      baseUrl: provCfg?.baseUrl ?? "",
      apiKey: provCfg?.apiKey ?? "",
    });
  }

  return mirrored;
}
