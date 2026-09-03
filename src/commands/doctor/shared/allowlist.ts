// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import type { DoctorAllowFromList } from "../types.js";

export function hasAllowFromEntries(list?: DoctorAllowFromList) {
  return Array.isArray(list) && normalizeStringEntries(list).length > 0;
}
