// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type BrowserNodeHostFacadeModule = {
  runBrowserProxyCommand(paramsJSON?: string | null): Promise<string>;
};

function loadFacadeModule(): BrowserNodeHostFacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<BrowserNodeHostFacadeModule>({
    dirName: "browser",
    artifactBasename: "runtime-api.js",
  });
}

export async function runBrowserProxyCommand(paramsJSON?: string | null): Promise<string> {
  return await loadFacadeModule().runBrowserProxyCommand(paramsJSON);
}
