// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Reads the Qualcomm AI Hub release index to list downloadable models.
 *
 * This reimplements `select_hub_models` from GenieX
 * `sdk/model-manager/crates/core/src/source/ai_hub/mod.rs` against the same two
 * public JSON files. Doing it here rather than shelling out to
 * `geniex model list` buys three things:
 *
 * - **No interactive hang.** `geniex model list` calls `ensureChipset()`, which
 *   falls back to an interactive picker when no chipset is configured. As a
 *   non-TTY child process we would block until the timeout.
 * - **No table parsing.** The CLI only renders a box-drawing table for humans;
 *   the JSON fields here are versioned and `serde(default)`-tolerant upstream.
 * - **Client-side chipset filtering.** Switching the target chipset costs nothing
 *   because the full index is already in hand.
 *
 * Verified against release `latest` (manifest 229 models, platform 27 chipsets):
 * filtering for `qualcomm-snapdragon-x2-elite` reproduces the exact 20 rows
 * `geniex model list` prints on that host.
 *
 * **Callers must not assume `readGenieXChipset()`'s result is already this
 * canonical form.** `geniex config get chipset`, when unconfigured, resolves
 * through GenieX's *online* chipset detection, which returns the
 * reference-device display name (e.g. `"Snapdragon X2 Elite CRD"`), not the
 * canonical id — see `resolveCanonicalChipsetId` below. `listAiHubModels`
 * always resolves through that before filtering, but any other caller
 * matching directly against `supported_chipsets` will silently get zero
 * results instead of an error.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const log = createSubsystemLogger("extensions/geniex-manager/aihub");

/** Mirrors `DEFAULT_AI_HUB_BASE_URL` in GenieX `model-manager/core/src/config.rs`. */
export const AI_HUB_DEFAULT_ENDPOINT =
  "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models";

/** Mirrors `DEFAULT_AI_HUB_VERSION`; used when `releases/latest/` is unavailable. */
export const AI_HUB_FALLBACK_VERSION = "v0.60.0";

/**
 * Runtime ids that denote a QAIRT (NPU) asset, in preference order.
 *
 * AI Hub is mid-migration between the two names and publishes inconsistently:
 * some models ship only the new id, others only the legacy one, and chipset
 * coverage can differ between them — so both stay match candidates. Assets for
 * other runtimes (ONNX, TFLite, QNN_DLC, and llama.cpp GGUF) are rejected here,
 * exactly as the GenieX AI Hub source does.
 */
const QAIRT_RUNTIMES = ["RUNTIME_GENIEX_QAIRT", "RUNTIME_GENIE"] as const;

const REQUEST_TIMEOUT_MS = 20_000;

type ManifestModelEntry = {
  id?: string;
  display_name?: string;
  domain?: string;
  supported_runtimes?: string[];
  supported_chipsets?: string[];
  tags?: string[];
};

type ReleaseManifest = {
  models?: ManifestModelEntry[];
};

type PlatformChipset = {
  name?: string;
  aliases?: string[];
  marketing_name?: string;
  reference_device?: string;
};

type PlatformInfo = {
  chipsets?: PlatformChipset[];
};

/** One AI Hub model that GenieX can run, as surfaced to the UI. */
export type AiHubModel = {
  /** Pull-ready name, e.g. `qualcomm/Qwen3-4B`. */
  name: string;
  displayName: string;
  /** AI Hub model id, e.g. `qwen3_4b`. */
  id: string;
  modelType: "llm" | "vlm";
  /** Canonical chipset ids this model publishes assets for. */
  supportedChipsets: string[];
};

/** One chipset the user can target, for the manual-selection fallback. */
export type AiHubChipset = {
  /** Canonical id, e.g. `qualcomm-snapdragon-x2-elite`. */
  name: string;
  /** Name GenieX displays, e.g. `Snapdragon X2 Elite CRD`. */
  displayName: string;
  aliases: string[];
};

function isQairtRuntime(runtime: string): boolean {
  return (QAIRT_RUNTIMES as readonly string[]).includes(runtime);
}

async function fetchReleaseJson<T>(params: {
  filename: string;
  endpoint?: string;
  version?: string;
}): Promise<T | undefined> {
  const endpoint = (params.endpoint ?? AI_HUB_DEFAULT_ENDPOINT).replace(/\/+$/, "");
  // Same two-step as GenieX: prefer `latest`, fall back to the pinned release so
  // a transient gap in `latest/` does not break model discovery outright.
  const candidates = [
    `${endpoint}/releases/latest/${params.filename}`,
    `${endpoint}/releases/${params.version ?? AI_HUB_FALLBACK_VERSION}/${params.filename}`,
  ];

  for (const url of candidates) {
    let release: (() => Promise<void>) | undefined;
    try {
      const guarded = await fetchWithSsrFGuard({
        url,
        timeoutMs: REQUEST_TIMEOUT_MS,
        // Operator-controlled constant endpoint, not user input.
        mode: "trusted_env_proxy",
      });
      release = guarded.release;
      if (!guarded.response.ok) {
        log.debug(`AI Hub ${params.filename} at ${url}: HTTP ${guarded.response.status}`);
        continue;
      }
      return (await guarded.response.json()) as T;
    } catch (error) {
      log.debug(`AI Hub ${params.filename} at ${url} failed: ${String(error)}`);
    } finally {
      await release?.();
    }
  }
  return undefined;
}

