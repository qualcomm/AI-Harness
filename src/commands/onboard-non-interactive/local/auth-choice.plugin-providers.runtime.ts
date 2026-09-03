// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { resolveProviderPluginChoice } from "../../../plugins/provider-wizard.js";
import { resolveOwningPluginIdsForProvider } from "../../../plugins/providers.js";
import { resolvePluginProviders } from "../../../plugins/providers.runtime.js";

export const authChoicePluginProvidersRuntime = {
  resolveOwningPluginIdsForProvider,
  resolveProviderPluginChoice,
  resolvePluginProviders,
};
