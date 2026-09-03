// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { EmbeddedRunTrigger } from "./params.js";

export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  memoryFlushWritePath?: string;
}): {
  trigger?: EmbeddedRunTrigger;
  memoryFlushWritePath?: string;
} {
  return {
    trigger: params.trigger,
    memoryFlushWritePath: params.memoryFlushWritePath,
  };
}
