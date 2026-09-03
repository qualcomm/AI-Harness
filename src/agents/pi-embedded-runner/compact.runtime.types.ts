// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
import type { EmbeddedPiCompactResult } from "./types.js";

export type CompactEmbeddedPiSessionDirect = (
  params: CompactEmbeddedPiSessionParams,
) => Promise<EmbeddedPiCompactResult>;
