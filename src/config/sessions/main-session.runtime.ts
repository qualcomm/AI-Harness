// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { loadConfig } from "../io.js";
import { resolveMainSessionKey } from "./main-session.js";

export function resolveMainSessionKeyFromConfig(): string {
  return resolveMainSessionKey(loadConfig());
}
