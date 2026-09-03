// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { resolveCliArgvInvocation } from "./argv-invocation.js";

export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  return resolveCliArgvInvocation(argv).hasHelpOrVersion;
}
