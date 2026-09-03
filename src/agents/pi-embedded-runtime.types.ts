// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

export type RunEmbeddedPiAgentFn = (
  params: RunEmbeddedPiAgentParams,
) => Promise<EmbeddedPiRunResult>;

export type RunEmbeddedAgentFn = RunEmbeddedPiAgentFn;
