/**
 * dragon-router config schema (TypeBox) + defaults.
 *
 * Config lives under the `dragonRouter` key of the plugin config.
 */

import { Type } from "typebox";
import type { DragonRouterConfig } from "./types.js";

const modelTargetSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
});

export const dragonRouterConfigSchema = Type.Object({
  dragonRouter: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      localModel: Type.Optional(
        Type.Object({
          endpoint: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          api: Type.Optional(
            Type.Union([Type.Literal("ollama"), Type.Literal("openai-compatible")]),
          ),
        }),
      ),
      complexityTiers: Type.Optional(Type.Record(Type.String(), modelTargetSchema)),
      s3Model: Type.Optional(modelTargetSchema),
      proxyPort: Type.Optional(Type.Number()),
      cacheTtlMs: Type.Optional(Type.Number()),
    }),
  ),
});

/** Built-in defaults. Cloud tier models are placeholders — user should override. */
export const DEFAULT_CONFIG: DragonRouterConfig = {
  enabled: true,
  localModel: {
    endpoint: "http://localhost:11434/v1",
    model: "openbmb/minicpm4.1",
    api: "openai-compatible",
  },
  complexityTiers: {
    "1": { provider: "ollama", model: "openbmb/minicpm4.1" },
    "2": { provider: "zhipu", model: "glm-4.5-air" },
    "3": { provider: "minimax", model: "minimax-m2.5" },
    "4": { provider: "deepseek", model: "deepseek-v3.2" },
    "5": { provider: "moonshot", model: "kimi-k2.5" },
  },
  s3Model: { provider: "ollama", model: "openbmb/minicpm4.1" },
  proxyPort: 8404,
  cacheTtlMs: 300_000,
};

/** Merge user config (from plugin config `dragonRouter`) with defaults. */
export function resolveConfig(pluginConfig: Record<string, unknown> | undefined): DragonRouterConfig {
  const user = ((pluginConfig?.dragonRouter ?? {}) as Partial<DragonRouterConfig>) ?? {};
  return {
    enabled: user.enabled ?? DEFAULT_CONFIG.enabled,
    localModel: {
      endpoint: user.localModel?.endpoint ?? DEFAULT_CONFIG.localModel.endpoint,
      model: user.localModel?.model ?? DEFAULT_CONFIG.localModel.model,
      api: user.localModel?.api ?? DEFAULT_CONFIG.localModel.api,
    },
    complexityTiers: user.complexityTiers ?? DEFAULT_CONFIG.complexityTiers,
    s3Model: user.s3Model ?? DEFAULT_CONFIG.s3Model,
    proxyPort: user.proxyPort ?? DEFAULT_CONFIG.proxyPort,
    cacheTtlMs: user.cacheTtlMs ?? DEFAULT_CONFIG.cacheTtlMs,
  };
}
