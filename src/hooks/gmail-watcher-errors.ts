// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}
