// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Compute-unit resolution for GenieX models.
 *
 * A model's runtime decides which compute units it can use. This mirrors
 * `geniex_resolve_device` in GenieX `sdk/src/device.cpp`, which is the single
 * source of truth for the alias table:
 *
 * - `qairt` is NPU-only. Passing anything else is coerced back to NPU with a
 *   warning, and `ngl` is forced to 0.
 * - `llama_cpp` maps `cpu` -> ngl 0, `gpu` -> GPUOpenCL, `npu` -> HTP0.
 *   Empty / `auto` also resolve to NPU.
 *
 * `hybrid` is accepted by the alias validator but has no branch in
 * `geniex_resolve_device`, so it behaves as "unspecified — let llama.cpp
 * decide" rather than as a distinct scheduling mode.
 *
 * Duplicated from the `geniex` provider plugin's `src/compute.ts` — see
 * `defaults.ts` for why cross-plugin imports are not an option here. Both
 * copies must stay in sync: the provider uses this to decide what to send on
 * the wire, and this plugin's `model-store.ts` uses it to decide what the UI
 * may offer.
 */
import { GENIEX_RUNTIME_LLAMA_CPP, GENIEX_RUNTIME_QAIRT } from "./defaults.js";

/** Compute units accepted by `geniex_resolve_device`'s alias table. */
export const GENIEX_COMPUTE_UNITS = ["cpu", "gpu", "npu", "hybrid"] as const;
export type GenieXComputeUnit = (typeof GENIEX_COMPUTE_UNITS)[number];

/** Compute units a qairt model can run on: NPU only. */
const QAIRT_COMPUTE_UNITS: readonly GenieXComputeUnit[] = ["npu"];

/** Compute units a llama_cpp model can run on. */
const LLAMA_CPP_COMPUTE_UNITS: readonly GenieXComputeUnit[] = GENIEX_COMPUTE_UNITS;

export function isGenieXComputeUnit(value: unknown): value is GenieXComputeUnit {
  return (
    typeof value === "string" &&
    (GENIEX_COMPUTE_UNITS as readonly string[]).includes(value.trim().toLowerCase())
  );
}

/** Normalizes a user-supplied compute unit, returning undefined when invalid. */
export function normalizeGenieXComputeUnit(value: unknown): GenieXComputeUnit | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isGenieXComputeUnit(normalized) ? normalized : undefined;
}

/**
 * Compute units the given runtime supports.
 *
 * An unknown runtime falls back to the llama_cpp set rather than an empty list:
 * a future GenieX runtime is more likely to be device-flexible than NPU-pinned,
 * and an empty list would silently strip the user's configured compute unit.
 */
export function computeUnitsForRuntime(runtimeId: string | undefined): readonly GenieXComputeUnit[] {
  const normalized = runtimeId?.trim().toLowerCase();
  if (normalized === GENIEX_RUNTIME_QAIRT) {
    return QAIRT_COMPUTE_UNITS;
  }
  if (normalized === GENIEX_RUNTIME_LLAMA_CPP) {
    return LLAMA_CPP_COMPUTE_UNITS;
  }
  return LLAMA_CPP_COMPUTE_UNITS;
}

/** Whether the runtime leaves the user any compute-unit choice at all. */
export function isComputeUnitSelectable(runtimeId: string | undefined): boolean {
  return computeUnitsForRuntime(runtimeId).length > 1;
}

/**
 * Whether a compute unit should be sent to GenieX for a model on `runtimeId`.
 *
 * Returns false for qairt: the runtime ignores the value and emits a
 * "qairt plugin only supports NPU inference" warning on every request, so
 * sending it produces log noise with no behavior change.
 */
export function shouldSendComputeUnit(params: {
  runtimeId: string | undefined;
  computeUnit: GenieXComputeUnit | undefined;
}): boolean {
  if (!params.computeUnit) {
    return false;
  }
  return isComputeUnitSelectable(params.runtimeId);
}
