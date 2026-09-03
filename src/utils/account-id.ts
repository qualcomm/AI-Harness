// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeOptionalAccountId } from "../routing/account-id.js";

export function normalizeAccountId(value?: string): string | undefined {
  return normalizeOptionalAccountId(value);
}
