// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
let pwAiLoaded = false;

export function markPwAiLoaded(): void {
  pwAiLoaded = true;
}

export function isPwAiLoaded(): boolean {
  return pwAiLoaded;
}
