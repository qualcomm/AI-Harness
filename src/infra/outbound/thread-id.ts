// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeOptionalStringifiedId } from "../../shared/string-coerce.js";

export function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  return normalizeOptionalStringifiedId(value);
}
