// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

export { sanitizeGoogleTurnOrdering };
