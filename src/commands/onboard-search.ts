// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  applySearchKey,
  applySearchProviderSelection,
  hasExistingKey,
  hasKeyInEnv,
  listSearchProviderOptions,
  resolveExistingKey,
  resolveSearchProviderOptions,
  runSearchSetupFlow as setupSearch,
} from "../flows/search-setup.js";
export type { SearchProvider, SetupSearchOptions } from "../flows/search-setup.js";
