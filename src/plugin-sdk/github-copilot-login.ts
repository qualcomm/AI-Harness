// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/github-copilot/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "github-copilot",
    artifactBasename: "api.js",
  });
}
export const githubCopilotLoginCommand: FacadeModule["githubCopilotLoginCommand"] = ((...args) =>
  loadFacadeModule()["githubCopilotLoginCommand"](
    ...args,
  )) as FacadeModule["githubCopilotLoginCommand"];
