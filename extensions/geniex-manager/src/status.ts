// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * The single status shape the Local Models UI branches on.
 *
 * Three states, three very different screens:
 * - `unsupported-platform`: hide the feature entirely (the common case, since
 *   most hosts are not Snapdragon).
 * - `cli-missing`: show install guidance.
 * - `ready`: show the real management UI.
 */
import { readGenieXCliVersion, resolveGenieXCliPath } from "./cli.js";
import { resolveGenieXInstallHint, resolveGenieXPlatformSupport } from "./platform.js";
import type { GenieXServeState } from "./serve-process.js";

export type GenieXStatus =
  | {
      state: "unsupported-platform";
      platform: string;
      reason: string;
    }
  | {
      state: "cli-missing";
      platform: string;
      install: { url: string; command?: string; note?: string };
    }
  | {
      state: "ready";
      platform: string;
      cliPath: string;
      version?: string;
      baseUrl: string;
      serve: GenieXServeState;
    };

export async function resolveGenieXStatus(params: {
  baseUrl: string;
  serve: GenieXServeState;
  env?: NodeJS.ProcessEnv;
}): Promise<GenieXStatus> {
  const platform = resolveGenieXPlatformSupport();
  if (!platform.supported) {
    return {
      state: "unsupported-platform",
      platform: platform.label,
      reason: platform.reason ?? "unsupported platform",
    };
  }

  const cliPath = resolveGenieXCliPath(params.env);
  if (!cliPath) {
    return {
      state: "cli-missing",
      platform: platform.label,
      install: resolveGenieXInstallHint(),
    };
  }

  const version = await readGenieXCliVersion(params.env ? { env: params.env } : undefined);
  return {
    state: "ready",
    platform: platform.label,
    cliPath,
    ...(version ? { version } : {}),
    baseUrl: params.baseUrl,
    serve: params.serve,
  };
}
