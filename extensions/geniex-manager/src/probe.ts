// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Minimal readiness probe for a `geniex serve` instance.
 *
 * This is a small, deliberately narrow extraction: the provider plugin's own
 * `models.fetch.ts` has the full `/v1/models` catalog-fetching logic this
 * plugin does not need (chat model discovery is the provider's job). Only the
 * plain HTTP readiness check is duplicated here.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { GENIEX_DEFAULT_BASE_URL } from "./defaults.js";

const log = createSubsystemLogger("extensions/geniex-manager/probe");

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Normalizes a user-supplied base URL to GenieX's OpenAI-compatible root.
 *
 * Accepts the bare host (`http://127.0.0.1:18181`) as well as the full
 * inference base (`.../v1`), since both appear in GenieX docs.
 */
export function resolveGenieXInferenceBase(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return GENIEX_DEFAULT_BASE_URL;
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  const trimmed = apiKey?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : undefined;
}

/**
 * Whether a `geniex serve` instance is reachable at `baseUrl`.
 *
 * Probes `GET /v1/`, which returns "GenieX-CLI is running" as soon as the HTTP
 * server is up. Deliberately not `/v1/models`: `geniex serve` starts fine with
 * zero models cached (it loads models lazily per request), so an empty model
 * list is a valid ready state, not a failure.
 */
export async function probeGenieXServer(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const base = resolveGenieXInferenceBase(params.baseUrl);
  try {
    const response = await fetch(`${base}/`, {
      headers: buildHeaders(params.apiKey),
      signal: AbortSignal.timeout(params.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Logged because a silent false here is indistinguishable from "server not
      // running", which makes an empty model list very hard to diagnose.
      log.debug(`GenieX probe at ${base}/ returned HTTP ${response.status}`);
    }
    return response.ok;
  } catch (error) {
    log.debug(`GenieX probe at ${base}/ failed: ${String(error)}`);
    return false;
  }
}
