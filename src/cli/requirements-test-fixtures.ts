// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function createEmptyRequirements() {
  return {
    bins: [],
    anyBins: [],
    env: [],
    config: [],
    os: [],
  };
}

export function createEmptyInstallChecks() {
  return {
    requirements: createEmptyRequirements(),
    missing: createEmptyRequirements(),
    configChecks: [],
    install: [],
  };
}
