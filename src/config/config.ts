// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  clearConfigCache,
  ConfigRuntimeRefreshError,
  clearRuntimeConfigSnapshot,
  registerConfigWriteListener,
  createConfigIO,
  getRuntimeConfig,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  loadConfig,
  readBestEffortConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  readSourceConfigSnapshot,
  readSourceConfigSnapshotForWrite,
  resetConfigRuntimeState,
  resolveConfigSnapshotHash,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
export type { ConfigWriteNotification } from "./io.js";
export { ConfigMutationConflictError, mutateConfigFile, replaceConfigFile } from "./mutate.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export {
  validateConfigObject,
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
