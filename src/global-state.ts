// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
let globalVerbose = false;
let globalYes = false;

export function setVerbose(v: boolean) {
  globalVerbose = v;
}

export function isVerbose() {
  return globalVerbose;
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}
