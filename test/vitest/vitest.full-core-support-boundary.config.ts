// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(
  fullSuiteVitestShards.find(
    (shard) => shard.config === "test/vitest/vitest.full-core-support-boundary.config.ts",
  )?.projects ?? [],
);
