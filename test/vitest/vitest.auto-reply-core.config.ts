// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { autoReplyCoreTestExclude, autoReplyCoreTestInclude } from "./vitest.test-shards.mjs";

export function createAutoReplyCoreVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig([...autoReplyCoreTestInclude], {
    dir: "src/auto-reply",
    env,
    exclude: [...autoReplyCoreTestExclude],
    name: "auto-reply-core",
  });
}

export default createAutoReplyCoreVitestConfig();
