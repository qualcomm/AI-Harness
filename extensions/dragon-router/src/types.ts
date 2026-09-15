// ── Core types for dragon-router ──

/** Privacy sensitivity level. */
export type PrivacyLevel = "S1" | "S2" | "S3";

/** Complexity tier: 1 (simplest) .. 5 (hardest). */
export type ComplexityTier = 1 | 2 | 3 | 4 | 5;

/** A model target: which provider + model to route to. */
export type ModelTarget = {
  provider: string;
  model: string;
};

/** Which local-model API protocol to speak. */
export type LocalModelApi = "ollama" | "openai-compatible";

/** Local model backend config (Ollama by default). */
export type LocalModelConfig = {
  /** e.g. "http://localhost:11434" */
  endpoint: string;
  /** e.g. "openbmb/minicpm4.1" — sent verbatim as the request body `model`. */
  model: string;
  /** API protocol: "ollama" (→ /api/chat) or "openai-compatible" (→ /v1/chat/completions). */
  api: LocalModelApi;
};

/** Full plugin config under the `dragonRouter` key. */
export type DragonRouterConfig = {
  enabled: boolean;
  localModel: LocalModelConfig;
  /** Complexity tier (1-5) → cloud model mapping for S1/S2 routing. */
  complexityTiers: Record<string, ModelTarget>;
  /** Model used to process S3 (fully-local) messages. */
  s3Model: ModelTarget;
  /** Local HTTP proxy port for S2 desensitize/re-sensitize. */
  proxyPort: number;
  /** Classification cache TTL in ms. */
  cacheTtlMs: number;
};

/** A single PII item extracted from a message. */
export type PiiItem = {
  /** Unique placeholder token, e.g. "⟦PII_a1b2⟧". */
  placeholder: string;
  /** Original sensitive value. */
  original: string;
  /** Type label, e.g. "PHONE", "NAME". */
  type: string;
};

/** Result of a desensitization pass. */
export type DesensitizeResult = {
  /** Text with PII replaced by placeholders. */
  desensitized: string;
  /** Placeholder → original mappings. */
  items: PiiItem[];
  /** True if the local model failed and we could not desensitize. */
  failed: boolean;
};

/** Final routing decision produced by router-decision. */
export type RouteDecision = {
  level: PrivacyLevel;
  /** Only present for S1/S2. */
  tier?: ComplexityTier;
  /** The model to route to. */
  target: ModelTarget;
  /** Whether this must go through the local proxy (S2). */
  viaProxy: boolean;
  reason: string;
};