/**
 * Filters and sorts manifest entries the way GenieX's `select_hub_models` does.
 *
 * Exported for testing against a real manifest snapshot.
 */
export function selectAiHubModels(params: {
  manifest: ReleaseManifest;
  /** Canonical chipset id; omit to list every model. */
  chipset?: string;
}): AiHubModel[] {
  const entries = params.manifest.models ?? [];
  const chipset = params.chipset?.trim();

  return entries
    .filter((entry) => (entry.supported_runtimes ?? []).some(isQairtRuntime))
    .filter((entry) => !chipset || (entry.supported_chipsets ?? []).includes(chipset))
    .flatMap((entry) => {
      const displayName = entry.display_name?.trim();
      const id = entry.id?.trim();
      if (!displayName || !id) {
        return [];
      }
      return [
        {
          // AI Hub models live under the `qualcomm/` org; this is the form
          // `geniex pull` expects.
          name: `qualcomm/${displayName}`,
          displayName,
          id,
          // MODEL_TAG_VLM marks vision models even when the domain is the
          // generic GENERATIVE_AI.
          modelType: (entry.tags ?? []).includes("MODEL_TAG_VLM")
            ? ("vlm" as const)
            : ("llm" as const),
          supportedChipsets: entry.supported_chipsets ?? [],
        },
      ];
    })
    .toSorted((left, right) =>
      left.displayName.toLowerCase().localeCompare(right.displayName.toLowerCase()),
    );
}

/**
 * Resolves a chipset string in *any* form GenieX might hand us — canonical id,
 * reference-device display name, marketing name, or alias — to the canonical
 * id `supported_chipsets` entries use.
 *
 * This exists because `geniex config get chipset` does not reliably return a
 * canonical id: GenieX's own FFI comment says it plainly — "offline: local
 * probe only; else translate online to the display name"
 * (`geniex_model_detect_chipset` in `sdk/model-manager/crates/ffi/src/chipset.rs`).
 * When no chipset is explicitly configured, `ResolveChipset(false)` (what
 * `config get` falls back to) takes the "else" branch and returns the
 * *reference-device* string (e.g. `"Snapdragon X2 Elite CRD"`), not the
 * canonical id (`"qualcomm-snapdragon-x2-elite"`). Filtering
 * `supported_chipsets.includes(...)` against that display string always
 * misses, silently returning zero models with no error anywhere.
 *
 * Returns undefined when no chipset in the catalogue matches any of a
 * chipset's own identifying strings, so the caller can decide whether to fall
 * back to an unfiltered list or to the raw (possibly already-canonical) input.
 */
export function resolveCanonicalChipsetId(platform: PlatformInfo, input: string): string | undefined {
  const target = input.trim().toLowerCase();
  if (!target) {
    return undefined;
  }
  for (const entry of platform.chipsets ?? []) {
    const name = entry.name?.trim();
    if (!name) {
      continue;
    }
    const candidates = [
      name,
      entry.reference_device,
      entry.marketing_name,
      ...(entry.aliases ?? []),
    ];
    if (candidates.some((candidate) => candidate?.trim().toLowerCase() === target)) {
      return name;
    }
  }
  return undefined;
}

/** Lists AI Hub models with a QAIRT build, optionally filtered to one chipset. */
export async function listAiHubModels(params?: {
  chipset?: string;
  endpoint?: string;
}): Promise<AiHubModel[]> {
  const manifest = await fetchReleaseJson<ReleaseManifest>({
    filename: "manifest.json",
    ...(params?.endpoint ? { endpoint: params.endpoint } : {}),
  });
  if (!manifest) {
    return [];
  }

  let chipset = params?.chipset;
  if (chipset) {
    const platform = await fetchReleaseJson<PlatformInfo>({
      filename: "platform.json",
      ...(params?.endpoint ? { endpoint: params.endpoint } : {}),
    });
    // Best-effort: if platform.json itself is unreachable, fall back to the
    // raw input rather than dropping the filter — it may already be canonical.
    if (platform) {
      chipset = resolveCanonicalChipsetId(platform, chipset) ?? chipset;
    }
  }

  return selectAiHubModels({
    manifest,
    ...(chipset ? { chipset } : {}),
  });
}

/** Normalizes `platform.json` chipsets into selectable options. */
export function selectAiHubChipsets(platform: PlatformInfo): AiHubChipset[] {
  return (platform.chipsets ?? [])
    .flatMap((entry) => {
      const name = entry.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          // `reference_device` is the string GenieX shows (e.g. "Snapdragon X2
          // Elite CRD"), so prefer it over the trademarked marketing name.
          displayName: entry.reference_device?.trim() || entry.marketing_name?.trim() || name,
          aliases: entry.aliases ?? [],
        },
      ];
    })
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
}

/** Lists every chipset AI Hub supports, for manual selection. */
export async function listAiHubChipsets(params?: { endpoint?: string }): Promise<AiHubChipset[]> {
  const platform = await fetchReleaseJson<PlatformInfo>({
    filename: "platform.json",
    ...(params?.endpoint ? { endpoint: params.endpoint } : {}),
  });
  return platform ? selectAiHubChipsets(platform) : [];
}
