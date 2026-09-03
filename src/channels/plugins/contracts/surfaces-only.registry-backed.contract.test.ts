// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { getSurfaceContractRegistry } from "../../../../test/helpers/channels/surface-contract-registry.js";
import { installChannelSurfaceContractSuite } from "../../../../test/helpers/channels/surface-contract-suite.js";

for (const entry of getSurfaceContractRegistry()) {
  for (const surface of entry.surfaces) {
    describe(`${entry.id} ${surface} surface contract`, () => {
      installChannelSurfaceContractSuite({
        plugin: entry.plugin,
        surface,
      });
    });
  }
}
