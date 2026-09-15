/**
 * Combine privacy level + complexity into a final routing decision.
 */

import { classifyComplexity } from "./complexity-classifier.js";
import type { DragonRouterConfig, ComplexityTier, ModelTarget, RouteDecision } from "./types.js";

/** Look up the model for a complexity tier, falling back to tier 2, any tier, then s3Model. */
export function targetForTier(config: DragonRouterConfig, tier: ComplexityTier): ModelTarget {
  const tiers = config.complexityTiers;
  // Final fallback is s3Model (a valid ModelTarget) — NOT localModel, whose `api`
  // field is a protocol selector, not a registered provider id.
  return tiers[String(tier)] ?? tiers["2"] ?? Object.values(tiers)[0] ?? config.s3Model;
}

/**
 * Decide routing for an S1 (safe) message: classify complexity → pick model.
 */
export async function decideS1(
  config: DragonRouterConfig,
  message: string,
): Promise<RouteDecision> {
  const tier = await classifyComplexity(config.localModel, message, config.cacheTtlMs);
  const target = targetForTier(config, tier);
  return {
    level: "S1",
    tier,
    target,
    viaProxy: false,
    reason: `S1 tier=${tier}`,
  };
}

/**
 * Decide routing for S3 (private): always the local S3 model, no complexity check.
 */
export function decideS3(config: DragonRouterConfig): RouteDecision {
  return {
    level: "S3",
    target: config.s3Model,
    viaProxy: false,
    reason: "S3 local-only",
  };
}
