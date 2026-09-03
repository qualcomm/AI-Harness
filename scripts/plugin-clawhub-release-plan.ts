#!/usr/bin/env -S node --import tsx
// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT

import { pathToFileURL } from "node:url";
import {
  collectPluginClawHubReleasePlan,
  parsePluginReleaseArgs,
} from "./lib/plugin-clawhub-release.ts";

export async function collectPluginReleasePlanForClawHub(argv: string[]) {
  const { selection, selectionMode, baseRef, headRef } = parsePluginReleaseArgs(argv);
  return await collectPluginClawHubReleasePlan({
    selection,
    selectionMode,
    gitRange: baseRef && headRef ? { baseRef, headRef } : undefined,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const plan = await collectPluginReleasePlanForClawHub(process.argv.slice(2));
  console.log(JSON.stringify(plan, null, 2));
}
